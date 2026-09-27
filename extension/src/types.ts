export type BBox = [number, number, number, number]; // x, y, w, h in screenshot pixel space

export type RedactionMethod = "blackbox" | "token";

export type PiiType =
  | "password_field"
  | "card_number"
  | "email"
  | "phone_number"
  | "face"
  | "person_name"
  | "aadhaar"
  | "pan"
  | "bank_account"
  | "date_of_birth"
  | "address"
  | "secret"
  | "ip_address";

export interface RedactionEntry {
  type: PiiType | string;
  bbox: BBox;
  confidence: number;
  method: RedactionMethod;
}

// A non-sensitive structural pointer to a real, clickable/fillable element -- the tag, a
// label (button text/placeholder, never a field's value), and the exact CSS selector to
// target it by. This is what actually lets the planner target real elements instead of
// guessing a plausible-looking selector that matches nothing on the page.
export interface InteractiveElementSummary {
  selector: string;
  tag: string;
  label: string | null;
  isSubmit: boolean;
  // Only present for a <select>: its options' visible text, e.g. ["Blue", "Red", "Green"].
  // Without this the planner has to guess a value purely from the screenshot -- it guessed
  // right once by luck (the option was visibly readable) but there's nothing forcing that;
  // an exact options list is what actually makes action="type" on a dropdown reliable.
  options?: string[];
}

export interface StructuredSummary {
  fields: number;
  submit_button: string | null;
  detected_via: "dom" | "vision";
  interactive_elements: InteractiveElementSummary[];
}

export type RiskTier = "routine" | "high_risk";

export interface NextActionRequest {
  task_goal: string;
  sanitized_image: string; // base64 PNG, no data: prefix
  redaction_manifest: RedactionEntry[];
  structured_summary: StructuredSummary;
  risk_tier: RiskTier;
}

export interface ActionTarget {
  selector: string | null;
  bbox: BBox;
  confidence: number;
}

export type ActionType = "click" | "type" | "scroll" | "navigate" | "open_tab" | "none" | "ask_user";

export interface NextActionResponse {
  action: ActionType;
  target: ActionTarget;
  value: string | null;
  verified: boolean;
  // Only set when action="ask_user": the question to put to the person. The extension asks it
  // directly and types the answer in itself -- the answer is never sent to the server.
  question?: string | null;
}

export interface DomFieldInfo {
  selector: string;
  tag: string;
  inputType: string | null; // e.g. "password", "email", "text"
  name: string | null;
  placeholder: string | null;
  isSubmit: boolean;
  bbox: BBox; // in viewport CSS pixel space, will be scaled to screenshot space
  options?: string[]; // <select> only: visible text of each <option>
}

export interface DomSnapshot {
  fields: DomFieldInfo[];
  devicePixelRatio: number;
}

export interface DetectedRegion {
  label: string;
  bbox: BBox;
  confidence: number;
  source: "yolo" | "florence" | "blazeface" | "ocr+regex" | "ocr+ner" | "dom";
}

// Per-step cost of one agent iteration, measured on the client. Shown live in the side panel
// and folded into a run summary, because latency and client resource use are scored metrics.
export interface DetectorTimings {
  ocrMs: number;
  facesMs: number;
  yoloMs: number;
  florenceMs: number;
  nerMs: number;
}

export interface ContextTimings {
  decodeMs: number;
  perceptionMs: number;
  fuseMs: number;
  redactMs: number;
  totalMs: number;
  detectors: DetectorTimings;
  heapMB: number | null; // JS heap of the offscreen document, where the models live
  webgpu: boolean;
}

export interface StepMetrics {
  captureMs: number; // DOM snapshot + screenshot
  context: ContextTimings; // on-device perception + redaction
  plannerMs: number; // server round trip
  serverMs: number | null; // model time reported by the server
  execMs: number;
  stepMs: number;
  payloadKB: number; // everything sent to the server this step
  redactions: number;
}

export interface RunMetrics {
  steps: number;
  totalMs: number;
  avgStepMs: number;
  avgPerceptionMs: number;
  avgPlannerMs: number;
  peakHeapMB: number | null;
  totalRedactions: number;
  sentKB: number;
}
