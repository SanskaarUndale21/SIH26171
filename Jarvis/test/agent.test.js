// End-to-end agent loop against a fake OpenAI-compatible server: checks the model only ever
// sees placeholders, while the tool itself runs with the real value restored locally.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Session, runTurn } = require("../src/agent");

test("model sees placeholders, tool gets real value, output re-redacted", async () => {
  const seen = [];
  let call = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const payload = JSON.parse(body);
      seen.push(JSON.stringify(payload.messages));
      call++;
      const message =
        call === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "c1",
                type: "function",
                function: { name: "run_command", arguments: JSON.stringify({ command: "echo [EMAIL_1]" }) },
              }],
            }
          : { role: "assistant", content: "Done, echoed [EMAIL_1]." };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const events = [];
  const session = new Session();
  await runTurn(session, "echo my email priya@example.org", {
    cfg: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "", model: "fake", autoApproveLow: false },
    emit: (e) => events.push(e),
    confirm: async () => true,
    ctx: { hideWindow() {} },
  });
  server.close();

  for (const s of seen) assert.ok(!s.includes("priya@example.org"), "raw email reached the model");
  assert.ok(seen[0].includes("[EMAIL_1]"));

  const result = events.find((e) => e.type === "action_result");
  assert.ok(result.ok);
  assert.match(result.result, /priya@example\.org/, "tool should run with the real value");

  const reply = events.find((e) => e.type === "reply");
  assert.strictEqual(reply.text, "Done, echoed priya@example.org.");
  assert.ok(events.some((e) => e.type === "redacted" && e.where === "tool output"));
});
