"""Task bridge between the Jarvis desktop app and the browser extension.

Jarvis posts a browser task here; the extension (side panel poll, or its 30s alarm) claims it,
runs its normal on-device-redaction agent loop, and posts progress events back; Jarvis polls
those events to show live progress. In-memory only: a demo hub, not a job queue.

Nothing sensitive flows through here by construction. The goal Jarvis sends is already
redacted (placeholders only), and the extension only reports step summaries: action type,
selector, redaction types and timings, never field values. Confirmations and ask-user answers
stay in the browser on purpose, since relaying an answer through this server would defeat
the point of the answer vault.
"""
import threading
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field

PENDING_TTL_S = 120  # a task nobody claims in this long is expired, so Jarvis can say so
KEEP_FINISHED_S = 1800

TaskStatus = Literal["pending", "running", "done", "error", "cancelled", "expired"]
EventKind = Literal["step", "confirm", "ask", "done", "error"]


class TaskCreate(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)
    source: str = "jarvis"


class TaskEvent(BaseModel):
    kind: EventKind
    text: str = Field(max_length=2000)
    data: dict | None = None


class _Task:
    def __init__(self, goal: str, source: str):
        self.id = uuid.uuid4().hex[:12]
        self.goal = goal
        self.source = source
        self.status: TaskStatus = "pending"
        self.created = time.time()
        self.updated = self.created
        self.events: list[dict] = []

    def view(self, after: int = 0) -> dict:
        return {
            "id": self.id,
            "goal": self.goal,
            "source": self.source,
            "status": self.status,
            "events": self.events[after:],
            "next": len(self.events),
        }


class TaskHub:
    def __init__(self) -> None:
        self._tasks: dict[str, _Task] = {}
        self._lock = threading.Lock()

    def _sweep(self) -> None:
        now = time.time()
        for task in list(self._tasks.values()):
            if task.status == "pending" and now - task.created > PENDING_TTL_S:
                task.status = "expired"
                task.events.append({
                    "kind": "error",
                    "text": "No browser picked this up. Is the extension loaded and its side panel open?",
                    "data": None,
                    "at": now,
                })
            if task.status not in ("pending", "running") and now - task.updated > KEEP_FINISHED_S:
                del self._tasks[task.id]

    def create(self, body: TaskCreate) -> dict:
        with self._lock:
            self._sweep()
            task = _Task(body.goal.strip(), body.source)
            self._tasks[task.id] = task
            return task.view()

    def claim(self) -> dict | None:
        with self._lock:
            self._sweep()
            pending = sorted((t for t in self._tasks.values() if t.status == "pending"), key=lambda t: t.created)
            if not pending:
                return None
            task = pending[0]
            task.status = "running"
            task.updated = time.time()
            return {"id": task.id, "goal": task.goal, "source": task.source}

    def add_event(self, task_id: str, event: TaskEvent) -> dict | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            now = time.time()
            task.events.append({**event.model_dump(), "at": now})
            task.updated = now
            if event.kind == "done":
                reason = (event.data or {}).get("reason")
                task.status = "done" if reason in (None, "completed") else ("cancelled" if reason == "cancelled" else "error")
            elif event.kind == "error":
                task.status = "error"
            return task.view()

    def get(self, task_id: str, after: int = 0) -> dict | None:
        with self._lock:
            self._sweep()
            task = self._tasks.get(task_id)
            return task.view(after) if task else None


hub = TaskHub()
