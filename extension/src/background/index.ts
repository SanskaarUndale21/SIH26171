import type {
  BuildContextOffscreenMessage,
  BuildContextResponse,
  ExecuteActionResponse,
  ExtensionMessage,
  GetDomSnapshotResponse
} from "../messages";
import type { NextActionResponse, RedactionEntry, RunMetrics, StepMetrics, StructuredSummary } from "../types";
import { claimRemoteTask, postTaskEvent, requestNextAction, type TimedAction } from "./server";
import { getVaultAnswer, saveVaultAnswer } from "../privacy/vault";
import { maskText, PLACEHOLDER_RE } from "../perception/regex";

const OFFSCREEN_URL = "offscreen.html";
const MAX_STEPS = 15;
const STEP_SETTLE_MS = 700;
const JARVIS_POLL_ALARM = "jarvis-poll";

// runId -> hub task id, for runs handed over by the Jarvis desktop app. Their progress is
// mirrored back to the server so Jarvis can show it (see relayToJarvis).
const bridgedTasks = new Map<string, string>();

// Clicking the toolbar icon opens the side panel instead of a popup -- a persistent sidebar
// that stays open while you navigate, rather than a transient window that closes the moment
// focus leaves it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

function genId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

// Broadcasts to every extension-page context (the side panel, chiefly). If nothing is
// listening right now the send just fails silently -- there's no persistent run state to
// recover, this is a live progress stream, not a queue.
function broadcast(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

// chrome.runtime.sendMessage does NOT reach content scripts (only other extension pages) --
// a content script needs chrome.tabs.sendMessage targeted at its specific tab. The pill
// (content/pill.ts) needs the same TASK_STEP/TASK_DONE/CONFIRM_REQUEST stream the side panel
// gets, so every progress broadcast during the loop goes out both ways.
function broadcastAll(tabId: number, message: ExtensionMessage): void {
  broadcast(message);
  chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
  relayToJarvis(message);
}

function typeCounts(manifest: RedactionEntry[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of manifest ?? []) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return counts;
}

// Only summaries go back to the hub: step status, action type, selector, redaction TYPES and
// timings. Never a field value, and never an ask-user answer: those are answered in the
// browser and stay there.
function relayToJarvis(message: ExtensionMessage): void {
  if (!("runId" in message)) return;
  const taskId = bridgedTasks.get(message.runId);
  if (!taskId) return;
  switch (message.type) {
    case "TASK_STEP":
      postTaskEvent(taskId, {
        kind: "step",
        text: `Step ${message.step}: ${describeStep(message.action, message.status)}`,
        data: {
          action: message.action?.action ?? null,
          selector: message.action?.target.selector ?? null,
          redacted: typeCounts(message.redactionManifest),
          stepMs: message.metrics ? Math.round(message.metrics.stepMs) : null
        }
      });
      break;
    case "CONFIRM_REQUEST":
      postTaskEvent(taskId, {
        kind: "confirm",
        text: `Waiting for your OK in the browser: ${message.action.action}${
          message.action.target.selector ? ` on ${message.action.target.selector}` : ""
        }`
      });
      break;
    case "ASK_USER_REQUEST":
      postTaskEvent(taskId, { kind: "ask", text: `Answer in the browser (stays local): ${message.question}` });
      break;
    case "TASK_DONE":
      postTaskEvent(taskId, {
        kind: "done",
        text: message.message,
        data: { reason: message.reason, metrics: message.metrics ?? null }
      });
      bridgedTasks.delete(message.runId);
      break;
  }
}

// Plain-language step text for Jarvis ("filled in #fullname"), same wording as the side panel.
function describeStep(action: NextActionResponse | undefined, status: string): string {
  if (!action || action.action === "ask_user" || /failed|error/i.test(status)) return status;
  const sel = action.target.selector ?? "";
  switch (action.action) {
    case "click":
      return `clicked ${sel}`.trim();
    case "type":
      return `filled in ${sel}`.trim();
    case "scroll":
      return "scrolled the page";
    case "navigate":
      return `went to ${action.value ?? "a page"}`;
    case "open_tab":
      return `opened a tab at ${action.value ?? "a blank page"}`;
    case "none":
      return "finished the task";
    default:
      return status;
  }
}

function summarize(steps: StepMetrics[], runStarted: number): RunMetrics {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const heaps = steps.map((s) => s.context.heapMB).filter((h): h is number => h !== null);
  return {
    steps: steps.length,
    totalMs: performance.now() - runStarted,
    avgStepMs: avg(steps.map((s) => s.stepMs)),
    avgPerceptionMs: avg(steps.map((s) => s.context.totalMs)),
    avgPlannerMs: avg(steps.map((s) => s.plannerMs)),
    peakHeapMB: heaps.length ? Math.max(...heaps) : null,
    totalRedactions: steps.reduce((a, s) => a + s.redactions, 0),
    sentKB: steps.reduce((a, s) => a + s.payloadKB, 0)
  };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

// Waits for a tab to finish loading after we navigate it or open a new one -- without this,
// the next loop iteration's DOM/screenshot observation would race the page's own load and see
// a blank/loading document instead of real content.
function waitForTabLoad(tabId: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return finish(); // tab closed/gone
      if (t?.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Found live on a real site: a click that navigates (Wikipedia search) unloads the page's
// content script, so the next message either hits a page whose script hasn't loaded yet
// ("Receiving end does not exist") or loses the click's own reply ("message port closed").
// Wait for the tab to finish loading and retry instead of failing the run.
const NAVIGATION_GAP = /Receiving end does not exist|message port closed|back\/forward cache|Could not establish connection/i;

async function sendToTab<T>(tabId: number, message: ExtensionMessage, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    } catch (err) {
      if (i >= attempts || !NAVIGATION_GAP.test(String(err))) throw err;
      await waitForTabLoad(tabId, 5000);
      await sleep(250 * (i + 1));
    }
  }
}

// An action whose page navigates away mid-reply still happened: count it as executed.
async function executeOnTab(tabId: number, message: ExtensionMessage): Promise<ExecuteActionResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as ExecuteActionResponse;
  } catch (err) {
    if (/message port closed|back\/forward cache/i.test(String(err))) {
      await waitForTabLoad(tabId, 8000);
      return { ok: true };
    }
    if (NAVIGATION_GAP.test(String(err))) {
      return sendToTab<ExecuteActionResponse>(tabId, message);
    }
    return { ok: false, error: String(err) };
  }
}

