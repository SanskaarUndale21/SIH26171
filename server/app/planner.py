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
            "action": {"type": "string", "enum": ["click", "type", "scroll", "navigate", "open_tab", "none", "ask_user"]},
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
            "question": {"type": ["string", "null"]},
        },
        "required": ["action", "target", "value", "question"],
        "additionalProperties": False,
    },
    "strict": True,
}

SYSTEM_PROMPT = (
    "You are the planning module of a privacy-preserving browser agent. "
    "You receive a screenshot with all PII regions already redacted (solid black boxes), a "
    "redaction manifest describing what was masked and where, and structured_summary."
    "interactive_elements -- the exact, real CSS selector, tag, and label of every clickable/"
    "fillable element the client found on the page. This list is the ONLY source of truth for "
    "selectors: for action=\"click\" or action=\"type\", target.selector MUST be copied "
    "verbatim from one of these entries, or be null. NEVER invent, guess, or construct a "
    "selector (e.g. a plausible-looking attribute match) that does not appear character-for-"
    "character in interactive_elements -- a fabricated selector matches nothing on the real "
    "page and the action will simply fail. If the element you need isn't in the list, return "
    "target.selector: null and a bounding box guess instead, or action=\"scroll\" first to "
    "bring it into view (the list only reflects what's currently visible/attached).\n\n"
    "A <select> dropdown (tag=\"select\" in interactive_elements) is set with action=\"type\": "
    "`value` MUST be copied verbatim from that element's own `options` list (its real choices, "
    "e.g. [\"Blue\",\"Red\",\"Green\"]) -- never a value guessed from the screenshot or from "
    "another element's options. If that entry has no `options` list, don't guess a value; "
    "return action=\"click\" on it instead.\n\n"
    "Never ask for or reference the content hidden behind a redacted region -- treat redacted "
    "regions only as 'a field of this type exists here'. Never choose action=\"type\" with a "
    "bbox-only target (no selector) that falls inside a redacted region -- you cannot see what "
    "belongs there, and typing a guessed or invented value risks overwriting real data. If a "
    "redacted field needs a value, either target it by its real selector from "
    "interactive_elements or return action=\"click\" to focus it and leave the value to the "
    "user.\n\n"
    "Two actions manage tabs/navigation rather than clicking within the current page: "
    "action=\"navigate\" changes the current tab to the URL given in `value` (use for "
    "'go to <url/site>' when you should reuse the current tab); action=\"open_tab\" opens a "
    "new tab at the URL in `value` (use only when the task explicitly asks for a new tab, or "
    "the current tab must stay open). For both, `target` is not applicable -- return "
    "{\"selector\": null, \"bbox\": [0,0,0,0], \"confidence\": 1}. Only navigate/open_tab to a "
    "URL the task goal or visible page content actually names or links to -- never guess a "
    "URL that appears nowhere in the given context. `value` for these two actions MUST be "
    "an actual URL (e.g. \"https://example.com\") or a bare domain (\"example.com\"), never a "
    "description, label, or link text (e.g. \"Contact form owner\" is not a URL even if that "
    "text appears on the page) -- if you don't have a real URL, use `value: null` to open a "
    "blank tab instead of guessing one.\n\n"
    "You will often meet a fillable field where the task goal simply doesn't say what value "
    "belongs there (a name, a company, a date, a free-text reason, a dropdown choice you can't "
    "infer) -- and it is NOT redacted, so it isn't covered by the redacted-region rule above. "
    "Never invent a plausible-looking value for a field like this. Instead return "
    "action=\"ask_user\" with target.selector copied verbatim from interactive_elements (or "
    "null if you only have a bbox), and `question` set to a short, specific question naming "
    "the field (e.g. \"What should I put in the 'Company Name' field?\"). The person answers "
    "directly in their browser and the extension types it in itself -- you will never see the "
    "answer, only a note in the next step's history that the field was filled. Ask about one "
    "field at a time, and only when you actually cannot determine the value from the task goal "
    "or the visible page content.\n\n"
    "The task goal may contain placeholders such as [EMAIL_1], [PHONE_2], [AADHAAR_1] or "
    "[CARD_1]. Each stands for a private value that stays on the user's device. Never type a "
    "placeholder into a field and never guess the value behind it; when a field needs one, "
    "return action=\"ask_user\" for that field instead.\n\n"
    "Respond with exactly one action.\n\n"
    "Respond with ONLY a JSON object of this exact shape, no other text:\n"
    '{"action": "click|type|scroll|navigate|open_tab|none|ask_user", '
    '"target": {"selector": string|null, "bbox": [number,number,number,number], "confidence": number}, '
    '"value": string|null, "question": string|null}'
)


