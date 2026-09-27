// The agent loop: redact the user's message, ask the LLM, run any tool calls (after approval),
// feed redacted results back, repeat until the model answers in plain text or the step budget
// runs out. The LLM only ever sees placeholders; real values are restored here, locally.
const { chatCompletion } = require("./llm");
const { byName, openAiTools, execute } = require("./tools");
const { Redactor } = require("./redact");

const MAX_STEPS = 8;

const SYSTEM_PROMPT = [
  "You are Jarvis, a concise desktop assistant running on the user's computer.",
  "You can act through the provided tools. The user approves every risky action, so propose",
  "exactly what is needed, one clear step at a time, and prefer read-only commands when exploring.",
  "Private values in the conversation are replaced by placeholders like [EMAIL_1], [PHONE_2],",
  "[CARD_1], [AADHAAR_1], [PAN_1], [SECRET_1]. Never guess the real value. When a tool needs it,",
  "pass the placeholder exactly as written; it is filled in locally before the tool runs.",
  "For anything that happens inside a web page (filling a form, clicking, navigating a site in",
  "Chrome) use browser_task: it runs the privacy-preserving browser agent, which redacts the screen",
  "on-device. Use open_url only to simply open a page. When the user refers to something on their",
  "screen, use look_at_screen: the screenshot is masked on this computer before any model sees it.",
  "Answer briefly. When a task is done, say so in one or two sentences.",
].join(" ");

class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.redactor = new Redactor();
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  }
}

function redactDeep(redactor, value) {
  if (typeof value === "string") return redactor.redact(value).text;
  if (Array.isArray(value)) return value.map((v) => redactDeep(redactor, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(redactor, v)]));
  }
  return value;
}

// hooks: { cfg, emit(event), confirm(action) -> Promise<boolean>, ctx }
async function runTurn(session, userText, hooks) {
  const { emit } = hooks;
  const { text, found } = session.redactor.redact(userText);
  if (found.length) emit({ type: "redacted", where: "message", kinds: [...new Set(found)], count: found.length });
  session.messages.push({ role: "user", content: text });

  for (let step = 0; step < MAX_STEPS; step++) {
    emit({ type: "thinking" });
    const msg = await chatCompletion(hooks.cfg, session.messages, openAiTools());
    session.messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    if (!msg.tool_calls?.length) {
      emit({ type: "reply", text: session.redactor.restore(msg.content || "(no reply)") });
      return;
    }

    for (const call of msg.tool_calls) {
      const tool = byName[call.function?.name];
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        /* model sent malformed JSON; run with empty args and let the tool report it */
      }
      // Local tools get real values back; tools that send data off the machine (browser_task)
      // keep placeholders, and anything that slipped through is redacted once more.
      const realArgs =
        tool?.restoreArgs === false ? redactDeep(session.redactor, args) : session.redactor.restoreDeep(args);
      let result;
      if (!tool) {
        result = `Unknown tool ${call.function?.name}`;
      } else {
        const action = { id: call.id, name: tool.name, risk: tool.risk, args: realArgs };
        const auto = tool.risk === "low" && hooks.cfg.autoApproveLow;
        emit({ type: "action", action, auto });
        const ok = auto || (await hooks.confirm(action));
        const ctx = {
          ...hooks.ctx,
          cfg: hooks.cfg,
          hubUrl: hooks.cfg.hubUrl,
          redactor: session.redactor,
          progress: (text) => emit({ type: "action_progress", id: call.id, text }),
          image: (dataUrl) => emit({ type: "action_image", id: call.id, dataUrl }),
        };
        result = ok ? await execute(tool.name, realArgs, ctx) : "The user denied this action.";
        emit({ type: "action_result", id: call.id, ok, result });
      }
      const red = session.redactor.redact(String(result));
      if (red.found.length) emit({ type: "redacted", where: "tool output", kinds: [...new Set(red.found)], count: red.found.length });
      session.messages.push({ role: "tool", tool_call_id: call.id, content: red.text });
    }
  }
  emit({ type: "reply", text: `Stopped after ${MAX_STEPS} steps. Ask me to continue if needed.` });
}

module.exports = { Session, runTurn };
