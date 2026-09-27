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
      const realArgs = session.redactor.restoreDeep(args);
      let result;
      if (!tool) {
        result = `Unknown tool ${call.function?.name}`;
      } else {
        const action = { id: call.id, name: tool.name, risk: tool.risk, args: realArgs };
        const auto = tool.risk === "low" && hooks.cfg.autoApproveLow;
        emit({ type: "action", action, auto });
        const ok = auto || (await hooks.confirm(action));
        result = ok ? await execute(tool.name, realArgs, hooks.ctx) : "The user denied this action.";
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