# Open-weights by default, as the problem statement asks. Llama 4 Scout is a vision model
# (reads the sanitized screenshot) served by Groq and others; any OpenAI-compatible endpoint
# works, including a self-hosted vLLM / Ollama / llama.cpp server.
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_PLANNER_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
# Jarvis only needs text + tool calling, so it can use a larger text model on the same key.
DEFAULT_JARVIS_MODEL = "llama-3.3-70b-versatile"


def planner_model() -> str:
    return os.environ.get("PLANNER_MODEL") or DEFAULT_PLANNER_MODEL


def jarvis_model() -> str:
    return os.environ.get("JARVIS_MODEL") or (
        DEFAULT_JARVIS_MODEL if _base_url() == DEFAULT_BASE_URL else planner_model()
    )


def _base_url() -> str | None:
    explicit = os.environ.get("PLANNER_BASE_URL")
    if explicit:
        return explicit
    # An explicitly configured OpenAI model with no base URL keeps talking to OpenAI, so an
    # older .env doesn't silently break; /health reports it as not open-weights.
    if is_closed_model(planner_model()):
        return None
    return DEFAULT_BASE_URL


def is_closed_model(model: str) -> bool:
    return model.startswith(("gpt-", "o1", "o3", "o4", "chatgpt", "claude", "gemini"))


def planner_info() -> dict:
    return {
        "planner_model": planner_model(),
        "jarvis_model": jarvis_model(),
        "endpoint": _base_url() or "https://api.openai.com/v1",
        "open_weights": not is_closed_model(planner_model()),
    }


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        # Deliberately provider-agnostic: any endpoint that speaks the OpenAI chat-completions
        # wire format (OpenAI itself, Groq, OpenRouter, Together, a local llama.cpp/vLLM
        # server, ...) works here just by pointing PLANNER_BASE_URL at it and PLANNER_API_KEY
        # at its key -- no new SDK dependency needed to swap providers. Falls back to
        # OPENAI_API_KEY for the key; a local server usually ignores the key entirely.
        api_key = os.environ.get("PLANNER_API_KEY") or os.environ.get("OPENAI_API_KEY") or "not-needed"
        _client = OpenAI(api_key=api_key, base_url=_base_url())
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
    model = planner_model()
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
        question=parsed.get("question"),
    )
    return enforce_redaction_safety(action, manifest)


JARVIS_FIELDS = ("messages", "tools", "tool_choice", "temperature", "max_tokens")


def jarvis_completion(body: dict) -> dict:
    """OpenAI-compatible chat-completions pass-through for the Jarvis desktop app.

    Jarvis redacts every message locally before calling this, so only placeholders arrive.
    Proxying through here means the model and key are configured once, in server/.env, for
    both halves of the project. The model is always chosen server-side.
    """
    kwargs = {k: body[k] for k in JARVIS_FIELDS if k in body}
    # A request carrying an image (Jarvis's already-masked screenshot) needs the vision model.
    has_image = any(
        isinstance(m.get("content"), list) and any(part.get("type") == "image_url" for part in m["content"])
        for m in kwargs.get("messages", [])
        if isinstance(m, dict)
    )
    model = planner_model() if has_image else jarvis_model()
    completion = _get_client().chat.completions.create(model=model, **kwargs)
    return completion.model_dump(exclude_none=True)
