const test = require("node:test");
const assert = require("node:assert");
const { Redactor, luhnValid } = require("../src/redact");

test("luhn", () => {
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
});

test("redacts common PII and keeps plain text", () => {
  const r = new Redactor();
  const { text, found } = r.redact(
    "Mail ravi.k@example.com, call +91 98765 43210, card 4111 1111 1111 1111, " +
      "aadhaar 2345 6789 0124, PAN ABCDE1234F, host 192.168.1.20, password: hunter2"
  );
  for (const raw of ["ravi.k@example.com", "98765 43210", "4111 1111 1111 1111", "2345 6789 0124", "ABCDE1234F", "192.168.1.20", "hunter2"]) {
    assert.ok(!text.includes(raw), `leaked ${raw}`);
  }
  assert.ok(text.includes("password: [SECRET_1]"));
  assert.deepStrictEqual([...new Set(found)].sort(), ["AADHAAR", "CARD", "EMAIL", "IP", "PAN", "PHONE", "SECRET"]);
});

test("luhn-invalid digit runs are not treated as cards", () => {
  const r = new Redactor();
  assert.strictEqual(r.redact("order 4111111111111112").text, "order 4111111111111112");
});

test("same value gets same token, restore round-trips", () => {
  const r = new Redactor();
  const a = r.redact("a@b.co and a@b.co").text;
  assert.strictEqual(a, "[EMAIL_1] and [EMAIL_1]");
  assert.deepStrictEqual(r.restoreDeep({ to: "[EMAIL_1]", n: 3 }), { to: "a@b.co", n: 3 });
  assert.strictEqual(r.restore("[EMAIL_9]"), "[EMAIL_9]");
});

test("12-digit numbers failing Verhoeff are not treated as Aadhaar", () => {
  const r = new Redactor();
  assert.strictEqual(r.redact("ref no 2345 6789 0123").text, "ref no 2345 6789 0123");
  assert.match(r.redact("uid 4918 3726 5017").text, /\[AADHAAR_1\]/);
});
