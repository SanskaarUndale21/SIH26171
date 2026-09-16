// Ground-truth fixture for the eval harness (run.mjs). Mirrors a realistic registration
// form: 5 fields that MUST be redacted, 2 control fields that must NOT be, plus a submit
// button -- deliberately the same shape used across the other SIH26171 attempts so results
// are comparable field-for-field, not just internally consistent.
import type { DetectedRegion, DomSnapshot } from "../extension/src/types";

export const domSnapshot: DomSnapshot = {
  devicePixelRatio: 1,
  fields: [
    { selector: "#fullname", tag: "input", inputType: "text", name: "fullname", placeholder: "Full name", isSubmit: false, bbox: [40, 60, 300, 24] },
    { selector: "#email", tag: "input", inputType: "email", name: "email", placeholder: "Email", isSubmit: false, bbox: [40, 100, 300, 24] },
    { selector: "#password", tag: "input", inputType: "password", name: "password", placeholder: "Password", isSubmit: false, bbox: [40, 140, 300, 24] },
    { selector: "#card", tag: "input", inputType: "text", name: "cc-number", placeholder: "Card number", isSubmit: false, bbox: [40, 180, 300, 24] },
    { selector: "#phone", tag: "input", inputType: "tel", name: "phone", placeholder: "Phone", isSubmit: false, bbox: [40, 220, 300, 24] },
    { selector: "#bio", tag: "textarea", inputType: "text", name: "bio", placeholder: "Short bio", isSubmit: false, bbox: [40, 260, 300, 60] },
    { selector: "#favorite_color", tag: "select", inputType: null, name: "favorite_color", placeholder: null, isSubmit: false, bbox: [40, 330, 300, 24] },
    { selector: "#submit", tag: "button", inputType: null, name: null, placeholder: "Submit", isSubmit: true, bbox: [40, 370, 100, 30] }
  ]
};

// full_name has no DOM `type` to key off, so it depends entirely on the vision pass (OCR +
// NER) -- this is the one field in the fixture that actually exercises vision-side detection
// rather than DOM fusion, on purpose.
export const visionRegions: DetectedRegion[] = [
  { label: "person_name", source: "ocr+ner", bbox: [40, 60, 300, 24], confidence: 0.72 },
  { label: "face", source: "blazeface", bbox: [400, 60, 120, 120], confidence: 0.93 },
  // Two independent detectors hitting the same email span -- exercises the noisy-OR fusion
  // in privacy/confidence.ts instead of the two entries just sitting there separately.
  { label: "email", source: "ocr+regex", bbox: [40, 100, 300, 24], confidence: 0.6 },
  { label: "email", source: "ocr+ner", bbox: [42, 101, 296, 22], confidence: 0.55 },
  // A false-positive-shaped vision hit over a control field -- precision test: fuse.ts must
  // NOT redact this, because DOM says #bio has no sensitive `type` and nothing legitimate
  // should override that.
  { label: "phone_number", source: "ocr+regex", bbox: [40, 260, 60, 20], confidence: 0.3 }
];

export const groundTruth = {
  mustRedact: ["#fullname", "#email", "#password", "#card", "#phone"],
  mustNotRedact: ["#bio", "#favorite_color"]
};
