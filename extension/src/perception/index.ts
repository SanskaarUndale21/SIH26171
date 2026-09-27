import "./env-setup";
import type { BBox, DetectedRegion, DetectorTimings } from "../types";
import { runOcr, type OcrWord } from "./ocr";
import { findPii } from "./regex";
import { findNamedEntities } from "./ner";
import { detectFaces } from "./blazeface";
import { detectElements } from "./yolo";
import { groundElements } from "./florence";

function unionBBox(boxes: BBox[]): BBox {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

// Reconstruct which OCR words a regex/NER match (over the concatenated word text) spans,
// so a text-level PII hit can be turned into a pixel-space bbox for redaction.
function wordsForSpan(words: OcrWord[], joinedText: string, start: number, end: number): OcrWord[] {
  const hit: OcrWord[] = [];
  let cursor = 0;
  for (const w of words) {
    const wStart = joinedText.indexOf(w.text, cursor);
    if (wStart === -1) continue;
    const wEnd = wStart + w.text.length;
    if (wStart < end && wEnd > start) hit.push(w);
    cursor = wEnd;
  }
  return hit;
}

export interface PerceptionResult {
  regions: DetectedRegion[];
  ocrFullText: string;
  timings: DetectorTimings;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

export interface PerceptionInputs {
  imageUrl: string; // data URL of the full-page screenshot
  canvas: HTMLCanvasElement; // same image, decoded, for BlazeFace
  imageBitmap: ImageBitmap;
}

// Runs the full on-device perception stack over one screenshot. This is a single
// coordinated pass, not independent agents: each detector's output only feeds the
// shared region list that privacy/redact.ts and privacy/manifest.ts consume next.
export async function runPerception(inputs: PerceptionInputs): Promise<PerceptionResult> {
  const regions: DetectedRegion[] = [];

  const [[ocr, ocrMs], [faces, facesMs], [elements, yoloMs]] = await Promise.all([
    timed(() => runOcr(inputs.imageUrl)),
    timed(() => detectFaces(inputs.imageBitmap).catch(() => [])),
    timed(() => detectElements(inputs.imageBitmap).catch(() => []))
  ]);

  for (const f of faces) {
    regions.push({ label: "face", bbox: f.bbox, confidence: f.confidence, source: "blazeface" });
  }

  for (const el of elements) {
    regions.push({ label: el.label, bbox: el.bbox, confidence: el.confidence, source: "yolo" });
  }

  const tFlorence = performance.now();
  try {
    const grounded = await groundElements(inputs.imageUrl);
    for (const g of grounded) {
      regions.push({ label: g.label, bbox: g.bbox, confidence: 0.5, source: "florence" });
    }
  } catch {
    // Florence-2 is a heavier fallback pass; degrade gracefully if unavailable.
  }
  const florenceMs = performance.now() - tFlorence;

  const joinedText = ocr.words.map((w) => w.text).join(" ");
  const piiMatches = findPii(ocr.fullText || joinedText);
  for (const m of piiMatches) {
    const hitWords = wordsForSpan(ocr.words, joinedText, m.start, m.end);
    if (hitWords.length === 0) continue;
    regions.push({
      label: m.type,
      bbox: unionBBox(hitWords.map((w) => w.bbox)),
      confidence: Math.min(...hitWords.map((w) => w.confidence || 0.6)),
      source: "ocr+regex"
    });
  }

  const tNer = performance.now();
  try {
    const entities = await findNamedEntities(ocr.fullText || joinedText);
    for (const e of entities) {
      const hitWords = wordsForSpan(ocr.words, joinedText, e.start, e.end);
      if (hitWords.length === 0) continue;
      regions.push({
        label: "person_name",
        bbox: unionBBox(hitWords.map((w) => w.bbox)),
        confidence: e.confidence,
        source: "ocr+ner"
      });
    }
  } catch {
    // NER is best-effort; regex + DOM fusion already cover the hard PII types.
  }

  const nerMs = performance.now() - tNer;

  return { regions, ocrFullText: ocr.fullText, timings: { ocrMs, facesMs, yoloMs, florenceMs, nerMs } };
}
