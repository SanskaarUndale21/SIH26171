import { captureDomSnapshot } from "./dom";
import { executeAction } from "./execute";
import { showRedactionOverlay, clearRedactionOverlay } from "./overlay";
import { initPill, handlePillMessage } from "./pill";
import type { ExecuteActionResponse, ExtensionMessage, GetDomSnapshotResponse } from "../messages";

// Deliberately thin: DOM reading, action execution, the visual overlay, and the floating
// pill launcher only -- no ML/perception code at all. See messages.ts for why -- heavy
// perception work runs in the offscreen document instead, because this script runs inside
// the host page's Worker/CSP context and a page with a strict Trusted Types policy blocks
// the Worker/importScripts calls the ML stack needs.
initPill();

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "GET_DOM_SNAPSHOT") {
    try {
      const domSnapshot = captureDomSnapshot();
      sendResponse({ ok: true, domSnapshot } satisfies GetDomSnapshotResponse);
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false;
  }

  if (message.type === "SHOW_OVERLAY") {
    showRedactionOverlay(message.manifest);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "EXECUTE_ACTION") {
    try {
      clearRedactionOverlay();
      const result = executeAction(message.action, message.target, message.value);
      sendResponse(result satisfies ExecuteActionResponse);
    } catch (err) {
      sendResponse({ ok: false, error: String(err) } satisfies ExecuteActionResponse);
    }
    return false;
  }

  // These three are also sent to the side panel via chrome.runtime.sendMessage broadcast;
  // background additionally targets this tab directly (chrome.tabs.sendMessage) with the
  // same payloads so the pill's compact popup can show live status without needing the side
  // panel open at all.
  if (
    message.type === "TASK_STEP" ||
    message.type === "TASK_DONE" ||
    message.type === "CONFIRM_REQUEST" ||
    message.type === "ASK_USER_REQUEST"
  ) {
    handlePillMessage(message);
    return false;
  }

  return false;
});
