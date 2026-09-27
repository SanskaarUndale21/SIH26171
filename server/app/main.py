import logging
import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

logger = logging.getLogger("privacy_agent")
logging.basicConfig(level=logging.INFO)

from .hub import TaskCreate, TaskEvent, hub  # noqa: E402
from .models import NextActionRequest, NextActionResponse  # noqa: E402
from .planner import get_next_action, jarvis_completion, planner_info  # noqa: E402

app = FastAPI(title="Privacy Browser Agent Server")

# The extension's background service worker calls this API from a chrome-extension:// origin,
# which the browser enforces CORS against just like any other cross-origin fetch -- without
# this, the request never reaches this server at all; it fails client-side as a generic
# "TypeError: Failed to fetch" with no further detail, which is indistinguishable from the
# server simply being down. allow_origins=["*"] is fine here: this endpoint takes no cookies
# or ambient credentials, and a fixed chrome-extension://<id> origin would break the moment
# the extension ID changes (e.g. a different developer's unpacked install).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Planner-Ms"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", **planner_info()}


@app.post("/api/next-action", response_model=NextActionResponse)
def next_action(payload: NextActionRequest, response: Response) -> NextActionResponse:
    # Logged deliberately at INFO, not just on error: the interesting bugs in this project
    # so far weren't server exceptions, they were the model choosing a real-looking-but-wrong
    # action (a hallucinated selector, a non-URL value, a <select> handled the wrong way) --
    # invisible from the HTTP status code alone. Seeing task_goal + the actual returned action
    # side by side is what made every one of those diagnosable in seconds instead of guessing.
    logger.info(
        "next-action request: goal=%r risk=%s elements=%d",
        payload.task_goal,
        payload.risk_tier,
        len(payload.structured_summary.interactive_elements),
    )
    started = time.perf_counter()
    try:
        action = get_next_action(
            sanitized_image_b64=payload.sanitized_image,
            manifest=payload.redaction_manifest,
            structured_summary=payload.structured_summary,
            task_goal=payload.task_goal,
            risk_tier=payload.risk_tier,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["X-Planner-Ms"] = f"{elapsed_ms:.0f}"
        logger.info("next-action response (%.0f ms): %s", elapsed_ms, action.model_dump_json())
        return action
    except Exception as exc:  # surfaced to the extension for debugging
        logger.exception("next-action failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# --- Jarvis desktop app <-> browser extension bridge (see hub.py) ---


@app.post("/api/tasks")
def create_task(body: TaskCreate) -> dict:
    task = hub.create(body)
    logger.info("task %s queued from %s: %r", task["id"], body.source, body.goal)
    return task


@app.get("/api/tasks/claim", response_model=None)
def claim_task() -> Response | dict:
    task = hub.claim()
    if task is None:
        return Response(status_code=204)
    logger.info("task %s claimed by extension", task["id"])
    return task


@app.post("/api/tasks/{task_id}/events")
def add_task_event(task_id: str, event: TaskEvent) -> dict:
    task = hub.add_event(task_id, event)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown task")
    return {"status": task["status"], "next": task["next"]}


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str, after: int = 0) -> dict:
    task = hub.get(task_id, after)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown task")
    return task


@app.post("/api/jarvis/chat/completions")
def jarvis_chat(body: dict) -> dict:
    try:
        return jarvis_completion(body)
    except Exception as exc:
        logger.exception("jarvis completion failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
