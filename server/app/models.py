from typing import Literal
from pydantic import BaseModel, Field

BBox = tuple[float, float, float, float]


class RedactionEntry(BaseModel):
    type: str
    bbox: BBox
    confidence: float
    method: Literal["blackbox", "token"]


class StructuredSummary(BaseModel):
    fields: int
    submit_button: str | None
    detected_via: Literal["dom", "vision"]


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
    action: Literal["click", "type", "scroll", "navigate", "open_tab", "none"]
    target: ActionTarget
    value: str | None = None
    verified: bool = False
