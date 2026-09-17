import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type { BBox } from "../types";

export interface FaceDetection {
  bbox: BBox;
  confidence: number;
}

let detectorPromise: Promise<FaceDetector> | null = null;

async function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      // Both the wasm runtime and the model weights are bundled locally (public/mediapipe-wasm/,
      // public/blazeface/) -- no CDN or Google Storage fetch at runtime, works fully offline.
      const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("mediapipe-wasm"));
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL("blazeface/blaze_face_short_range.tflite"),
          delegate: "GPU"
        },
        runningMode: "IMAGE"
      });
    })();
  }
  return detectorPromise;
}

export async function detectFaces(image: ImageBitmap | HTMLCanvasElement): Promise<FaceDetection[]> {
  const detector = await getDetector();
  const result = detector.detect(image as any);
  return (result.detections ?? []).map((d) => {
    const box = d.boundingBox;
    const score = d.categories?.[0]?.score ?? 0.5;
    return {
      bbox: [box?.originX ?? 0, box?.originY ?? 0, box?.width ?? 0, box?.height ?? 0] as BBox,
      confidence: score
    };
  });
}
