// Structured PII detection over OCR'd text. Pure regex, no model dependency. The patterns
// themselves live in shared/pii-rules.json so the Jarvis desktop app redacts exactly the same
// things the extension does -- one list to extend, not two to keep in sync.
import rulesFile from "../../../shared/pii-rules.json";

export interface RegexMatch {
  type: string; // email | phone_number | card_number | aadhaar | pan | ip_address | secret
  token: string; // placeholder name shared with Jarvis: EMAIL, PHONE, CARD, ...
  text: string;
  start: number;
  end: number;
}

interface PiiRule {
  type: string;
  token: string;
  pattern: string;
  flags: string;
  group?: number;
  check?: "luhn" | "verhoeff";
}

const RULES: (PiiRule & { re: RegExp })[] = (rulesFile.rules as PiiRule[]).map((r) => ({
  ...r,
  re: new RegExp(r.pattern, r.flags.includes("g") ? r.flags : r.flags + "g")
}));

export function luhnValid(digits: string): boolean {
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

// Verhoeff checksum: the last digit of every real Aadhaar number is one.
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = VD[c][VP[i % 8][digits.charCodeAt(digits.length - 1 - i) - 48]];
  }
  return c === 0;
}

const CHECKS: Record<string, (digits: string) => boolean> = { luhn: luhnValid, verhoeff: verhoeffValid };

export function findPii(text: string): RegexMatch[] {
  const matches: RegexMatch[] = [];
  const overlaps = (start: number, end: number) => matches.some((m) => start < m.end && end > m.start);

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const whole = m[0];
      let value = whole;
      let start = m.index ?? 0;
      if (rule.group) {
        value = m[rule.group] ?? "";
        start += whole.length - value.length; // the captured value is always the tail
      }
      if (rule.check && !CHECKS[rule.check](value.replace(/\D/g, ""))) continue;
      const end = start + value.length;
      // Earlier rules win on overlap (card before aadhaar/phone), so a span is never
      // reported twice under two different types.
      if (overlaps(start, end)) continue;
      matches.push({ type: rule.type, token: rule.token, text: value, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

// Replaces private values in free text (the task someone types) with placeholders such as
// [EMAIL_1], the same scheme Jarvis uses. The real values stay in `values`, on this device.
export function maskText(text: string): { masked: string; values: Map<string, string>; types: string[] } {
  const values = new Map<string, string>();
  const byValue = new Map<string, string>();
  const counts: Record<string, number> = {};
  const types: string[] = [];
  let masked = "";
  let last = 0;
  for (const m of findPii(text)) {
    let token = byValue.get(m.text);
    if (!token) {
      counts[m.token] = (counts[m.token] ?? 0) + 1;
      token = `[${m.token}_${counts[m.token]}]`;
      byValue.set(m.text, token);
      values.set(token, m.text);
      types.push(m.type);
    }
    masked += text.slice(last, m.start) + token;
    last = m.end;
  }
  return { masked: masked + text.slice(last), values, types };
}

export const PLACEHOLDER_RE = /\[(SECRET|EMAIL|CARD|AADHAAR|PAN|PHONE|IP)_\d+\]/g;
