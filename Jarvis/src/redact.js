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

// Order matters: card numbers go before Aadhaar/phone so a 16-digit card isn't half-eaten by a
// shorter pattern first. Secrets only redact the value after the keyword, not the keyword.
const PATTERNS = [
  { type: "SECRET", re: /\b(password|passwd|pwd|pin|otp|api[_-]?key|token|secret)(\s*[:=]\s*|\s+is\s+)(\S+)/gi, group: 3 },
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    type: "CARD",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    check: (m) => luhnValid(m.replace(/\D/g, "")),
  },
  { type: "AADHAAR", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: "PHONE", re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
  { type: "IP", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

const TOKEN_RE = /\[(SECRET|EMAIL|CARD|AADHAAR|PAN|PHONE|IP)_\d+\]/g;

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
    for (const { type, re, group, check } of PATTERNS) {
      text = text.replace(re, (...m) => {
        const whole = m[0];
        if (group) {
          const value = m[group];
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

module.exports = { Redactor, luhnValid };
