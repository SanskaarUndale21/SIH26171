from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from .models import NextActionRequest, NextActionResponse  # noqa: E402
from .planner import get_next_action  # noqa: E402

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
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/next-action", response_model=NextActionResponse)
def next_action(payload: NextActionRequest) -> NextActionResponse:
    try:
        return get_next_action(
            sanitized_image_b64=payload.sanitized_image,
            manifest=payload.redaction_manifest,
            structured_summary=payload.structured_summary,
            task_goal=payload.task_goal,
            risk_tier=payload.risk_tier,
        )
    except Exception as exc:  # surfaced to the extension for debugging
        raise HTTPException(status_code=502, detail=str(exc)) from exc
