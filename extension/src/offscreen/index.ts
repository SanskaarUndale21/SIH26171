import { runPerception } from "../perception";
import { fuseForRedaction } from "../privacy/fuse";
import { redactImage } from "../privacy/redact";
import { buildStructuredSummary, classifyRiskTier } from "../privacy/manifest";
import type { BuildContextOffscreenMessage, BuildContextResponse, ExtensionMessage } from "../messages";
import type { ContextTimings, NextActionRequest } from "../types";

// Runs entirely inside the offscreen document's own chrome-extension:// origin, under this
// extension's manifest CSP -- not the host page's. That's the whole point of this file
// existing separately from content/index.ts: onnxruntime-web and Tesseract.js need to spawn
// Workers and call importScripts, which a host page's Trusted Types policy can block if this
// ran inside the content script instead.
async function dataUrlToCanvasAndBitmap(dataUrl: string): Promise<{ canvas: HTMLCanvasElement; bitmap: ImageBitmap }> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return { canvas, bitmap };
}

// performance.memory is Chrome-only and non-standard, hence the cast; null elsewhere.
function heapMB(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : null;
}

async function buildContext(
  message: BuildContextOffscreenMessage
): Promise<{ payload: NextActionRequest; timings: ContextTimings }> {
  const { screenshotDataUrl, domSnapshot, taskGoal } = message;
  const t0 = performance.now();
  const { canvas, bitmap } = await dataUrlToCanvasAndBitmap(screenshotDataUrl);
  const t1 = performance.now();

  const perception = await runPerception({ imageUrl: screenshotDataUrl, canvas, imageBitmap: bitmap });
  const t2 = performance.now();
  const redactionManifest = fuseForRedaction(domSnapshot, perception.regions);
  const t3 = performance.now();
  const sanitizedImage = redactImage(canvas, redactionManifest);
  const t4 = performance.now();
  const structuredSummary = buildStructuredSummary(domSnapshot, redactionManifest);
  const riskTier = classifyRiskTier(structuredSummary, taskGoal);

  // Proof that PII never leaves the browser unredacted: log the exact outgoing payload.
  console.log("[privacy-agent/offscreen] outgoing payload (sanitized_image omitted from log)", {
    task_goal: taskGoal,
    redaction_manifest: redactionManifest,
    structured_summary: structuredSummary,
    risk_tier: riskTier
  });

  return {
    payload: {
      task_goal: taskGoal,
      sanitized_image: sanitizedImage,
      redaction_manifest: redactionManifest,
      structured_summary: structuredSummary,
      risk_tier: riskTier
    },
    timings: {
      decodeMs: t1 - t0,
      perceptionMs: t2 - t1,
      fuseMs: t3 - t2,
      redactMs: t4 - t3,
      totalMs: performance.now() - t0,
      detectors: perception.timings,
      heapMB: heapMB(),
      webgpu: "gpu" in navigator
    }
  };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "BUILD_CONTEXT_OFFSCREEN") {
    buildContext(message)
      .then(({ payload, timings }) => sendResponse({ ok: true, payload, timings } satisfies BuildContextResponse))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  return false;
});
