import type {
  BuildContextOffscreenMessage,
  BuildContextResponse,
  ExecuteActionResponse,
  ExtensionMessage,
  GetDomSnapshotResponse
} from "../messages";
import type { NextActionResponse } from "../types";
import { requestNextAction } from "./server";

const OFFSCREEN_URL = "offscreen.html";
const MAX_STEPS = 15;
const STEP_SETTLE_MS = 700;

// Clicking the toolbar icon opens the side panel instead of a popup -- a persistent sidebar
// that stays open while you navigate, rather than a transient window that closes the moment
// focus leaves it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

function genId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

// Broadcasts to every extension context (the side panel, chiefly). If nothing is listening
// right now the send just fails silently -- there's no persistent run state to recover, this
// is a live progress stream, not a queue.
function broadcast(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
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

// Deliberately re-derived from the CHOSEN action, not the request-level risk_tier field.
// risk_tier (privacy/manifest.ts) is computed from the page's ambient structured summary --
// e.g. "does this page have a submit button anywhere" -- before the planner has even picked
// an action, so it flags every task on a page with a submit button (a Google Form, say) as
// high-risk regardless of what's actually being done, including something unrelated like
// "open a new tab". The confirmation gate needs to ask "is THIS step a submit/payment/
// destructive click", not "does this page contain one somewhere".
function isHighRiskAction(action: NextActionResponse): boolean {
  if (action.action !== "click") return false;
  const haystack = (action.target.selector ?? "").toLowerCase();
  return /submit|pay|payment|delete|confirm|purchase|checkout|transfer/.test(haystack);
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

// The actual agent loop: observe (DOM + screenshot) -> redact+plan -> act -> observe again,
// until the planner says "none" (done), a step budget is hit, an action fails, or the user
// cancels. This is what makes it an agent rather than a single-shot "click one thing" tool --
// each step's outcome is folded into the next step's prompt as a short history, so the
// planner knows what it already tried.
async function runAgentLoop(runId: string, taskGoal: string): Promise<void> {
  const tab = await getActiveTab();
  let tabId = tab.id!;
  const historyLines: string[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (cancelledRuns.has(runId)) {
      cancelledRuns.delete(runId);
      broadcast({ type: "TASK_DONE", runId, reason: "cancelled", message: "Stopped by user." });
      return;
    }

    const domResponse = (await chrome.tabs.sendMessage(tabId, { type: "GET_DOM_SNAPSHOT" })) as
      | GetDomSnapshotResponse
      | { ok: false; error: string };
    if (!domResponse.ok) {
      broadcast({ type: "TASK_DONE", runId, reason: "error", message: "Failed to read page DOM: " + domResponse.error });
      return;
    }

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
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
      broadcast({ type: "TASK_DONE", runId, reason: "error", message: "Failed to build sanitized context: " + buildResponse.error });
      return;
    }

    await chrome.tabs
      .sendMessage(tabId, { type: "SHOW_OVERLAY", manifest: buildResponse.payload.redaction_manifest })
      .catch(() => undefined);

    let action: NextActionResponse;
    try {
      action = await requestNextAction(buildResponse.payload);
    } catch (err) {
      broadcast({ type: "TASK_DONE", runId, reason: "error", message: "Planner request failed: " + String(err) });
      return;
    }

    if (action.action === "none") {
      broadcast({
        type: "TASK_STEP",
        runId,
        step,
        status: "Task complete.",
        action,
        redactionManifest: buildResponse.payload.redaction_manifest
      });
      broadcast({ type: "TASK_DONE", runId, reason: "completed", message: "Done." });
      return;
    }

    // The one point where the loop is not fully autonomous: a submit/payment/delete-shaped
    // action pauses for the user's explicit go-ahead instead of firing immediately. Routine
    // actions (typing into a field, scrolling, clicking a non-destructive control) proceed
    // without asking.
    if (isHighRiskAction(action)) {
      const requestId = genId();
      const approved = await new Promise<boolean>((resolve) => {
        pendingConfirms.set(requestId, resolve);
        broadcast({ type: "CONFIRM_REQUEST", runId, requestId, step, action, riskTier: "high_risk" });
      });
      pendingConfirms.delete(requestId);
      if (!approved) {
        broadcast({ type: "TASK_DONE", runId, reason: "cancelled", message: "Stopped before a high-risk action (not confirmed)." });
        return;
      }
    }

    // navigate/open_tab are handled here directly via chrome.tabs rather than routed to the
    // content script -- a content script has no way to open a new browser tab, and updating
    // the tab's own location.href from inside it races the extension's own navigation intent.
    let execOk = true;
    let execError: string | undefined;

    if (action.action === "open_tab") {
      try {
        const newTab = await chrome.tabs.create({ url: action.value || undefined });
        if (!newTab.id) throw new Error("new tab has no id");
        tabId = newTab.id;
        await waitForTabLoad(tabId);
      } catch (err) {
        execOk = false;
        execError = String(err);
      }
    } else if (action.action === "navigate") {
      try {
        await chrome.tabs.update(tabId, { url: action.value ?? undefined });
        await waitForTabLoad(tabId);
      } catch (err) {
        execOk = false;
        execError = String(err);
      }
    } else {
      const execResponse = (await chrome.tabs.sendMessage(tabId, {
        type: "EXECUTE_ACTION",
        action: action.action,
        target: action.target,
        value: action.value
      })) as ExecuteActionResponse;
      execOk = execResponse.ok;
      execError = execResponse.error;
    }

    const stepStatus = execOk ? "action executed" : `action failed: ${execError ?? "unknown"}`;
    historyLines.push(
      `step ${step}: ${action.action}${action.target.selector ? ` on ${action.target.selector}` : ""} -> ${stepStatus}`
    );

    broadcast({
      type: "TASK_STEP",
      runId,
      step,
      status: stepStatus,
      action,
      redactionManifest: buildResponse.payload.redaction_manifest
    });

    if (!execOk) {
      // A failed action (stale selector, element gone after a re-render, ...) could in
      // principle be retried, but retrying blindly risks looping on a broken step forever --
      // stop and let the user look, rather than guess.
      broadcast({ type: "TASK_DONE", runId, reason: "error", message: "Stopped after a failed action." });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, STEP_SETTLE_MS));
  }

  broadcast({ type: "TASK_DONE", runId, reason: "max_steps", message: `Stopped after ${MAX_STEPS} steps without finishing.` });
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "RUN_TASK") {
    const runId = genId();
    sendResponse({ ok: true, runId });
    runAgentLoop(runId, message.taskGoal).catch((err) =>
      broadcast({ type: "TASK_DONE", runId, reason: "error", message: String(err) })
    );
    return true;
  }

  if (message.type === "CONFIRM_RESPONSE") {
    const resolve = pendingConfirms.get(message.requestId);
    resolve?.(message.approved);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "CANCEL_TASK") {
    cancelledRuns.add(message.runId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
