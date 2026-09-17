import json
import os

from openai import OpenAI

from .models import ActionTarget, NextActionResponse, RedactionEntry, StructuredSummary
from .safety import enforce_redaction_safety

_client: OpenAI | None = None

RESPONSE_SCHEMA = {
    "name": "next_action",
    "schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["click", "type", "scroll", "navigate", "open_tab", "none"]},
            "target": {
                "type": "object",
                "properties": {
                    "selector": {"type": ["string", "null"]},
                    "bbox": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 4,
                        "maxItems": 4,
                    },
                    "confidence": {"type": "number"},
                },
                "required": ["selector", "bbox", "confidence"],
                "additionalProperties": False,
            },
            "value": {"type": ["string", "null"]},
        },
        "required": ["action", "target", "value"],
        "additionalProperties": False,
    },
    "strict": True,
}

SYSTEM_PROMPT = (
    "You are the planning module of a privacy-preserving browser agent. "
    "You receive a screenshot with all PII regions already redacted (solid black boxes) "
    "and a redaction manifest describing what was masked and where. Decide the single next "
    "browser action needed to make progress on the task goal. Prefer using DOM-derived "
    "selectors when the manifest or structured summary implies one is known; otherwise return "
    "a bounding box in the screenshot's pixel coordinates. Never ask for or reference the "
    "content hidden behind a redacted region -- treat redacted regions only as 'a field of "
    "this type exists here'. Never choose action=\"type\" with a bbox target that falls "
    "inside a redacted region -- you cannot see what belongs there, and typing a guessed or "
    "invented value risks overwriting real data. If a redacted field needs a value, either "
    "target it by DOM selector (never invent one) or return action=\"click\" to focus it "
    "and leave the value to the user.\n\n"
    "Two actions manage tabs/navigation rather than clicking within the current page: "
    "action=\"navigate\" changes the current tab to the URL given in `value` (use for "
    "'go to <url/site>' when you should reuse the current tab); action=\"open_tab\" opens a "
    "new tab at the URL in `value` (use only when the task explicitly asks for a new tab, or "
    "the current tab must stay open). For both, `target` is not applicable -- return "
    "{\"selector\": null, \"bbox\": [0,0,0,0], \"confidence\": 1}. Only navigate/open_tab to a "
    "URL the task goal or visible page content actually names or links to -- never guess a "
    "URL that appears nowhere in the given context.\n\n"
    "Respond with exactly one action.\n\n"
    "Respond with ONLY a JSON object of this exact shape, no other text:\n"
    '{"action": "click|type|scroll|navigate|open_tab|none", '
    '"target": {"selector": string|null, "bbox": [number,number,number,number], "confidence": number}, '
    '"value": string|null}'
)


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        # Deliberately provider-agnostic: any endpoint that speaks the OpenAI chat-completions
        # wire format (OpenAI itself, Groq, OpenRouter, Together, a local llama.cpp/vLLM
        # server, ...) works here just by pointing PLANNER_BASE_URL at it and PLANNER_API_KEY
        # at its key -- no new SDK dependency needed to swap providers. Falls back to
        # OPENAI_API_KEY / the real OpenAI API when neither is set.
        api_key = os.environ.get("PLANNER_API_KEY") or os.environ.get("OPENAI_API_KEY")
        base_url = os.environ.get("PLANNER_BASE_URL") or None
        _client = OpenAI(api_key=api_key, base_url=base_url)
    return _client


def _build_user_content(
    sanitized_image_b64: str,
    manifest: list[RedactionEntry],
    structured_summary: StructuredSummary,
    task_goal: str,
    risk_tier: str,
) -> list[dict]:
    manifest_json = json.dumps([m.model_dump() for m in manifest])
    summary_json = json.dumps(structured_summary.model_dump())
    text = (
        f"Task goal: {task_goal}\n"
        f"Risk tier: {risk_tier}\n"
        f"Redaction manifest: {manifest_json}\n"
        f"Structured summary: {summary_json}\n"
        "Return the next action as JSON matching the provided schema."
    )
    return [
        {"type": "text", "text": text},
        {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{sanitized_image_b64}"},
        },
    ]


def get_next_action(
    sanitized_image_b64: str,
    manifest: list[RedactionEntry],
    structured_summary: StructuredSummary,
    task_goal: str,
    risk_tier: str,
) -> NextActionResponse:
    """Single swappable interface for the backend planning model.

    Swap the model backend later (e.g. a self-hosted vision-language model) by
    reimplementing this function's body without touching main.py or the rest
    of the server.
    """
    client = _get_client()
    model = os.environ.get("PLANNER_MODEL", "gpt-4o-mini")
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _build_user_content(
                sanitized_image_b64, manifest, structured_summary, task_goal, risk_tier
            ),
        },
    ]

    try:
        completion = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_schema", "json_schema": RESPONSE_SCHEMA},
        )
    except Exception:
        # Not every OpenAI-compatible provider supports strict json_schema response_format
        # (Groq and others reject the parameter outright). Fall back to plain json_object
        # mode -- the schema is already spelled out in the system prompt's instructions, so
        # the model still has what it needs to produce the right shape.
        completion = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
        )

    raw = completion.choices[0].message.content
    parsed = json.loads(raw)

    action = NextActionResponse(
        action=parsed["action"],
        target=ActionTarget(**parsed["target"]),
        value=parsed.get("value"),
        verified=False,
    )
    return enforce_redaction_safety(action, manifest)
