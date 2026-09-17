import type { ActionTarget, ActionType, DomSnapshot, NextActionRequest, NextActionResponse, RedactionEntry, RiskTier } from "./types";

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

// Sidepanel -> background: start a multi-step agent run. Unlike the old single-shot RUN_TASK,
// the loop's progress streams back as separate TaskStepMessage/TaskDoneMessage broadcasts
// (see below) rather than in the initial response, since a run can take many steps.
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

// Background -> sidepanel (broadcast). One per completed step of the agent loop.
export interface TaskStepMessage {
  type: "TASK_STEP";
  runId: string;
  step: number;
  status: string;
  action?: NextActionResponse;
  redactionManifest?: RedactionEntry[];
}

// Background -> sidepanel (broadcast). Sent once when the loop stops, for any reason.
export interface TaskDoneMessage {
  type: "TASK_DONE";
  runId: string;
  reason: "completed" | "max_steps" | "error" | "cancelled";
  message: string;
}

// Background -> sidepanel (broadcast): a high_risk action (submit/payment/delete-shaped) is
// about to run and the loop is paused until the user responds. This is the one point where
// the agent does NOT act autonomously -- Atlas-style full autonomy is fine for routine
// actions, but a submit/payment click is exactly the kind of step this project's whole
// privacy/safety posture argues should not happen silently.
export interface ConfirmRequestMessage {
  type: "CONFIRM_REQUEST";
  runId: string;
  requestId: string;
  step: number;
  action: NextActionResponse;
  riskTier: RiskTier;
  // Real gap found live: the agent correctly never fills password/email/card/phone fields
  // (it can't see their values, by design) but was silently clicking Submit anyway with
  // those fields still empty -- technically "successful", but not what filling a form means.
  // The PII types still present in the redaction manifest at confirmation time, so the user
  // gets an actual chance to go fill them in before saying yes.
  unfilledSensitiveTypes: string[];
}

// Sidepanel -> background: the user's answer to a ConfirmRequestMessage.
export interface ConfirmResponseMessage {
  type: "CONFIRM_RESPONSE";
  requestId: string;
  approved: boolean;
}

// Sidepanel -> background: stop an in-progress run.
export interface CancelTaskMessage {
  type: "CANCEL_TASK";
  runId: string;
}

// Pill (content script) -> background: best-effort request to open the full side panel.
// chrome.sidePanel.open() requires a user gesture; this is sent synchronously from the
// pill's own click handler so the gesture context carries through, but whether Chrome
// honors a gesture relayed this way from a content script was not verified live.
export interface OpenSidePanelMessage {
  type: "OPEN_SIDE_PANEL";
}

export type ExtensionMessage =
  | GetDomSnapshotMessage
  | ExecuteActionMessage
  | ShowOverlayMessage
  | RunTaskMessage
  | BuildContextOffscreenMessage
  | TaskStepMessage
  | TaskDoneMessage
  | ConfirmRequestMessage
  | ConfirmResponseMessage
  | CancelTaskMessage
  | OpenSidePanelMessage;

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
