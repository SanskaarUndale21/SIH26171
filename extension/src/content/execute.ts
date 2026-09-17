import type { ActionTarget, ActionType } from "../types";

export interface ExecuteResult {
  ok: boolean;
  error?: string;
}

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

// A <select> dropdown was silently unhandled here before -- action="type" against one fell
// through every branch to a bare `return false`, with no error message anywhere, which is
// exactly what surfaced live as "action failed: unknown" against a real favorite-color
// dropdown. Matches by option value first, then by visible text, since the planner has no
// reliable way to know which one a given <select> actually uses.
function selectOption(el: HTMLSelectElement, value: string | null): boolean {
  if (!value) return false;
  const target = value.trim().toLowerCase();
  const option = Array.from(el.options).find(
    (o) => o.value.trim().toLowerCase() === target || (o.textContent ?? "").trim().toLowerCase() === target
  );
  if (!option) return false;
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function executeAction(action: ActionType, target: ActionTarget, value: string | null): ExecuteResult {
  if (action === "none") return { ok: true };

  if (action === "scroll") {
    window.scrollBy({ top: value ? Number(value) : window.innerHeight * 0.8, behavior: "smooth" });
    return { ok: true };
  }

  const el = resolveTarget(target);
  if (!el) return { ok: false, error: "no element matched the target selector/bbox" };

  if (action === "click") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).click();
    return { ok: true };
  }

  if (action === "type") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
    (el as HTMLElement).focus();

    if (el instanceof HTMLSelectElement) {
      const ok = selectOption(el, value);
      return ok
        ? { ok: true }
        : { ok: false, error: `no <option> on this <select> matched value "${value}"` };
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter?.call(el, value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    return { ok: false, error: `action="type" is not supported on a <${el.tagName.toLowerCase()}>` };
  }

  return { ok: false, error: `unhandled action "${action}"` };
}
