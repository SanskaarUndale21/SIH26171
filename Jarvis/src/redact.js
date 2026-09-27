// Local PII redaction for everything Jarvis sends to the LLM. Sensitive values are swapped for
// stable placeholders ([EMAIL_1], [PHONE_2], ...) and the real values stay in this process only.
// When the model later uses a placeholder in a tool call (e.g. "type [EMAIL_1] into the form"),
// restore() puts the real value back locally, right before the action runs. Same idea as the
// extension's answer vault: the model can act on data it never sees.

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff checksum: the last digit of every real Aadhaar number is one.
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(digits) {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = VD[c][VP[i % 8][digits.charCodeAt(digits.length - 1 - i) - 48]];
  }
  return c === 0;
}

const CHECKS = { luhn: luhnValid, verhoeff: verhoeffValid };

// Patterns come from shared/pii-rules.json, the same file the browser extension uses for OCR
// text, so both halves of the project mask exactly the same kinds of data.
const RULES = require("../../shared/pii-rules.json").rules.map((r) => ({
  type: r.token,
  re: new RegExp(r.pattern, r.flags.includes("g") ? r.flags : r.flags + "g"),
  group: r.group,
  check: r.check ? (m) => CHECKS[r.check](m.replace(/\D/g, "")) : null,
}));

const TOKEN_RE = new RegExp(String.raw`\[(${RULES.map((r) => r.type).join("|")})_\d+\]`, "g");

// Span-level matches for OCR text (screen redaction), same semantics as the extension's
// perception/regex.ts: earlier rules win on overlap, grouped rules report only the value.
function findPii(text) {
  const matches = [];
  const overlaps = (s, e) => matches.some((m) => s < m.end && e > m.start);
  for (const { type, re, group, check } of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let value = m[0];
      let start = m.index;
      if (group) {
        value = m[group] || "";
        start += m[0].length - value.length;
      }
      if (check && !check(value)) continue;
      const end = start + value.length;
      if (overlaps(start, end)) continue;
      matches.push({ type, text: value, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

class Redactor {
  constructor() {
    this.byValue = new Map();
    this.byToken = new Map();
    this.counts = {};
  }

  tokenFor(type, value) {
    const key = `${type}:${value}`;
    if (this.byValue.has(key)) return this.byValue.get(key);
    this.counts[type] = (this.counts[type] || 0) + 1;
    const token = `[${type}_${this.counts[type]}]`;
    this.byValue.set(key, token);
    this.byToken.set(token, value);
    return token;
  }

  // Returns { text, found } where found lists the types redacted in this call.
  redact(input) {
    if (typeof input !== "string" || !input) return { text: input ?? "", found: [] };
    let text = input;
    const found = [];
    for (const { type, re, group, check } of RULES) {
      text = text.replace(re, (...m) => {
        const whole = m[0];
        if (group) {
          const value = m[group];
          if (check && !check(value)) return whole;
          found.push(type);
          return whole.slice(0, whole.length - value.length) + this.tokenFor(type, value);
        }
        if (check && !check(whole)) return whole;
        found.push(type);
        return this.tokenFor(type, whole);
      });
    }
    return { text, found };
  }

  restore(text) {
    if (typeof text !== "string") return text;
    return text.replace(TOKEN_RE, (t) => (this.byToken.has(t) ? this.byToken.get(t) : t));
  }

  restoreDeep(value) {
    if (typeof value === "string") return this.restore(value);
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restoreDeep(v)]));
    }
    return value;
  }
}

module.exports = { Redactor, findPii, luhnValid, verhoeffValid };
