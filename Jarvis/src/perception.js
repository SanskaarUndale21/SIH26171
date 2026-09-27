// On-device perception for the desktop: the same models the browser extension bundles
// (extension/public/), run in Node with onnxruntime-node instead of WebGPU/WASM. Nothing here
// touches the network: transformers.js is locked to local files and Tesseract reads the bundled
// language data.
//
//   redactScreen(png)  OCR + shared PII rules + NER names + YOLO people -> black boxes
//   transcribe(pcm)    Whisper-tiny speech to text, 16 kHz mono Float32Array
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const ort = require("onnxruntime-node");
const { findPii } = require("./redact");

const MODELS_ROOT = process.env.JARVIS_MODELS_DIR || path.join(__dirname, "..", "..", "extension", "public");
const YOLO_INPUT = 640;
const YOLO_MIN_CONF = 0.4;
const NER_MIN_CONF = 0.5;

function modelsAvailable() {
  return fs.existsSync(path.join(MODELS_ROOT, "models", "Xenova", "whisper-tiny.en"));
}

let transformersPromise = null;
function transformers() {
  if (!transformersPromise) {
    transformersPromise = import("@huggingface/transformers").then((T) => {
      T.env.allowRemoteModels = false;
      T.env.allowLocalModels = true;
      T.env.localModelPath = path.join(MODELS_ROOT, "models") + path.sep;
      return T;
    });
  }
  return transformersPromise;
}

// Lazily created, then reused: first call pays the model load, later calls are fast.
const cache = {};
function once(key, make) {
  if (!cache[key]) cache[key] = make().catch((err) => {
    delete cache[key];
    throw err;
  });
  return cache[key];
}

const asr = () => once("asr", async () => (await transformers()).pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { dtype: "q8" }));
const ner = () => once("ner", async () => (await transformers()).pipeline("token-classification", "Xenova/bert-base-NER", { dtype: "q8" }));
const yolo = () => once("yolo", () => ort.InferenceSession.create(path.join(MODELS_ROOT, "yolo", "model_fp16.onnx")));
// Inside Electron, tesseract.js treats langPath as a URL and tries to fetch it (stalls on a
// local path). Its cache lookup is a plain fs read that also accepts gzipped data, so the
// bundled file is copied once to a cache dir under the name Tesseract looks for.
function tessCacheDir() {
  const dir = path.join(require("os").tmpdir(), "jarvis-tessdata");
  const target = path.join(dir, "eng.traineddata");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(MODELS_ROOT, "tesseract", "lang", "eng.traineddata.gz"), target);
  }
  return dir;
}

const ocr = () =>
  once("ocr", async () => {
    const { createWorker } = require("tesseract.js");
    return createWorker("eng", 1, {
      cachePath: tessCacheDir(),
      cacheMethod: "readOnly",
      langPath: path.join(MODELS_ROOT, "tesseract", "lang"),
    });
  });

async function transcribe(samples) {
  const out = await (await asr())(samples);
  return ((Array.isArray(out) ? out[0] : out)?.text || "").trim();
}

// --- screen redaction ---

