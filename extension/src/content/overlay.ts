import type { RedactionEntry } from "../types";

// Demo/audit feature: paints the redaction manifest on the real page, over the real fields,
// so anyone watching SEES what the server received blacked out. Purely visual: it never
// touches the page's values, and it is drawn from the same manifest that was sent, so what
// shows here is exactly what left the browser masked. Rendered in a closed shadow root so the
// host page's CSS can't restyle it.
const OVERLAY_HOST_ID = "__fusion_privacy_overlay__";
const SHOW_MS = 4500;
let clearTimer: number | null = null;

const TYPE_NAMES: Record<string, string> = {
  password_field: "password",
  card_number: "card",
  phone_number: "phone",
  person_name: "name",
  date_of_birth: "birth date",
  bank_account: "account no.",
  ip_address: "ip address"
};

const STYLE = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; pointer-events: none; }
  .bar {
    position: absolute; box-sizing: border-box;
    background: #000; border-radius: 2px;
    display: flex; align-items: center; overflow: hidden;
    transform-origin: left center;
    animation: wipe 380ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  .bar.weak { background: repeating-linear-gradient(135deg, #000 0 7px, #2a2f3a 7px 9px); }
  .bar span {
    font: 600 11px/1 "Segoe UI", system-ui, sans-serif;
    color: #fff; padding: 0 6px; white-space: nowrap;
  }
  .count {
    position: fixed; right: 16px; bottom: 76px;
    font: 600 12px/1.3 "Segoe UI", system-ui, sans-serif;
    background: #000; color: #fff; padding: 8px 12px; border-radius: 10px;
    animation: rise 300ms ease-out both;
  }
  .count b { color: #b8b7ff; font-weight: 700; }
  @keyframes wipe { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .bar, .count { animation: none; } }
`;

export function showRedactionOverlay(manifest: RedactionEntry[]): void {
  clearRedactionOverlay();
  if (!manifest.length) return;

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.appendChild(style);

  const layer = document.createElement("div");
  layer.className = "layer";
  const scale = window.devicePixelRatio || 1;

  manifest.forEach((entry, i) => {
    const [x, y, w, h] = entry.bbox;
    const bar = document.createElement("div");
    bar.className = entry.confidence < 0.5 ? "bar weak" : "bar";
    bar.style.left = `${x / scale}px`;
    bar.style.top = `${y / scale}px`;
    bar.style.width = `${w / scale}px`;
    bar.style.height = `${h / scale}px`;
    bar.style.animationDelay = `${Math.min(i * 40, 600)}ms`;
    const label = document.createElement("span");
    label.textContent = TYPE_NAMES[entry.type] ?? entry.type.replace(/_/g, " ");
    bar.title = `${label.textContent}, ${(entry.confidence * 100).toFixed(0)}% confidence`;
    bar.appendChild(label);
    layer.appendChild(bar);
  });

  const count = document.createElement("div");
  count.className = "count";
  const n = document.createElement("b");
  n.textContent = String(manifest.length);
  count.append(n, manifest.length === 1 ? " region masked before sending" : " regions masked before sending");

  root.append(layer, count);
  document.documentElement.appendChild(host);
  clearTimer = window.setTimeout(clearRedactionOverlay, SHOW_MS);
}

export function clearRedactionOverlay(): void {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
  document.getElementById(OVERLAY_HOST_ID)?.remove();
}
