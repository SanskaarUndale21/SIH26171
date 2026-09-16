import type { RedactionEntry } from "../types";

// Phase 1: solid black-box redaction. Token-level substring redaction is Phase 3.
export function redactImage(canvas: HTMLCanvasElement, manifest: RedactionEntry[]): string {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for redaction");

  ctx.fillStyle = "#000000";
  for (const entry of manifest) {
    const [x, y, w, h] = entry.bbox;
    ctx.fillRect(x, y, w, h);
  }

  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}