// Deliberately re-derived from the CHOSEN action, not the request-level risk_tier field.
// risk_tier (privacy/manifest.ts) is computed from the page's ambient structured summary --
// e.g. "does this page have a submit button anywhere" -- before the planner has even picked
// an action, so it flags every task on a page with a submit button (a Google Form, say) as
// high-risk regardless of what's actually being done, including something unrelated like
// "open a new tab". The confirmation gate needs to ask "is THIS step a submit/payment/
// destructive click", not "does this page contain one somewhere".
// Real bug hit live: the planner returned open_tab with value "Contact form owner" -- not a
// URL. chrome.tabs.create({url: "Contact form owner"}) doesn't reject that; Chrome silently
// resolves it as a path relative to THIS extension's own origin
// (chrome-extension://<id>/Contact%20form%20owner), which obviously doesn't exist
// (ERR_FILE_NOT_FOUND) -- and since that's an extension page, not a normal site, our own
// content script never gets injected into it either, so the *next* step then fails with
// "Could not establish connection" too. One bad value, two confusing symptoms. Validate
// before ever handing a value to chrome.tabs.create/update instead of trusting it blindly.
function resolveNavigationUrl(raw: string | null): { url: string | undefined } | { error: string } {
  if (!raw || !raw.trim()) return { url: undefined }; // open_tab with no value -> blank new tab
  const trimmed = raw.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // Already has a scheme (http://, https://, chrome://, ...) -- trust it as-is.
    return { url: trimmed };
  }
  // A bare domain-shaped string ("example.com", "www.foo.org/path") is a reasonable thing
  // for a model to return without a scheme -- assume https. Anything else (spaces, no dot,
  // "Contact form owner") is not a URL at all and must not be passed to chrome.tabs.
  if (/^[\w-]+(\.[a-z]{2,})+([/?#].*)?$/i.test(trimmed)) {
    return { url: `https://${trimmed}` };
  }
  return { error: `not a valid URL: "${raw}"` };
}

function isHighRiskAction(action: NextActionResponse): boolean {
  if (action.action !== "click") return false;
  const haystack = (action.target.selector ?? "").toLowerCase();
  return /submit|pay|payment|delete|confirm|purchase|checkout|transfer/.test(haystack);
}

// Real gap found live: a run correctly never types into password/email/card/phone fields
// (it can't see their values), but was then clicking Submit anyway with those fields still
// empty and calling the task done -- no error, but not what "fill the form" means either.
// This doesn't try to track which fields got manually filled in the meantime (the extension
// has no visibility into that without re-reading the DOM, which would need another full
// perception pass); it just surfaces what's STILL redacted right now, at the moment of
// deciding whether to submit, so the confirmation prompt gives the user an honest, specific
// reason to go check before saying yes.
function unfilledSensitiveTypes(manifest: RedactionEntry[]): string[] {
  const piiTypes = new Set(["password_field", "card_number", "email", "phone_number"]);
  return [...new Set(manifest.map((entry) => entry.type).filter((type) => piiTypes.has(type)))];
}

// The vault (privacy/vault.ts) keys saved answers by the field's real label ("Company Name"),
// not by the question text the planner happened to phrase -- interactive_elements is the same
// list the planner uses to get real selectors, so this is just looking the same element back
// up by the selector the planner already gave us.
function labelForSelector(selector: string | null, summary: StructuredSummary): string | null {
  if (!selector) return null;
  return summary.interactive_elements.find((el) => el.selector === selector)?.label ?? null;
}

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Run on-device ML perception (ONNX/WASM workers) outside the host page's CSP"
  });
}

