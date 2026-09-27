// Real on-device models on a rendered test "screen": OCR must find the PII text, the masked
// image must be black where the PII was, and the manifest carries types, not values.
// Skips if the extension's bundled models aren't present.
const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const { redactScreen, transcribe, shutdown, modelsAvailable } = require("../src/perception");

async function fakeScreen() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="40" y="80" font-family="Arial" font-size="34" fill="#000">Weekly report for the team</text>
    <text x="40" y="170" font-family="Arial" font-size="34" fill="#000">Contact priya.sharma@example.org</text>
    <text x="40" y="260" font-family="Arial" font-size="34" fill="#000">Mobile 98765 43210</text>
    <text x="40" y="350" font-family="Arial" font-size="34" fill="#000">Aadhaar 2345 6789 0124</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function darkness(png, [x, y, w, h]) {
  const { data } = await sharp(png).extract({ left: x, top: y, width: w, height: h }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return 1 - data.reduce((a, b) => a + b, 0) / (data.length * 255);
}

test("screen redaction masks PII text on-device", { skip: !modelsAvailable() && "bundled models missing", timeout: 180000 }, async () => {
  const png = await fakeScreen();
  const { masked, manifest, timings } = await redactScreen(png);
  const types = manifest.map((m) => m.type);
  assert.ok(types.includes("email"), `types: ${types}`);
  assert.ok(types.includes("phone"), `types: ${types}`);
  assert.ok(types.includes("aadhaar"), `types: ${types}`);
  assert.ok(!JSON.stringify(manifest).includes("priya"), "manifest must not carry values");

  // Where the email was is now (almost) solid black; the plain heading is untouched.
  const email = manifest.find((m) => m.type === "email").bbox;
  assert.ok((await darkness(masked, email)) > 0.95);
  assert.ok((await darkness(masked, [40, 50, 400, 40])) < 0.5);
  assert.ok(timings.totalMs > 0);
});

test("whisper loads locally and returns text for audio", { skip: !modelsAvailable() && "bundled models missing", timeout: 180000 }, async () => {
  const silence = new Float32Array(16000);
  const text = await transcribe(silence);
  assert.strictEqual(typeof text, "string");
});

test.after(() => shutdown());
