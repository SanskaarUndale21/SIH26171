// Ground-truth fixture for the eval harness (run.mjs): a realistic Indian scholarship
// application, same field ids as demo/fixture.html so a live run there lines up with this.
//
// 21 items that MUST be masked: 13 DOM-typed/named fields, 2 fields only vision can flag
// (names in plain text inputs), 6 non-field screen regions (photo, thumbnail, PII printed as
// page text). 11 items that must NOT be masked, including traps for the DOM name hints
// ("pincode" is not a PIN, "company" is not a PAN). Vision noise includes two false positives
// DOM evidence should suppress and two it can't (reported honestly as false positives).
import type { BBox, DetectedRegion, DomFieldInfo, DomSnapshot } from "../extension/src/types";

const L = 40; // left column x
const R = 520; // right column x
const W = 420;
const row = (i: number) => 200 + i * 50;

function field(
  selector: string,
  tag: string,
  inputType: string | null,
  name: string | null,
  placeholder: string | null,
  bbox: BBox,
  isSubmit = false
): DomFieldInfo {
  return { selector, tag, inputType, name, placeholder, isSubmit, bbox };
}

export const domSnapshot: DomSnapshot = {
  devicePixelRatio: 1,
  fields: [
    // --- must mask: DOM type or name says so ---
    field("#email", "input", "email", "email", "Email address", [L, row(0), W, 30]),
    field("#password", "input", "password", "password", "Create password", [R, row(0), W, 30]),
    field("#confirm_password", "input", "password", "confirm_password", "Confirm password", [R, row(1), W, 30]),
    field("#mobile", "input", "tel", "mobile", "Mobile number", [L, row(1), W, 30]),
    field("#alt_mobile", "input", "text", "alt_mobile", "Alternate mobile number", [L, row(2), W, 30]),
    field("#aadhaar", "input", "text", "aadhaar_no", "12-digit Aadhaar number", [R, row(2), W, 30]),
    field("#pan", "input", "text", "pan", "PAN", [L, row(3), W, 30]),
    field("#dob", "input", "date", "dob", "Date of birth", [R, row(3), W, 30]),
    field("#bank_account", "input", "text", "account_number", "Bank account number", [L, row(4), W, 30]),
    field("#card", "input", "text", "cc-number", "Card number (fee payment)", [R, row(4), W, 30]),
    field("#cvv", "input", "text", "cvv", "CVV", [L, row(5), 120, 30]),
    field("#otp", "input", "text", "otp", "OTP sent to mobile", [R, row(5), W, 30]),
    field("#address", "textarea", "text", "address", "Permanent address", [L, row(6), W, 70]),
    // --- must mask: only vision can tell (plain text inputs holding names) ---
    field("#fullname", "input", "text", "applicant", "Full name", [L, 140, W, 30]),
    field("#father_name", "input", "text", "father", "Father's / guardian's name", [R, 140, W, 30]),
    // --- must NOT mask ---
    field("#course", "select", null, "course", null, [L, row(8), W, 30]),
    field("#state", "select", null, "state", null, [R, row(8), W, 30]),
    field("#category", "select", null, "category", null, [L, row(9), W, 30]),
    field("#gender", "select", null, "gender", null, [R, row(9), W, 30]),
    field("#college", "input", "text", "college", "College / institute name", [L, row(10), W, 30]),
    field("#percentage", "input", "number", "percentage", "Last exam percentage", [R, row(10), W, 30]),
    field("#pincode", "input", "text", "pincode", "Pincode", [L, row(11), 200, 30]),
    field("#company", "input", "text", "company", "Parent's employer / company", [R, row(11), W, 30]),
    field("#sop", "textarea", "text", "statement", "Why do you need this scholarship?", [L, row(12), 900, 90]),
    field("#search", "input", "search", "q", "Search schemes", [700, 20, 260, 28]),
    field("#submit", "button", null, null, "Submit application", [L, row(15), 200, 36], true)
  ]
};

// Non-field regions of the screenshot, with ground truth.
export const screenRegions = {
  mustRedact: {
    profile_photo: [820, 40, 120, 140] as BBox,
    thumbnail_face: [520, 870, 60, 60] as BBox,
    printed_mobile: [40, 90, 240, 22] as BBox,
    printed_email: [300, 90, 280, 22] as BBox,
    printed_aadhaar: [40, 1060, 260, 22] as BBox,
    printed_card: [320, 1060, 300, 22] as BBox
  },
  mustNotRedact: {
    state_emblem: [40, 20, 60, 60] as BBox
  }
};

