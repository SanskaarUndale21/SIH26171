import * as ort from "onnxruntime-web";
import type { BBox } from "../types";
import { COCO_CLASSES } from "./cocoClasses";

// Real Ultralytics YOLOv8n weights (COCO-pretrained), exported to ONNX. Transformers.js's
// pipeline()/AutoModel abstraction only knows how to run architectures it has JS-side
// pre/post-processing for (DETR, RT-DETR, YOLOS, ...) -- raw Ultralytics YOLOv8 is not one
// of them, so this runs the model directly on the onnxruntime-web runtime that
// Transformers.js itself ships, with the letterbox/NMS decode YOLOv8 needs.
//
// Note: this is a COCO-pretrained general object detector (person, laptop, book, ...), not
// a UI-element detector -- there is no small, freely-licensed "button/input-field" YOLO
// checkpoint on the hub. It is used here as a supplementary visual signal (e.g. spotting a
// photographed person adjacent to a face crop); DOM introspection remains the primary and
// authoritative source for form-field/button detection, and Florence-2 dense captioning
// (florence.ts) is the vision-only fallback for open-vocabulary element description.
const MODEL_URL = "https://huggingface.co/webnn/yolov8n/resolve/main/onnx/model_fp16.onnx";
const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.4;
const IOU_THRESHOLD = 0.45;

export interface YoloDetection {
  label: string;
  bbox: BBox;
  confidence: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("assets/");
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"]
    });
  }
  return sessionPromise;
}

interface Letterbox {
  tensor: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

function letterboxImage(image: ImageBitmap): Letterbox {
  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  const scale = Math.min(INPUT_SIZE / image.width, INPUT_SIZE / image.height);
  const drawW = Math.round(image.width * scale);
  const drawH = Math.round(image.height * scale);
  const padX = Math.floor((INPUT_SIZE - drawW) / 2);
  const padY = Math.floor((INPUT_SIZE - drawH) / 2);
  ctx.drawImage(image, padX, padY, drawW, drawH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255; // R
    chw[plane + i] = data[i * 4 + 1] / 255; // G
    chw[2 * plane + i] = data[i * 4 + 2] / 255; // B
  }

  return { tensor: chw, scale, padX, padY };
}

function iou(a: BBox, b: BBox): number {
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

function nms(detections: YoloDetection[]): YoloDetection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: YoloDetection[] = [];
  for (const d of sorted) {
    if (kept.every((k) => k.label !== d.label || iou(k.bbox, d.bbox) < IOU_THRESHOLD)) {
      kept.push(d);
    }
  }
  return kept;
}

// Decodes YOLOv8's raw [1, 84, 8400] output (4 box coords + 80 class scores per anchor,
// no objectness column) back into image-space boxes, undoing the letterbox transform.
function decodeOutput(output: ort.Tensor, letterbox: Letterbox): YoloDetection[] {
  const [, numAttrs, numAnchors] = output.dims as [number, number, number];
  const data = output.data as Float32Array;
  const numClasses = numAttrs - 4;
  const detections: YoloDetection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numAnchors + a];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < CONFIDENCE_THRESHOLD) continue;

    const cx = data[0 * numAnchors + a];
    const cy = data[1 * numAnchors + a];
    const w = data[2 * numAnchors + a];
    const h = data[3 * numAnchors + a];

    const x0 = (cx - w / 2 - letterbox.padX) / letterbox.scale;
    const y0 = (cy - h / 2 - letterbox.padY) / letterbox.scale;
    const boxW = w / letterbox.scale;
    const boxH = h / letterbox.scale;

    detections.push({
      label: COCO_CLASSES[bestClass] ?? "object",
      confidence: bestScore,
      bbox: [x0, y0, boxW, boxH]
    });
  }

  return nms(detections);
}

export async function detectElements(imageBitmap: ImageBitmap): Promise<YoloDetection[]> {
  const session = await getSession();
  const letterbox = letterboxImage(imageBitmap);
  const inputTensor = new ort.Tensor("float32", letterbox.tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const results = await session.run({ [inputName]: inputTensor });
  return decodeOutput(results[outputName], letterbox);
}
