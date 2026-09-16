import type { ActionTarget, ActionType } from "../types";

function elementAtBBox(bbox: [number, number, number, number]): Element | null {
  const [x, y, w, h] = bbox;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return document.elementFromPoint(cx, cy);
}

function resolveTarget(target: ActionTarget): Element | null {
  if (target.selector) {
    const el = document.querySelector(target.selector);
    if (el) return el;
  }
  if (target.bbox && target.bbox.some((v) => v !== 0)) {
    return elementAtBBox(target.bbox);
  }
  return null;
}

export function executeAction(action: ActionType, target: ActionTarget, value: string | null): boolean {
  if (action === "none") return true;

  if (action === "scroll") {
    window.scrollBy({ top: value ? Number(value) : window.innerHeight * 0.8, behavior: "smooth" });
    return true;
  }

  const el = resolveTarget(target);
  if (!el) return false;

  if (action === "click") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).click();
    return true;
  }

  if (action === "type") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter?.call(el, value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  return false;
}
