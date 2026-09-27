import { createWorker, type Worker } from "tesseract.js";
import type { BBox } from "../types";

export interface OcrWord {
  text: string;
  bbox: BBox;
  confidence: number;
}

export interface OcrResult {
  fullText: string;
  words: OcrWord[];
}

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // The extension's own CSP (script-src 'self') blocks Tesseract's default behavior of
    // fetching its worker/core scripts from a CDN via importScripts -- confirmed by a real
    // "importScripts ... failed to load" error against cdn.jsdelivr.net. Pointing it at
    // copies bundled under public/tesseract/ keeps everything same-origin, and also means
    // this keeps working with no network access once the extension is installed.
    // langPath too: without it Tesseract downloads eng.traineddata from jsdelivr on first use,
    // the one network fetch left in the perception stack. The bundled file is the same
    // 4.0.0_best_int data (LSTM-only, matching OEM 1) Tesseract would have fetched.
    workerPromise = createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("tesseract/tesseract-core-simd-lstm.wasm.js"),
      langPath: chrome.runtime.getURL("tesseract/lang"),
      workerBlobURL: false
    });
  }
  return workerPromise;
}

export async function runOcr(imageSource: string | HTMLCanvasElement): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageSource);
  const words: OcrWord[] = (data.words ?? []).map((w) => ({
    text: w.text,
    bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0],
    confidence: w.confidence / 100
  }));
  return { fullText: data.text, words };
}

export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}
