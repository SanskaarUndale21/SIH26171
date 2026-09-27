import type { BBox, DetectedRegion, DomFieldInfo, DomSnapshot, PiiType, RedactionEntry } from "../types";
import { fuseVisionConfidence } from "./confidence";

function scaleBBox([x, y, w, h]: BBox, scale: number): BBox {
  return [x * scale, y * scale, w * scale, h * scale];
}

function iou(a: BBox, b: BBox): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, x1 - x0);
  const interH = Math.max(0, y1 - y0);
  const inter = interW * interH;
  if (inter <= 0) return 0;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

function domFieldPiiType(inputType: string | null): PiiType | null {
  if (inputType === "password") return "password_field";
  if (inputType === "email") return "email";
  if (inputType === "tel") return "phone_number";
  return null;
}

// Name/placeholder hints for fields whose `type` says nothing (Indian e-gov forms put Aadhaar,
// PAN and account numbers in plain type="text" inputs). Checked before the textarea/select
// "safe" rule, so an address textarea is still redacted.
const DOM_NAME_HINTS: [RegExp, PiiType][] = [
  [/card|cc-?num|credit/i, "card_number"],
  [/aadhaa?r|uidai|\buid\b/i, "aadhaar"],
  [/\bpan\b|\bpan[_-]?(no|num|card)/i, "pan"],
  [/account[_-]?(no|num)|\bacc(t)?[_-]?no\b/i, "bank_account"],
  [/\bdob\b|birth/i, "date_of_birth"],
  [/\botp\b|\bcvv\b|\bcvc\b|\bpin\b/i, "secret"],
  [/mobile|phone/i, "phone_number"],
  // plain type="text" email inputs (DemoQA's #userEmail, placeholder "name@example.com")
  [/e-?mail|@/i, "email"],
  [/address|street/i, "address"]
];

function domHintType(field: DomFieldInfo): PiiType | null {
  const haystack = `${field.name ?? ""} ${field.placeholder ?? ""} ${field.selector}`;
  for (const [re, type] of DOM_NAME_HINTS) if (re.test(haystack)) return type;
  return null;
}

// DOM signal wins when it disagrees with vision: any vision region that overlaps a DOM
// field is dropped in favor of the DOM-authoritative type; DOM fields are always redacted
// even if vision missed them entirely.
export function fuseForRedaction(dom: DomSnapshot, visionRegions: DetectedRegion[]): RedactionEntry[] {
  const scale = dom.devicePixelRatio;
  const entries: RedactionEntry[] = [];
  const domBoxes: BBox[] = [];
  // Fields the DOM structurally confirms are NOT single-value PII inputs (a long-form
  // textarea, a closed-option select) -- a vision hit landing here is overridden by this
  // positive DOM evidence, the same "DOM wins" rule applied in the other direction. Plain
  // text inputs are deliberately excluded: `type="text"` alone is not proof of safety (card
  // number fields are routinely type="text"), so those stay open to vision detection.
  const domSafeBoxes: BBox[] = [];

  for (const field of dom.fields) {
    if (field.isSubmit || field.tag === "button" || field.tag === "select") {
      if (field.tag === "select") domSafeBoxes.push(scaleBBox(field.bbox, scale));
      continue;
    }
    const finalType = domFieldPiiType(field.inputType) ?? domHintType(field);
    if (finalType) {
      const bbox = scaleBBox(field.bbox, scale);
      domBoxes.push(bbox);
      entries.push({ type: finalType, bbox, confidence: 0.99, method: "blackbox" });
      continue;
    }
    if (field.tag === "textarea") {
      domSafeBoxes.push(scaleBBox(field.bbox, scale));
    }
  }

  const visionKeepTypes = new Set([
    "face",
    "card_number",
    "email",
    "phone_number",
    "person_name",
    "aadhaar",
    "pan",
    "secret"
  ]);
  const relevantVision = visionRegions.filter((r) => visionKeepTypes.has(r.label));
  // Independent detectors agreeing on the same span (e.g. regex + NER both flagging the same
  // text) get combined into one higher-confidence entry instead of two separate weak ones.
  const fusedVision = fuseVisionConfidence(relevantVision);

  for (const region of fusedVision) {
    const overlapsSensitiveDom = domBoxes.some((d) => iou(d, region.bbox) > 0.3);
    if (overlapsSensitiveDom) continue; // DOM already authoritative for this region
    const overlapsSafeDom = domSafeBoxes.some((d) => iou(d, region.bbox) > 0.1);
    if (overlapsSafeDom) continue; // DOM structurally confirms this spot is not PII
    // Fail-safe: even a low-confidence lone detection is still redacted by default, never
    // silently dropped -- the transparency panel (privacy/transparency.ts) is where a low
    // score becomes visible, not a reason to skip protection.
    entries.push({
      type: region.label,
      bbox: region.bbox,
      confidence: region.confidence,
      method: "blackbox"
    });
  }

  return entries;
}
