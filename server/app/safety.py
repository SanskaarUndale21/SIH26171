"""Server-side enforcement that the planner never types into a redacted region.

Prompt instructions alone are not reliable here -- verified against gpt-4o-mini in this
project: given a redacted email field and a generic "fill and submit the registration form"
goal, the model returned action="type" with a fabricated placeholder value
("user@example.com") targeting the redacted field's exact bbox. That's a real risk, not a
hypothetical one: typing a hallucinated value into a field the model cannot actually see
could silently overwrite whatever real data belongs there. This module is the fail-safe
that catches it after the model call, regardless of how the prompt is worded.
"""
from .models import ActionTarget, NextActionResponse, RedactionEntry

BBox = tuple[float, float, float, float]


def _iou(a: BBox, b: BBox) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0

OVERLAP_THRESHOLD = 0.3


def targets_redacted_region(target: ActionTarget, manifest: list[RedactionEntry]) -> bool:
    if target.selector:
        # A DOM selector naming a specific element is a different, more trustworthy signal
        # than a guessed bbox -- the extension resolves it against the real page, and a
        # selector alone can't leak what value ends up typed. Only bbox-only targeting (the
        # model guessing screen coordinates) is checked here.
        return False
    if all(v == 0 for v in target.bbox):
        return False
    return any(_iou(target.bbox, entry.bbox) > OVERLAP_THRESHOLD for entry in manifest)


def enforce_redaction_safety(action: NextActionResponse, manifest: list[RedactionEntry]) -> NextActionResponse:
    if action.action != "type":
        return action
    if not targets_redacted_region(action.target, manifest):
        return action

    # Downgrade rather than pass through: focus the field (harmless) but never type a value
    # the planner invented for a region it was never allowed to see the contents of.
    return NextActionResponse(
        action="click",
        target=action.target,
        value=None,
        verified=action.verified,
    )
