import type { RedactionEntry } from "../types";

// Demo/audit feature: paints the redaction manifest directly on the real page, over the
// real fields, so a viewer can SEE what got protected without opening devtools. This is
// purely visual and non-destructive -- it never touches the underlying DOM values, and it
// is drawn from the same manifest that was sent to the server, so what you see here is
// exactly what left the browser blacked out.
const OVERLAY_CONTAINER_ID = "__fusion_privacy_overlay__";
const AUTO_CLEAR_MS = 4000;
let clearTimer: number | null = null;

const LABEL_COLOR: Record<string, string> = {
  password_field: "#e11d48",
  card_number: "#e11d48",
  email: "#f59e0b",
  phone_number: "#f59e0b",
  face: "#7c3aed",
  person_name: "#7c3aed"
};

export function showRedactionOverlay(manifest: RedactionEntry[]): void {
  clearRedactionOverlay();

  const container = document.createElement("div");
  container.id = OVERLAY_CONTAINER_ID;
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = "2147483647";

  const scale = window.devicePixelRatio || 1;

  for (const entry of manifest) {
    const [x, y, w, h] = entry.bbox;
    const box = document.createElement("div");
    const color = LABEL_COLOR[entry.type] ?? "#dc2626";
    box.style.position = "absolute";
    box.style.left = `${x / scale}px`;
    box.style.top = `${y / scale}px`;
    box.style.width = `${w / scale}px`;
    box.style.height = `${h / scale}px`;
    box.style.border = `2px solid ${color}`;
    box.style.background = `${color}33`;
    box.style.borderRadius = "3px";
    box.style.boxSizing = "border-box";

    const label = document.createElement("span");
    label.textContent = `${entry.type} · ${(entry.confidence * 100).toFixed(0)}%`;
    label.style.position = "absolute";
    label.style.top = "-18px";
    label.style.left = "0";
    label.style.fontSize = "11px";
    label.style.fontFamily = "monospace";
    label.style.background = color;
    label.style.color = "#fff";
    label.style.padding = "1px 4px";
    label.style.borderRadius = "2px";
    label.style.whiteSpace = "nowrap";

    box.appendChild(label);
    container.appendChild(box);
  }

  document.documentElement.appendChild(container);
  clearTimer = window.setTimeout(clearRedactionOverlay, AUTO_CLEAR_MS);
}

export function clearRedactionOverlay(): void {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
  document.getElementById(OVERLAY_CONTAINER_ID)?.remove();
}
