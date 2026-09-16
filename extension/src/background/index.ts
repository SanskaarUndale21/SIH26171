import type {
  BuildContextOffscreenMessage,
  BuildContextResponse,
  ExecuteActionResponse,
  ExtensionMessage,
  GetDomSnapshotResponse,
  ShowOverlayMessage
} from "../messages";
import type { NextActionResponse, RedactionEntry } from "../types";
import { requestNextAction } from "./server";

const OFFSCREEN_URL = "offscreen.html";

// Clicking the toolbar icon opens the side panel instead of a popup -- a persistent sidebar
// that stays open while you navigate, rather than a transient window that closes the moment
// focus leaves it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
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

interface RunTaskResult {
  status: string;
  action?: NextActionResponse;
  redactionManifest?: RedactionEntry[];
}

async function runTask(taskGoal: string): Promise<RunTaskResult> {
  const tab = await getActiveTab();
  const tabId = tab.id!;

  const domResponse = (await chrome.tabs.sendMessage(tabId, { type: "GET_DOM_SNAPSHOT" })) as
    | GetDomSnapshotResponse
    | { ok: false; error: string };
  if (!domResponse.ok) {
    throw new Error("Failed to read page DOM: " + (domResponse as any).error);
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });

  await ensureOffscreenDocument();
  const buildMsg: BuildContextOffscreenMessage = {
    type: "BUILD_CONTEXT_OFFSCREEN",
    screenshotDataUrl,
    domSnapshot: domResponse.domSnapshot,
    taskGoal
  };
  const buildResponse = (await chrome.runtime.sendMessage(buildMsg)) as BuildContextResponse | { ok: false; error: string };
  if (!buildResponse.ok) {
    throw new Error("Failed to build sanitized context: " + (buildResponse as any).error);
  }

  // Draw the redaction boxes on the real page -- visible proof, not just a console log.
  const overlayMsg: ShowOverlayMessage = { type: "SHOW_OVERLAY", manifest: buildResponse.payload.redaction_manifest };
  await chrome.tabs.sendMessage(tabId, overlayMsg).catch(() => undefined);

  const action = await requestNextAction(buildResponse.payload);

  const execResponse = (await chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_ACTION",
    action: action.action,
    target: action.target,
    value: action.value
  })) as ExecuteActionResponse;

  return {
    status: execResponse.ok ? "action executed" : `action failed: ${execResponse.error ?? "unknown"}`,
    action,
    redactionManifest: buildResponse.payload.redaction_manifest
  };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "RUN_TASK") {
    runTask(message.taskGoal)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});
