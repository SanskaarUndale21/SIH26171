import { captureDomSnapshot } from "./dom";
import { executeAction } from "./execute";
import { showRedactionOverlay, clearRedactionOverlay } from "./overlay";
import type { ExecuteActionResponse, ExtensionMessage, GetDomSnapshotResponse } from "../messages";

// Deliberately thin: DOM reading, action execution, and the visual overlay only -- no
// ML/perception code at all. See messages.ts for why -- heavy perception work runs in the
// offscreen document instead, because this script runs inside the host page's Worker/CSP
// context and a page with a strict Trusted Types policy blocks the Worker/importScripts
// calls the ML stack needs.
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
      const success = executeAction(message.action, message.target, message.value);
      sendResponse({ ok: success } satisfies ExecuteActionResponse);
    } catch (err) {
      sendResponse({ ok: false, error: String(err) } satisfies ExecuteActionResponse);
    }
    return false;
  }

  return false;
});
