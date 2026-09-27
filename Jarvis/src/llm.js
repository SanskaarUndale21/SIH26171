// Minimal OpenAI-compatible chat-completions client. No SDK: plain fetch keeps the app small
// and lets any provider that speaks this wire format plug in via baseUrl.
async function chatCompletion(cfg, messages, tools) {
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    throw new Error("No API key set. Open Settings and add one.");
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: "auto", temperature: 0.2 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("LLM returned no message");
  return msg;
}

module.exports = { chatCompletion };