const cancelledRuns = new Set<string>();
const pendingConfirms = new Map<string, (approved: boolean) => void>();
const pendingAskUser = new Map<string, (answer: string | null) => void>();

// The actual agent loop: observe (DOM + screenshot) -> redact+plan -> act -> observe again,
// until the planner says "none" (done), a step budget is hit, an action fails, or the user
// cancels. This is what makes it an agent rather than a single-shot "click one thing" tool --
// each step's outcome is folded into the next step's prompt as a short history, so the
// planner knows what it already tried.
// If a placeholder the planner hands back came from the task the person typed, the real value
// is right here: fill it locally. Null when any placeholder isn't ours (e.g. a Jarvis task).
function restoreFromTask(value: string | null, values: Map<string, string>): string | null {
  if (!value) return null;
  const tokens = value.match(PLACEHOLDER_RE);
  if (!tokens || !tokens.every((t) => values.has(t))) return null;
  return value.replace(PLACEHOLDER_RE, (t) => values.get(t) ?? t);
}

async function runAgentLoop(runId: string, rawGoal: string): Promise<void> {
  // Private values typed into the task (an email, a phone number) never reach the planner:
  // it gets [EMAIL_1] and the real value stays in this function.
  const { masked: taskGoal, values: taskValues } = maskText(rawGoal);
  const tab = await getActiveTab();
  let tabId = tab.id!;
  const historyLines: string[] = [];
  const runStarted = performance.now();
  const stepMetrics: StepMetrics[] = [];
  const done = (reason: "completed" | "max_steps" | "error" | "cancelled", message: string) =>
    broadcastAll(tabId, { type: "TASK_DONE", runId, reason, message, metrics: summarize(stepMetrics, runStarted) });

  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepStart = performance.now();
    if (cancelledRuns.has(runId)) {
      cancelledRuns.delete(runId);
      done("cancelled", "Stopped by user.");
      return;
    }

    await waitForTabLoad(tabId, 8000);
    const domResponse = (await sendToTab(tabId, { type: "GET_DOM_SNAPSHOT" })) as
      | GetDomSnapshotResponse
      | { ok: false; error: string };
    if (!domResponse.ok) {
      done("error", "Failed to read page DOM: " + domResponse.error);
      return;
    }

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const captureMs = performance.now() - stepStart;
    await ensureOffscreenDocument();

    // The data contract's task_goal is a single string, so step history rides along inside
    // it rather than as a new field -- the planner already reads task_goal as free text.
    const goalWithHistory = historyLines.length
      ? `${taskGoal}\n\nProgress so far:\n${historyLines.join("\n")}`
      : taskGoal;

    const buildMsg: BuildContextOffscreenMessage = {
      type: "BUILD_CONTEXT_OFFSCREEN",
      screenshotDataUrl,
      domSnapshot: domResponse.domSnapshot,
      taskGoal: goalWithHistory
    };
    const buildResponse = (await chrome.runtime.sendMessage(buildMsg)) as BuildContextResponse | { ok: false; error: string };
    if (!buildResponse.ok) {
      done("error", "Failed to build sanitized context: " + buildResponse.error);
      return;
    }

    await chrome.tabs
      .sendMessage(tabId, { type: "SHOW_OVERLAY", manifest: buildResponse.payload.redaction_manifest })
      .catch(() => undefined);

    let planned: TimedAction;
    try {
      planned = await requestNextAction(buildResponse.payload);
    } catch (err) {
      done("error", "Planner request failed: " + String(err));
      return;
    }
    const action: NextActionResponse = planned.action;

    // Agent time only: human think-time on a confirm/ask prompt is excluded from stepMs.
    const payloadKB = JSON.stringify(buildResponse.payload).length / 1024;
    const stepMetric = (execMs: number): StepMetrics => {
      const m: StepMetrics = {
        captureMs,
        context: buildResponse.timings,
        plannerMs: planned.roundTripMs,
        serverMs: planned.serverMs,
        execMs,
        stepMs: captureMs + buildResponse.timings.totalMs + planned.roundTripMs + execMs,
        payloadKB,
        redactions: buildResponse.payload.redaction_manifest.length
      };
      stepMetrics.push(m);
      return m;
    };

    if (action.action === "none") {
      broadcastAll(tabId, {
        type: "TASK_STEP",
        runId,
        step,
        status: "Task complete.",
        action,
        redactionManifest: buildResponse.payload.redaction_manifest,
        metrics: stepMetric(0)
      });
      done("completed", "Done.");
      return;
    }

    // A field the planner has no value for (not redacted -- just genuinely unknown, e.g. a
    // name or a free-text reason) is never guessed. Instead the person is asked directly, and
    // the answer is used to fill the field HERE, client-side, via the normal EXECUTE_ACTION
    // path -- it never goes back to the server. Only a generic status ("filled" / "skipped")
    // is folded into history, so the planner can move on without ever learning the value.
    if (action.action === "ask_user") {
      const question = action.question?.trim() || "What value should I use here?";
      const fieldLabel = labelForSelector(action.target.selector, buildResponse.payload.structured_summary);

      // Answered this exact field before (by label, on any page)? Fill it straight away
      // instead of asking again -- still entirely local, still never sent to the planner.
      const fromTask = restoreFromTask(action.value, taskValues);
      const savedAnswer = fromTask ?? (fieldLabel ? await getVaultAnswer(fieldLabel) : null);
      if (savedAnswer) {
        const execStart = performance.now();
        const execResponse = (await executeOnTab(tabId, {
          type: "EXECUTE_ACTION",
          action: "type",
          target: action.target,
          value: savedAnswer
        })) as ExecuteActionResponse;
        const where = fromTask ? "a value from your task" : "a saved answer";
        const stepStatus = execResponse.ok
          ? `filled "${fieldLabel ?? action.target.selector ?? "the field"}" with ${where} (value not shared with the planner)`
          : `tried to fill "${fieldLabel ?? "the field"}" with ${where} but failed: ${execResponse.error ?? "unknown"}`;
        const execMs = performance.now() - execStart;
        historyLines.push(`step ${step}: ask_user ("${question}") -> ${stepStatus}`);
        broadcastAll(tabId, {
          type: "TASK_STEP",
          runId,
          step,
          status: stepStatus,
          action,
          redactionManifest: buildResponse.payload.redaction_manifest,
          metrics: stepMetric(execMs)
        });
        await new Promise((resolve) => setTimeout(resolve, STEP_SETTLE_MS));
        continue;
      }

      const requestId = genId();
      const answer = await new Promise<string | null>((resolve) => {
        pendingAskUser.set(requestId, resolve);
        broadcastAll(tabId, { type: "ASK_USER_REQUEST", runId, requestId, step, question });
      });
      pendingAskUser.delete(requestId);

      let stepStatus: string;
      const execStart = performance.now();
      if (answer && answer.trim()) {
        const execResponse = (await executeOnTab(tabId, {
          type: "EXECUTE_ACTION",
          action: "type",
          target: action.target,
          value: answer
        })) as ExecuteActionResponse;
        if (execResponse.ok && fieldLabel) {
          await saveVaultAnswer(fieldLabel, answer.trim());
        }
        stepStatus = execResponse.ok
          ? fieldLabel
            ? "asked the user and filled the field with their answer (saved locally for next time; value not shared with the planner)"
            : "asked the user and filled the field with their answer (value not shared with the planner)"
          : `asked the user but failed to fill the field: ${execResponse.error ?? "unknown"}`;
      } else {
        stepStatus = "asked the user; they chose not to answer, field left as-is";
      }

      const execMs = performance.now() - execStart;
      historyLines.push(`step ${step}: ask_user ("${question}") -> ${stepStatus}`);
      broadcastAll(tabId, {
        type: "TASK_STEP",
        runId,
        step,
        status: stepStatus,
        action,
        redactionManifest: buildResponse.payload.redaction_manifest,
        metrics: stepMetric(execMs)
      });
      await new Promise((resolve) => setTimeout(resolve, STEP_SETTLE_MS));
      continue;
    }

    // The one point where the loop is not fully autonomous: a submit/payment/delete-shaped
    // action pauses for the user's explicit go-ahead instead of firing immediately. Routine
    // actions (typing into a field, scrolling, clicking a non-destructive control) proceed
    // without asking.
    if (isHighRiskAction(action)) {
      const requestId = genId();
      const approved = await new Promise<boolean>((resolve) => {
        pendingConfirms.set(requestId, resolve);
        broadcastAll(tabId, {
          type: "CONFIRM_REQUEST",
          runId,
          requestId,
          step,
          action,
          riskTier: "high_risk",
          unfilledSensitiveTypes: unfilledSensitiveTypes(buildResponse.payload.redaction_manifest)
        });
      });
      pendingConfirms.delete(requestId);
      if (!approved) {
        done("cancelled", "Stopped before a high-risk action (not confirmed).");
        return;
      }
    }

    // navigate/open_tab are handled here directly via chrome.tabs rather than routed to the
    // content script -- a content script has no way to open a new browser tab, and updating
    // the tab's own location.href from inside it races the extension's own navigation intent.
    let execOk = true;
    let execError: string | undefined;
    const execStart = performance.now();

    if (action.action === "open_tab") {
      const resolved = resolveNavigationUrl(action.value);
      if ("error" in resolved) {
        execOk = false;
        execError = resolved.error;
      } else {
        try {
          const newTab = await chrome.tabs.create({ url: resolved.url });
          if (!newTab.id) throw new Error("new tab has no id");
          tabId = newTab.id;
          await waitForTabLoad(tabId);
        } catch (err) {
          execOk = false;
          execError = String(err);
        }
      }
    } else if (action.action === "navigate") {
      const resolved = resolveNavigationUrl(action.value);
      if ("error" in resolved || !resolved.url) {
        execOk = false;
        execError = "error" in resolved ? resolved.error : "navigate requires a URL";
      } else {
        try {
          await chrome.tabs.update(tabId, { url: resolved.url });
          await waitForTabLoad(tabId);
        } catch (err) {
          execOk = false;
          execError = String(err);
        }
      }
    } else {
      const execResponse = (await executeOnTab(tabId, {
        type: "EXECUTE_ACTION",
        action: action.action,
        target: action.target,
        value: action.value
      })) as ExecuteActionResponse;
      execOk = execResponse.ok;
      execError = execResponse.error;
    }

    const execMs = performance.now() - execStart;
    const stepStatus = execOk ? "action executed" : `action failed: ${execError ?? "unknown"}`;
    historyLines.push(
      `step ${step}: ${action.action}${action.target.selector ? ` on ${action.target.selector}` : ""} -> ${stepStatus}`
    );

    broadcastAll(tabId, {
      type: "TASK_STEP",
      runId,
      step,
      status: stepStatus,
      action,
      redactionManifest: buildResponse.payload.redaction_manifest,
      metrics: stepMetric(execMs)
    });

    if (!execOk) {
      // A failed action (stale selector, element gone after a re-render, ...) could in
      // principle be retried, but retrying blindly risks looping on a broken step forever --
      // stop and let the user look, rather than guess.
      done("error", "Stopped after a failed action.");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, STEP_SETTLE_MS));
  }

  done("max_steps", `Stopped after ${MAX_STEPS} steps without finishing.`);
}

