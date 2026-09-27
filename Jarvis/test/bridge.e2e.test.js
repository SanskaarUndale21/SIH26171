// Full-stack check of the Jarvis -> SIH server -> browser extension hand-off, with only the LLM
// and Chrome faked: a fake OpenAI-compatible model, the REAL FastAPI server (uvicorn), the real
// Jarvis agent loop, and a stand-in for the extension that claims the task and posts progress
// the way background/index.ts does. Skips if the server's venv isn't set up.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { Session, runTurn } = require("../src/agent");

const serverDir = path.join(__dirname, "..", "..", "server");
const python = path.join(serverDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const HUB_PORT = 8199;
const hub = `http://127.0.0.1:${HUB_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeModel(seen) {
  let call = 0;
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(body);
      call++;
      const message =
        call === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "t1",
                type: "function",
                function: { name: "browser_task", arguments: JSON.stringify({ goal: "Fill the scholarship form using email [EMAIL_1]" }) },
              }],
            }
          : { role: "assistant", content: "The browser agent filled the form." };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, finish_reason: "stop", message }] }));
    });
  });
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${hub}/health`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// Stand-in for the extension: claim, post two steps and a done, like relayToJarvis does.
async function fakeExtension(claimed) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${hub}/api/tasks/claim`);
    if (res.status === 200) {
      const task = await res.json();
      claimed.push(task);
      const post = (ev) =>
        fetch(`${hub}/api/tasks/${task.id}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
      await post({ kind: "step", text: "Step 1: action executed", data: { action: "type", selector: "#fullname" } });
      await post({ kind: "ask", text: "Answer in the browser (stays local): What is your email?" });
      await post({ kind: "done", text: "Done.", data: { reason: "completed" } });
      return;
    }
    await sleep(250);
  }
}

test("Jarvis hands a browser task to the extension via the real server, placeholders only", { skip: !fs.existsSync(python) && "server venv missing" }, async () => {
  const seen = [];
  const model = fakeModel(seen);
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const modelUrl = `http://127.0.0.1:${model.address().port}`;

  const server = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(HUB_PORT)], {
    cwd: serverDir,
    env: { ...process.env, PLANNER_BASE_URL: modelUrl, PLANNER_API_KEY: "x", PLANNER_MODEL: "fake-vlm", JARVIS_BASE_URL: modelUrl, JARVIS_API_KEY: "x", JARVIS_MODEL: "fake-llm" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    assert.ok(await waitForHealth(), "server did not start");
    const claimed = [];
    const extension = fakeExtension(claimed);

    const events = [];
    await runTurn(new Session(), "Fill in the scholarship form in Chrome. My email is priya.sharma@example.org", {
      cfg: { baseUrl: `${hub}/api/jarvis`, model: "server-default", apiKey: "", hubUrl: hub, autoApproveLow: false },
      emit: (e) => events.push(e),
      confirm: async () => true,
      ctx: { hideWindow() {} },
    });
    await extension;

    // The model (behind the server proxy) never saw the raw email, and the server model was used.
    for (const body of seen) assert.ok(!body.includes("priya.sharma@example.org"), "raw email reached the model");
    assert.ok(seen.every((b) => JSON.parse(b).model === "fake-llm"));

    // The browser task the extension claimed carries the placeholder, not the value.
    assert.strictEqual(claimed.length, 1);
    assert.match(claimed[0].goal, /\[EMAIL_1\]/);
    assert.ok(!claimed[0].goal.includes("priya.sharma"));

    // Jarvis streamed the extension's progress and finished.
    const progress = events.filter((e) => e.type === "action_progress").map((e) => e.text);
    assert.ok(progress.some((t) => t.startsWith("Step 1")));
    assert.ok(progress.some((t) => t.includes("stays local")));
    const result = events.find((e) => e.type === "action_result");
    assert.match(result.result, /Browser task done/);
    assert.strictEqual(events.at(-1).type, "reply");
  } finally {
    server.kill();
    model.close();
  }
});
