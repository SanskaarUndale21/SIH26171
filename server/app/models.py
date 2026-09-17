from typing import Literal
from pydantic import BaseModel, Field

BBox = tuple[float, float, float, float]


class RedactionEntry(BaseModel):
    type: str
    bbox: BBox
    confidence: float
    method: Literal["blackbox", "token"]


class InteractiveElementSummary(BaseModel):
    selector: str
    tag: str
    label: str | None
    isSubmit: bool
    options: list[str] | None = None


class StructuredSummary(BaseModel):
    fields: int
    submit_button: str | None
    detected_via: Literal["dom", "vision"]
    interactive_elements: list[InteractiveElementSummary] = []


class NextActionRequest(BaseModel):
    task_goal: str
    sanitized_image: str = Field(description="base64 PNG, PII regions already masked")
    redaction_manifest: list[RedactionEntry]
    structured_summary: StructuredSummary
    risk_tier: Literal["routine", "high_risk"]


class ActionTarget(BaseModel):
    selector: str | None = None
    bbox: BBox = (0, 0, 0, 0)
    confidence: float = 0.0


class NextActionResponse(BaseModel):
    action: Literal["click", "type", "scroll", "navigate", "open_tab", "none", "ask_user"]
    target: ActionTarget
    value: str | None = None
    verified: bool = False
    # Only set when action="ask_user": the question to put to the person directly. The answer
    # is typed into the page by the extension itself and never sent back to this server -- this
    # field just carries what to ask, not anything about what gets filled in.
    question: str | None = None