// Both the side panel and the pill can trigger RUN_TASK, and both are always available at
// once -- without this, clicking "run" in both surfaces at the same time would start two
// loops fighting over the same tab's DOM/screenshot/redaction state.
let currentRunId: string | null = null;

function startRun(taskGoal: string, source: "sidepanel" | "jarvis", taskId?: string): string {
  const runId = genId();
  currentRunId = runId;
  if (taskId) bridgedTasks.set(runId, taskId);
  broadcast({ type: "TASK_STARTED", runId, taskGoal, source });
  runAgentLoop(runId, taskGoal)
    .catch((err) => {
      const message: ExtensionMessage = { type: "TASK_DONE", runId, reason: "error", message: String(err) };
      broadcast(message);
      relayToJarvis(message);
    })
    .finally(() => {
      if (currentRunId === runId) currentRunId = null;
    });
  return runId;
}

// Picks up a browser task the Jarvis desktop app queued on the server. Called by the side
// panel every ~1.5s while it's open, and by a 30s alarm otherwise (MV3's minimum period).
async function pollRemoteTask(): Promise<{ runId: string; taskGoal: string } | null> {
  if (currentRunId) return null;
  const task = await claimRemoteTask();
  if (!task) return null;
  if (currentRunId) {
    postTaskEvent(task.id, { kind: "error", text: "The browser agent is busy with another task." });
    return null;
  }
  return { runId: startRun(task.goal, "jarvis", task.id), taskGoal: task.goal };
}

chrome.alarms.create(JARVIS_POLL_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JARVIS_POLL_ALARM) void pollRemoteTask();
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === "RUN_TASK") {
    if (currentRunId) {
      sendResponse({ ok: false, error: "A task is already running -- wait for it to finish or stop it first." });
      return false;
    }
    sendResponse({ ok: true, runId: startRun(message.taskGoal, "sidepanel") });
    return false;
  }

  if (message.type === "POLL_REMOTE_TASK") {
    pollRemoteTask()
      .then((started) => sendResponse({ ok: true, started }))
      .catch(() => sendResponse({ ok: false, started: null }));
    return true;
  }

  if (message.type === "CONFIRM_RESPONSE") {
    const resolve = pendingConfirms.get(message.requestId);
    resolve?.(message.approved);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "ASK_USER_RESPONSE") {
    const resolve = pendingAskUser.get(message.requestId);
    resolve?.(message.answer);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "CANCEL_TASK") {
    cancelledRuns.add(message.runId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) {
      chrome.sidePanel.open({ windowId }).catch(() => undefined);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