// What the on-device detectors report on that screenshot (OCR+regex, OCR+NER, BlazeFace).
export const visionRegions: DetectedRegion[] = [
  // true detections
  { label: "person_name", source: "ocr+ner", bbox: [L, 140, W, 30], confidence: 0.72 },
  { label: "person_name", source: "ocr+ner", bbox: [R, 140, W, 30], confidence: 0.64 },
  { label: "face", source: "blazeface", bbox: [822, 44, 116, 132], confidence: 0.93 },
  // weak lone detection: must still be masked (fail-safe), not dropped
  { label: "face", source: "blazeface", bbox: [522, 872, 56, 56], confidence: 0.38 },
  { label: "phone_number", source: "ocr+regex", bbox: [40, 90, 236, 22], confidence: 0.81 },
  // two detectors on the same printed email: fused by noisy-OR into one entry
  { label: "email", source: "ocr+regex", bbox: [300, 90, 278, 22], confidence: 0.6 },
  { label: "email", source: "ocr+ner", bbox: [302, 91, 274, 20], confidence: 0.55 },
  { label: "aadhaar", source: "ocr+regex", bbox: [40, 1060, 258, 22], confidence: 0.77 },
  { label: "card_number", source: "ocr+regex", bbox: [320, 1060, 296, 22], confidence: 0.83 },
  // noise that DOM evidence should suppress
  { label: "phone_number", source: "ocr+regex", bbox: [60, row(12) + 20, 120, 20], confidence: 0.3 },
  { label: "email", source: "ocr+regex", bbox: [L + 10, row(8) + 4, 200, 20], confidence: 0.4 },
  // noise DOM can't rule out (known limitations, counted as false positives)
  { label: "person_name", source: "ocr+ner", bbox: [L, row(10), W, 30], confidence: 0.35 }, // "Vivekananda College"
  { label: "face", source: "blazeface", bbox: [42, 22, 56, 56], confidence: 0.31 } // state emblem
];

export const groundTruth = {
  mustRedactFields: [
    "#email", "#password", "#confirm_password", "#mobile", "#alt_mobile", "#aadhaar", "#pan", "#dob",
    "#bank_account", "#card", "#cvv", "#otp", "#address", "#fullname", "#father_name"
  ],
  visionOnlyFields: ["#fullname", "#father_name"],
  mustNotRedactFields: [
    "#course", "#state", "#category", "#gender", "#college", "#percentage", "#pincode", "#company", "#sop", "#search"
  ],
  screenWidth: 1000,
  screenHeight: 1200
};

// Text corpus for the shared regex detector (shared/pii-rules.json), Indian formats plus
// look-alike negatives: order ids, pincodes, dates, amounts, GSTIN, IFSC, roll numbers.
export const textCases: { text: string; expect: string[] }[] = [
  { text: "contact jane.doe@example.com or 555-123-4567", expect: ["email", "phone_number"] },
  { text: "email me at rahul_k@college.edu.in", expect: ["email"] },
  { text: "card 4111 1111 1111 1111 exp 12/26", expect: ["card_number"] },
  { text: "Mastercard 5555 5555 5555 4444", expect: ["card_number"] },
  { text: "invalid card 1234 5678 9012 3456", expect: [] },
  { text: "Aadhaar: 2345 6789 0124", expect: ["aadhaar"] },
  { text: "UID 491837265017", expect: ["aadhaar"] },
  { text: "ref no 2345 6789 0123", expect: [] },
  { text: "PAN ABCDE1234F issued", expect: ["pan"] },
  { text: "GSTIN 27ABCDE1234F1Z5", expect: [] },
  { text: "Call me on +91 98765 43210 after 5", expect: ["phone_number"] },
  { text: "mobile 9876543210", expect: ["phone_number"] },
  { text: "Order #4500123456 shipped", expect: [] },
  { text: "Pincode 411001, Pune", expect: [] },
  { text: "Year 2024-2025 session", expect: [] },
  { text: "Invoice INV-2026-000123", expect: [] },
  { text: "Meeting at 10:30 on 12/05/2026", expect: [] },
  { text: "Rs. 1,25,000 scholarship amount", expect: [] },
  { text: "IFSC SBIN0001234", expect: [] },
  { text: "Roll number 21BCE1234", expect: [] },
  { text: "Server at 10.0.0.12 is down", expect: ["ip_address"] },
  { text: "password: Hunter2!", expect: ["secret"] },
  { text: "your OTP is 482913", expect: ["secret"] },
  { text: "api_key=sk-abc123def456", expect: ["secret"] },
  { text: "just a normal sentence about the weather today", expect: [] }
];
