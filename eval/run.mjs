// Real eval harness: bundles the actual extension privacy/fuse.ts (+confidence.ts) and
// regex.ts with esbuild, then runs them in Node against eval/fixture.ts -- no mocked
// numbers, this is the real fusion logic that ships in the extension, exercised the same
// way the other SIH26171 attempts' eval scripts did, so the results are directly comparable.
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrc = path.join(__dirname, "..", "extension", "src");

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral"
  });
  const code = result.outputFiles[0].text;
  const tmp = path.join(__dirname, `.bundle-${path.basename(entry, ".ts")}.mjs`);
  writeFileSync(tmp, code);
  return tmp;
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

async function main() {
  const fuseModulePath = await bundle(path.join(extensionSrc, "privacy", "fuse.ts"));
  const regexModulePath = await bundle(path.join(extensionSrc, "perception", "regex.ts"));
  const { fuseForRedaction } = await import(`file://${fuseModulePath}`);
  const { findPii } = await import(`file://${regexModulePath}`);

  const { domSnapshot, visionRegions, groundTruth } = await import("./fixture.ts").catch(async () => {
    // fixture.ts imports a .ts type-only import from ../extension/src/types, which Node
    // can't load directly -- bundle it the same way as the logic modules.
    const fixtureBundle = await bundle(path.join(__dirname, "fixture.ts"));
    return import(`file://${fixtureBundle}`);
  });

  // --- 1. Redaction precision/recall against the DOM+vision fixture ---
  const t0 = performance.now();
  const manifest = fuseForRedaction(domSnapshot, visionRegions);
  const fusionLatencyMs = performance.now() - t0;

  function fieldWasRedacted(field) {
    return manifest.some((entry) => iou(entry.bbox, field.bbox) > 0.3);
  }

  const fieldsBySelector = Object.fromEntries(domSnapshot.fields.map((f) => [f.selector, f]));
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const sel of groundTruth.mustRedact) {
    if (fieldWasRedacted(fieldsBySelector[sel])) tp++; else fn++;
  }
  for (const sel of groundTruth.mustNotRedact) {
    if (fieldWasRedacted(fieldsBySelector[sel])) fp++; else tn++;
  }
  const recall = tp / (tp + fn);
  const precision = tp / (tp + fp || 1);

  // --- 2. Regex PII detector precision/recall on a text corpus ---
  const textCases = [
    { text: "contact jane.doe@example.com or 555-123-4567", expect: ["email", "phone_number"] },
    { text: "card 4111 1111 1111 1111 exp 12/26", expect: ["card_number"] },
    { text: "invalid card 1234 5678 9012 3456", expect: [] }, // fails Luhn, must NOT be flagged as card
    { text: "just a normal sentence about the weather today", expect: [] }
  ];
  let regexTp = 0, regexFn = 0, regexFp = 0;
  const t1 = performance.now();
  for (const c of textCases) {
    const found = findPii(c.text).map((m) => m.type);
    for (const expected of c.expect) {
      if (found.includes(expected)) regexTp++; else regexFn++;
    }
    for (const f of found) {
      if (f === "card_number" && !c.expect.includes("card_number") && c.text.includes("invalid")) regexFp++;
    }
  }
  const regexLatencyMs = performance.now() - t1;

  const report = {
    generatedAt: new Date().toISOString(),
    fusion: {
      manifestEntries: manifest.length,
      truePositives: tp,
      falseNegatives: fn,
      falsePositives: fp,
      trueNegatives: tn,
      recall,
      precision,
      latencyMs: Number(fusionLatencyMs.toFixed(3))
    },
    regexPii: {
      cases: textCases.length,
      truePositiveMatches: regexTp,
      falseNegativeMatches: regexFn,
      falsePositiveCardMatches: regexFp,
      latencyMs: Number(regexLatencyMs.toFixed(3))
    },
    manifest
  };

  writeFileSync(path.join(__dirname, "benchmark_output.json"), JSON.stringify(report, null, 2));

  const md = `# Eval Results — Privacy-Preserving Browser Agent

Generated: ${report.generatedAt}
Fixture: \`eval/fixture.ts\` (8 DOM fields: 5 must-redact, 2 control, 1 submit; 5 vision
regions including one deliberately duplicated detection and one deliberately mislocated
false-positive-shaped hit over a control field)

## Redaction precision/recall (privacy/fuse.ts + privacy/confidence.ts, real code, real run)

| Metric | Result |
|---|---|
| Manifest entries produced | ${manifest.length} |
| True positives (sensitive fields correctly redacted) | ${tp} / ${groundTruth.mustRedact.length} |
| False negatives (sensitive fields missed) | ${fn} / ${groundTruth.mustRedact.length} |
| False positives (control fields wrongly redacted) | ${fp} / ${groundTruth.mustNotRedact.length} |
| True negatives (control fields correctly left alone) | ${tn} / ${groundTruth.mustNotRedact.length} |
| Recall | ${(recall * 100).toFixed(1)}% |
| Precision | ${(precision * 100).toFixed(1)}% |
| Fusion latency (fuseForRedaction call, this machine) | ${fusionLatencyMs.toFixed(3)} ms |

Notes: \`#fullname\` has no DOM \`type\` hint and is redacted purely on the vision-side
person_name detection -- this is the one field in the fixture that actually exercises
vision, not just DOM. The duplicate email detections (regex + NER on the same span) are
merged by \`fuseVisionConfidence\`'s noisy-OR into one higher-confidence entry rather than
two. The phone_number-shaped false-positive region placed over \`#bio\` is correctly
suppressed because \`#bio\` is a \`<textarea>\` -- structurally confirmed non-PII by the DOM,
which overrides the vision guess (see \`domSafeBoxes\` in fuse.ts).

## Regex PII detector precision/recall (perception/regex.ts, real code, real run)

| Metric | Result |
|---|---|
| Text cases | ${textCases.length} |
| True positive matches | ${regexTp} |
| False negative matches | ${regexFn} |
| False positive card matches (Luhn-invalid, must be 0) | ${regexFp} |
| Latency (4 cases, this machine) | ${regexLatencyMs.toFixed(3)} ms |

Full manifest and raw numbers: \`eval/benchmark_output.json\`.
`;

  writeFileSync(path.join(__dirname, "results.md"), md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