function unionBox(boxes) {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

// Which OCR words a text-level match covers, so it can become a pixel box.
function wordsForSpan(words, joined, start, end) {
  const hit = [];
  let cursor = 0;
  for (const w of words) {
    const ws = joined.indexOf(w.text, cursor);
    if (ws === -1) continue;
    const we = ws + w.text.length;
    if (ws < end && we > start) hit.push(w);
    cursor = we;
  }
  return hit;
}

async function detectPeople(png, width, height) {
  const session = await yolo();
  const scale = Math.min(YOLO_INPUT / width, YOLO_INPUT / height);
  const drawW = Math.round(width * scale);
  const drawH = Math.round(height * scale);
  const padX = Math.floor((YOLO_INPUT - drawW) / 2);
  const padY = Math.floor((YOLO_INPUT - drawH) / 2);
  const { data } = await sharp(png)
    .resize(drawW, drawH)
    .extend({ top: padY, bottom: YOLO_INPUT - drawH - padY, left: padX, right: YOLO_INPUT - drawW - padX, background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = YOLO_INPUT * YOLO_INPUT;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 3] / 255;
    chw[plane + i] = data[i * 3 + 1] / 255;
    chw[2 * plane + i] = data[i * 3 + 2] / 255;
  }
  const out = (await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", chw, [1, 3, YOLO_INPUT, YOLO_INPUT]) }))[session.outputNames[0]];
  const [, attrs, anchors] = out.dims;
  const d = out.data;
  const people = [];
  for (let a = 0; a < anchors; a++) {
    const score = d[4 * anchors + a]; // class 0 = person
    let best = true;
    for (let c = 1; c < attrs - 4 && best; c++) if (d[(4 + c) * anchors + a] > score) best = false;
    if (!best || score < YOLO_MIN_CONF) continue;
    const cx = d[a], cy = d[anchors + a], w = d[2 * anchors + a], h = d[3 * anchors + a];
    people.push({ bbox: [(cx - w / 2 - padX) / scale, (cy - h / 2 - padY) / scale, w / scale, h / scale], confidence: score });
  }
  // greedy NMS
  people.sort((p, q) => q.confidence - p.confidence);
  const kept = [];
  for (const p of people) if (kept.every((k) => iou(k.bbox, p.bbox) < 0.45)) kept.push(p);
  return kept;
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

// Returns the masked PNG plus a manifest of what was masked (types and boxes, never values).
async function redactScreen(png) {
  const t0 = performance.now();
  const { width, height } = await sharp(png).metadata();

  const [[ocrResult, ocrMs], [people, yoloMs]] = await Promise.all([
    timed(async () => (await (await ocr()).recognize(png)).data),
    timed(() => detectPeople(png, width, height).catch(() => [])),
  ]);
  const words = (ocrResult.words || []).map((w) => ({
    text: w.text,
    bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0],
    confidence: w.confidence / 100,
  }));
  const joined = words.map((w) => w.text).join(" ");

  const manifest = [];
  for (const m of findPii(joined)) {
    const hit = wordsForSpan(words, joined, m.start, m.end);
    if (hit.length) manifest.push({ type: m.type.toLowerCase(), bbox: unionBox(hit.map((w) => w.bbox)), confidence: 0.9, source: "ocr+regex" });
  }

  const [entities, nerMs] = await timed(async () => {
    if (!joined.trim()) return [];
    try {
      return await (await ner())(joined);
    } catch {
      return []; // NER is an extra signal; regex + YOLO already covered the hard types
    }
  });
  for (const e of entities) {
    if (!String(e.entity || "").includes("PER") || e.score < NER_MIN_CONF) continue;
    const word = String(e.word || "").replace(/^##/, "");
    const target = words.find((w) => w.text.includes(word) && word.length > 1);
    if (target) manifest.push({ type: "person_name", bbox: target.bbox, confidence: e.score, source: "ocr+ner" });
  }
  for (const p of people) manifest.push({ type: "person", bbox: p.bbox, confidence: p.confidence, source: "yolo" });

  // NER reports word pieces ("Rah", "##ul") that land on the same OCR word: keep one box each.
  const seen = new Set();
  const unique = manifest.filter((m) => {
    const key = `${m.type}:${m.bbox.map(Math.round).join(",")}`;
    return seen.has(key) ? false : seen.add(key);
  });

  const pad = 3;
  const rects = unique
    .map(({ bbox: [x, y, w, h] }) => `<rect x="${Math.max(0, x - pad)}" y="${Math.max(0, y - pad)}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="#000"/>`)
    .join("");
  const masked = await sharp(png)
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return {
    masked,
    width,
    height,
    manifest: unique.map(({ type, bbox, confidence }) => ({ type, bbox: bbox.map(Math.round), confidence: Number(confidence.toFixed(2)) })),
    timings: { ocrMs, yoloMs, nerMs, totalMs: performance.now() - t0 },
  };
}

// Tesseract runs in a worker thread that keeps the process alive; release it on quit / in tests.
async function shutdown() {
  if (cache.ocr) await (await cache.ocr).terminate().catch(() => undefined);
  delete cache.ocr;
}

module.exports = { redactScreen, transcribe, shutdown, modelsAvailable, MODELS_ROOT };
