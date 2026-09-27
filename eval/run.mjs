// Real eval harness: bundles the extension's actual privacy/fuse.ts (+confidence.ts) and
// perception/regex.ts (+shared/pii-rules.json) with esbuild and runs them in Node against
// eval/fixture.ts. No mocked numbers: this is the code that ships in the extension.
//
// Reports the three things the SIH 26171 rubric scores on the privacy side:
//   1. detection recall/precision per item (fields + screen regions)
//   2. redaction precision at pixel level (how tight the masks are, how much is over-masked)
//   3. text PII detector precision/recall per type
// plus fusion/regex latency.
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrc = path.join(__dirname, "..", "extension", "src");

async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral" });
  const tmp = path.join(__dirname, `.bundle-${path.basename(entry, ".ts")}.mjs`);
  writeFileSync(tmp, result.outputFiles[0].text);
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

function paint(grid, width, height, [x, y, w, h]) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) grid.fill(1, yy * width + x0, yy * width + x1);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);

async function main() {
  const { fuseForRedaction } = await import(`file://${await bundle(path.join(extensionSrc, "privacy", "fuse.ts"))}`);
  const { findPii } = await import(`file://${await bundle(path.join(extensionSrc, "perception", "regex.ts"))}`);
  const { domSnapshot, visionRegions, groundTruth, screenRegions, textCases } = await import(
    `file://${await bundle(path.join(__dirname, "fixture.ts"))}`
  );

  // --- 1. detection, item level ---
  const t0 = performance.now();
  const RUNS = 200;
  let manifest;
  for (let i = 0; i < RUNS; i++) manifest = fuseForRedaction(domSnapshot, visionRegions);
  const fusionLatencyMs = (performance.now() - t0) / RUNS;

  const fieldBox = Object.fromEntries(domSnapshot.fields.map((f) => [f.selector, f.bbox]));
  const masked = (bbox) => manifest.some((e) => iou(e.bbox, bbox) > 0.3);

  const mustItems = [
    ...groundTruth.mustRedactFields.map((s) => ({ id: s, kind: groundTruth.visionOnlyFields.includes(s) ? "field (vision only)" : "field", bbox: fieldBox[s] })),
    ...Object.entries(screenRegions.mustRedact).map(([id, bbox]) => ({ id, kind: "screen region", bbox }))
  ];
  const mustNotItems = [
    ...groundTruth.mustNotRedactFields.map((s) => ({ id: s, kind: "field", bbox: fieldBox[s] })),
    ...Object.entries(screenRegions.mustNotRedact).map(([id, bbox]) => ({ id, kind: "screen region", bbox }))
  ];

  const itemRows = [];
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const item of mustItems) {
    const hit = masked(item.bbox);
    hit ? tp++ : fn++;
    const entry = manifest.filter((e) => iou(e.bbox, item.bbox) > 0.3).sort((a, b) => iou(b.bbox, item.bbox) - iou(a.bbox, item.bbox))[0];
    itemRows.push({ ...item, expected: "mask", got: hit ? "masked" : "MISSED", type: entry?.type ?? "", iou: entry ? iou(entry.bbox, item.bbox) : 0, ok: hit });
  }
  for (const item of mustNotItems) {
    const hit = masked(item.bbox);
    hit ? fp++ : tn++;
    itemRows.push({ ...item, expected: "keep", got: hit ? "MASKED (FP)" : "kept", type: "", iou: 0, ok: !hit });
  }
  const recall = tp / (tp + fn);
  const precision = tp / (tp + fp || 1);

  // --- 2. redaction precision, pixel level ---
  const { screenWidth: W, screenHeight: H } = groundTruth;
  const gt = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  for (const item of mustItems) paint(gt, W, H, item.bbox);
  for (const e of manifest) paint(mask, W, H, e.bbox);
  let inter = 0, maskArea = 0, gtArea = 0;
  for (let i = 0; i < gt.length; i++) {
    if (mask[i]) maskArea++;
    if (gt[i]) gtArea++;
    if (mask[i] && gt[i]) inter++;
  }
  const pixelPrecision = inter / (maskArea || 1);
  const pixelRecall = inter / (gtArea || 1);
  const tpIous = itemRows.filter((r) => r.expected === "mask" && r.ok).map((r) => r.iou);
  const meanIou = tpIous.reduce((a, b) => a + b, 0) / (tpIous.length || 1);

  // --- 3. text PII detector ---
  const perType = {};
  const bump = (t, k) => ((perType[t] ??= { tp: 0, fn: 0, fp: 0 })[k]++);
  let rtp = 0, rfn = 0, rfp = 0;
  const failures = [];
  const t1 = performance.now();
  for (const c of textCases) {
    const found = findPii(c.text).map((m) => m.type);
    for (const e of c.expect) {
      if (found.includes(e)) { rtp++; bump(e, "tp"); } else { rfn++; bump(e, "fn"); failures.push(`missed ${e}: "${c.text}"`); }
    }
    for (const f of found) {
      if (!c.expect.includes(f)) { rfp++; bump(f, "fp"); failures.push(`false ${f}: "${c.text}"`); }
    }
  }
  const regexLatencyMs = (performance.now() - t1) / textCases.length;
  const regexPrecision = rtp / (rtp + rfp || 1);
  const regexRecall = rtp / (rtp + rfn || 1);

  const report = {
    generatedAt: new Date().toISOString(),
    detection: { items: mustItems.length + mustNotItems.length, truePositives: tp, falseNegatives: fn, falsePositives: fp, trueNegatives: tn, recall, precision, f1: f1(precision, recall) },
    redactionPixels: { pixelPrecision, pixelRecall, meanIouOfCorrectMasks: meanIou, maskedPixels: maskArea, sensitivePixels: gtArea },
    textPii: { cases: textCases.length, truePositives: rtp, falseNegatives: rfn, falsePositives: rfp, precision: regexPrecision, recall: regexRecall, perType, failures },
    latency: { fusionMsPerPage: Number(fusionLatencyMs.toFixed(3)), regexMsPerText: Number(regexLatencyMs.toFixed(4)) },
    items: itemRows.map(({ bbox, ...r }) => r),
    manifest
  };
  writeFileSync(path.join(__dirname, "benchmark_output.json"), JSON.stringify(report, null, 2));

  const itemTable = itemRows
    .map((r) => `| \`${r.id}\` | ${r.kind} | ${r.expected} | ${r.ok ? "" : "**"}${r.got}${r.ok ? "" : "**"} | ${r.type} | ${r.expected === "mask" && r.ok ? r.iou.toFixed(2) : ""} |`)
    .join("\n");
  const typeTable = Object.entries(perType)
    .sort()
    .map(([t, v]) => `| ${t} | ${v.tp} | ${v.fn} | ${v.fp} | ${pct(v.tp / (v.tp + v.fp || 1))} | ${pct(v.tp / (v.tp + v.fn || 1))} |`)
    .join("\n");

  const md = `# Eval results: privacy-preserving browser agent

Generated: ${report.generatedAt}. Reproduce with \`cd eval && npm install && npm run eval\`.

Fixture (\`eval/fixture.ts\`, same ids as \`demo/fixture.html\`): an Indian scholarship
application with ${mustItems.length} items that must be masked (13 DOM fields, 2 fields only vision can
flag, 6 screen regions such as the photo and PII printed as page text) and ${mustNotItems.length} that must not
(including "pincode" and "company" traps for the DOM name hints). The vision side is ${visionRegions.length}
scripted detector outputs (what OCR+regex, OCR+NER and BlazeFace report on that page), fed into
the real fusion and redaction code: true hits, a weak lone face (fail-safe test), a duplicate
pair (fusion test), two false positives DOM evidence should suppress, and two it cannot. Model
accuracy on real screenshots is measured live in the side panel, not here.

## 1. Detection (${report.detection.items} ground-truth items)

| Metric | Result |
|---|---|
| Recall | **${pct(recall)}** (${tp}/${tp + fn}) |
| Precision | **${pct(precision)}** (${tp}/${tp + fp}) |
| F1 | ${pct(report.detection.f1)} |
| False positives | ${fp}/${mustNotItems.length} controls |
| Fusion latency | ${fusionLatencyMs.toFixed(3)} ms per page (avg of ${RUNS} runs) |

## 2. Redaction precision (pixel level)

| Metric | Result |
|---|---|
| Masked pixels that are sensitive | **${pct(pixelPrecision)}** |
| Sensitive pixels that got masked | **${pct(pixelRecall)}** |
| Mean IoU of correct masks vs ground truth | ${meanIou.toFixed(3)} |

## 3. Text PII detector (${textCases.length} cases, shared/pii-rules.json)

| Metric | Result |
|---|---|
| Precision | **${pct(regexPrecision)}** (${rtp}/${rtp + rfp}) |
| Recall | **${pct(regexRecall)}** (${rtp}/${rtp + rfn}) |
| Latency | ${regexLatencyMs.toFixed(4)} ms per text |

| Type | TP | FN | FP | Precision | Recall |
|---|---|---|---|---|---|
${typeTable}

${failures.length ? "Detector misses / false hits:\n\n" + failures.map((f) => `- ${f}`).join("\n") : "No detector misses or false hits on this corpus."}

## Per item

| Item | Kind | Expected | Got | Masked as | IoU |
|---|---|---|---|---|---|
${itemTable}

## Known limitations shown above

- A plain text input whose content NER mistakes for a person (\`#college\`, "Vivekananda College")
  is masked: DOM can't prove a text input safe, and the fail-safe prefers over-masking.
- BlazeFace's weak hit on the state emblem is masked for the same reason.
Both cost precision, never privacy. Full manifest and raw numbers: \`eval/benchmark_output.json\`.
`;
  writeFileSync(path.join(__dirname, "results.md"), md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
