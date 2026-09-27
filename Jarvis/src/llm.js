// Minimal OpenAI-compatible chat-completions client. No SDK: plain fetch keeps the app small
// and lets any provider that speaks this wire format plug in via baseUrl. By default that's the
// SIH server's /api/jarvis proxy, which picks the model and holds the key.
const LOCAL = /localhost|127\.0\.0\.1/;

function post(cfg, messages, tools) {
  return fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000),
  });
}

async function chatCompletion(cfg, messages, tools) {
  if (!cfg.apiKey && !LOCAL.test(cfg.baseUrl)) {
    throw new Error("No API key set. Open Settings and add one.");
  }
  let res;
  try {
    res = await post(cfg, messages, tools);
  } catch (err) {
    if (LOCAL.test(cfg.baseUrl) && /fetch failed|ECONNREFUSED/i.test(String(err.cause || err))) {
      throw new Error("Can't reach the SIH server on localhost:8100. Start it with: node scripts/dev.mjs demo");
    }
    throw err;
  }
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
