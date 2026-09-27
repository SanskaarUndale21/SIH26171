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
    "return action=\"ask_user\" for that field with `value` set to that exact placeholder "
    "(e.g. \"[EMAIL_1]\"), so the browser can fill it in locally.\n\n"
    "Submitting is always the LAST step: before choosing a submit/pay/confirm button, check the "
    "progress history and make sure every value the task goal names has already been filled in. "
    "If the goal asks to submit, the task is NOT done until the submit button has been clicked: "
    "do not return action=\"none\" before that. After it has been submitted, do not keep "
    "editing the form; then return action=\"none\".\n\n"
    "Respond with exactly one action.\n\n"
    "Respond with ONLY a JSON object of this exact shape, no other text:\n"
    '{"action": "click|type|scroll|navigate|open_tab|none|ask_user", '
    '"target": {"selector": string|null, "bbox": [number,number,number,number], "confidence": number}, '
    '"value": string|null, "question": string|null}'
)


# Open-weights by default, as the problem statement asks. The planner needs a VISION model (it
# reads the sanitized screenshot); Jarvis only needs text + tool calling. They can live on
# different endpoints: PLANNER_* for the planner, JARVIS_BASE_URL / JARVIS_API_KEY for Jarvis
# (falling back to the planner's). Any OpenAI-compatible endpoint works, including a local
# Ollama / vLLM / llama.cpp server.
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_PLANNER_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
# Groq retired its Llama 3 text models; gpt-oss-120b is open-weights (Apache 2.0).
DEFAULT_JARVIS_MODEL = "openai/gpt-oss-120b"


def planner_model() -> str:
    return os.environ.get("PLANNER_MODEL") or DEFAULT_PLANNER_MODEL


def _jarvis_base_url() -> str | None:
    return os.environ.get("JARVIS_BASE_URL") or _base_url()


def jarvis_model() -> str:
    return os.environ.get("JARVIS_MODEL") or (
        DEFAULT_JARVIS_MODEL if _jarvis_base_url() == DEFAULT_BASE_URL else planner_model()
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
        "jarvis_endpoint": _jarvis_base_url() or "https://api.openai.com/v1",
        "open_weights": not is_closed_model(planner_model()),
        "jarvis_open_weights": not is_closed_model(jarvis_model()),
    }


_jarvis_client: OpenAI | None = None


def _get_jarvis_client() -> OpenAI:
    """Jarvis's text/tool model. Same client as the planner unless JARVIS_BASE_URL is set."""
    global _jarvis_client
    if not os.environ.get("JARVIS_BASE_URL"):
        return _get_client()
    if _jarvis_client is None:
        api_key = os.environ.get("JARVIS_API_KEY") or os.environ.get("PLANNER_API_KEY") or "not-needed"
        _jarvis_client = OpenAI(api_key=api_key, base_url=os.environ["JARVIS_BASE_URL"])
    return _jarvis_client


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


# json_object mode (the fallback for providers without strict json_schema) doesn't enforce the
# enum, and a live run got action="select" for a dropdown. Map the common synonyms onto the
# real action set instead of failing the whole run on a validation error.
ACTION_SYNONYMS = {
    "select": "type", "choose": "type", "set": "type", "fill": "type", "input": "type", "enter": "type",
    "press": "click", "tap": "click", "submit": "click", "check": "click",
    "goto": "navigate", "go_to": "navigate", "visit": "navigate", "open": "navigate",
    "new_tab": "open_tab",
    "done": "none", "finish": "none", "finished": "none", "complete": "none", "stop": "none",
    "ask": "ask_user", "question": "ask_user",
}
VALID_ACTIONS = {"click", "type", "scroll", "navigate", "open_tab", "none", "ask_user"}


def normalize_action(value) -> str:
    name = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    name = ACTION_SYNONYMS.get(name, name)
    if name not in VALID_ACTIONS:
        # Never guess "none" here: that would report a task as finished when it isn't.
        raise ValueError(f"planner returned an unknown action {value!r}")
    return name


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

    # Live on a real site the model returned action="click" WITH a question for a field it had
    # no value for: the question is the real intent, so ask the person instead of clicking.
    name = normalize_action(parsed.get("action"))
    if parsed.get("question") and name in ("click", "type") and not parsed.get("value"):
        name = "ask_user"

    action = NextActionResponse(
        action=name,
        target=ActionTarget(**parsed["target"]),
        value=parsed.get("value"),
        verified=False,
        question=parsed.get("question"),
    )
    return enforce_redaction_safety(fix_select_click(action, structured_summary), manifest)


def fix_select_click(action: NextActionResponse, summary: StructuredSummary) -> NextActionResponse:
    """A live run clicked a <select> while passing the option it wanted as `value`: clicking
    only opens the dropdown, so nothing was chosen. That intent is action="type" (which the
    extension handles for selects), as long as the value is one of the real options."""
    if action.action != "click" or not action.value or not action.target.selector:
        return action
    element = next((e for e in summary.interactive_elements if e.selector == action.target.selector), None)
    if element is None or element.tag != "select":
        return action
    options = element.options or []
    if options and action.value not in options:
        return action
    return action.model_copy(update={"action": "type"})


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
    if has_image:
        completion = _get_client().chat.completions.create(model=planner_model(), **kwargs)
    else:
        completion = _get_jarvis_client().chat.completions.create(model=jarvis_model(), **kwargs)
    return completion.model_dump(exclude_none=True)
