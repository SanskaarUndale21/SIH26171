// Structured PII detection over OCR'd text. Pure regex, no model dependency.
export interface RegexMatch {
  type: "email" | "phone_number" | "card_number";
  text: string;
  start: number;
  end: number;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}[ -]?\d{0,4}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findPii(text: string): RegexMatch[] {
  const matches: RegexMatch[] = [];

  for (const m of text.matchAll(EMAIL_RE)) {
    matches.push({ type: "email", text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }

  for (const m of text.matchAll(CARD_RE)) {
    const trimmed = m[0].replace(/[ -]+$/, "");
    const digits = trimmed.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      matches.push({ type: "card_number", text: trimmed, start: m.index ?? 0, end: (m.index ?? 0) + trimmed.length });
    }
  }

  const cardSpans = matches.filter((m) => m.type === "card_number");
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/[^\d]/g, "");
    if (digits.length < 7 || digits.length > 13) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const overlapsCard = cardSpans.some((c) => start < c.end && end > c.start);
    if (!overlapsCard) {
      matches.push({ type: "phone_number", text: m[0], start, end });
    }
  }

  return matches;
}
