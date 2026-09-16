import { runPerception } from "../perception";
import { fuseForRedaction } from "../privacy/fuse";
import { redactImage } from "../privacy/redact";
import { buildStructuredSummary, classifyRiskTier } from "../privacy/manifest";
import type { BuildContextOffscreenMessage, BuildContextResponse, ExtensionMessage } from "../messages";
import type { NextActionRequest } from "../types";

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

async function buildContext(message: BuildContextOffscreenMessage): Promise<NextActionRequest> {
  const { screenshotDataUrl, domSnapshot, taskGoal } = message;
  const { canvas, bitmap } = await dataUrlToCanvasAndBitmap(screenshotDataUrl);

  const perception = await runPerception({ imageUrl: screenshotDataUrl, canvas, imageBitmap: bitmap });
  const redactionManifest = fuseForRedaction(domSnapshot, perception.regions);
  const sanitizedImage = redactImage(canvas, redactionManifest);
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
    task_goal: taskGoal,
    sanitized_image: sanitizedImage,
    redaction_manifest: redactionManifest,
    structured_summary: structuredSummary,
    risk_tier: riskTier
  };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "BUILD_CONTEXT_OFFSCREEN") {
    buildContext(message)
      .then((payload) => sendResponse({ ok: true, payload } satisfies BuildContextResponse))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  return false;
});
