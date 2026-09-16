import type { ActionTarget, ActionType, DomSnapshot, NextActionRequest, RedactionEntry } from "./types";

// Content script -> background. Deliberately the only thing the content script does besides
// executing actions and drawing the overlay: reading the DOM is cheap and safe on any page.
// The heavy perception work happens in the offscreen document instead (see
// offscreen/index.ts) because content scripts share the host page's Worker/CSP context -- a
// page with a strict Trusted Types policy (Google Docs/Forms, YouTube, ...) blocks the
// Worker/importScripts calls that onnxruntime-web and Tesseract.js need, with no workaround
// available from inside the content script itself.
export interface GetDomSnapshotMessage {
  type: "GET_DOM_SNAPSHOT";
}

export interface ExecuteActionMessage {
  type: "EXECUTE_ACTION";
  action: ActionType;
  target: ActionTarget;
  value: string | null;
}

export interface ShowOverlayMessage {
  type: "SHOW_OVERLAY";
  manifest: RedactionEntry[];
}

export interface RunTaskMessage {
  type: "RUN_TASK";
  taskGoal: string;
}

// Background -> offscreen document.
export interface BuildContextOffscreenMessage {
  type: "BUILD_CONTEXT_OFFSCREEN";
  screenshotDataUrl: string;
  domSnapshot: DomSnapshot;
  taskGoal: string;
}

export type ExtensionMessage =
  | GetDomSnapshotMessage
  | ExecuteActionMessage
  | ShowOverlayMessage
  | RunTaskMessage
  | BuildContextOffscreenMessage;

export interface GetDomSnapshotResponse {
  ok: true;
  domSnapshot: DomSnapshot;
}

export interface BuildContextResponse {
  ok: true;
  payload: NextActionRequest;
}

export interface ExecuteActionResponse {
  ok: boolean;
  error?: string;
}
