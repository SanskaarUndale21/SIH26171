export type BBox = [number, number, number, number]; // x, y, w, h in screenshot pixel space

export type RedactionMethod = "blackbox" | "token";

export type PiiType =
  | "password_field"
  | "card_number"
  | "email"
  | "phone_number"
  | "face"
  | "person_name";

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

export type ActionType = "click" | "type" | "scroll" | "navigate" | "open_tab" | "none";

export interface NextActionResponse {
  action: ActionType;
  target: ActionTarget;
  value: string | null;
  verified: boolean;
}

export interface DomFieldInfo {
  selector: string;
  tag: string;
  inputType: string | null; // e.g. "password", "email", "text"
  name: string | null;
  placeholder: string | null;
  isSubmit: boolean;
  bbox: BBox; // in viewport CSS pixel space, will be scaled to screenshot space
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
