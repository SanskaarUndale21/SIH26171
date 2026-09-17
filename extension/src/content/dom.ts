import type { BBox, DomFieldInfo, DomSnapshot } from "../types";

const SENSITIVE_INPUT_TYPES = new Set(["password", "email", "tel"]);

function cssSelectorFor(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const path: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 6) {
    let selector = node.tagName.toLowerCase();
    if (node.parentElement) {
      const siblings = Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    path.unshift(selector);
    node = node.parentElement;
  }
  return path.join(" > ");
}

function toBBox(el: Element): BBox {
  const r = el.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
}

function looksLikeCardField(el: HTMLElement): boolean {
  const haystack = `${(el as HTMLInputElement).name ?? ""} ${el.id} ${
    (el as HTMLInputElement).placeholder ?? ""
  } ${el.getAttribute("autocomplete") ?? ""}`.toLowerCase();
  return /card|cc-number|ccnum|credit/.test(haystack);
}

export function captureDomSnapshot(): DomSnapshot {
  const fields: DomFieldInfo[] = [];

  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, textarea, select");
  for (const el of Array.from(inputs)) {
    if (el.offsetParent === null) continue; // skip hidden fields
    const inputType = el instanceof HTMLInputElement ? el.type : "text";
    fields.push({
      selector: cssSelectorFor(el),
      tag: el.tagName.toLowerCase(),
      inputType: SENSITIVE_INPUT_TYPES.has(inputType) || looksLikeCardField(el as HTMLElement) ? inputType : inputType,
      name: el.getAttribute("name"),
      placeholder: el.getAttribute("placeholder"),
      isSubmit: false,
      bbox: toBBox(el),
      options:
        el instanceof HTMLSelectElement
          ? Array.from(el.options).map((o) => o.textContent?.trim() || o.value)
          : undefined
    });
  }

  const buttons = document.querySelectorAll<HTMLElement>(
    'button, input[type="submit"], input[type="button"], [role="button"]'
  );
  for (const el of Array.from(buttons)) {
    if (el.offsetParent === null) continue;
    const isSubmit =
      (el as HTMLButtonElement).type === "submit" ||
      /submit|register|sign up|continue|confirm/i.test(el.textContent ?? "");
    fields.push({
      selector: cssSelectorFor(el),
      tag: el.tagName.toLowerCase(),
      inputType: null,
      name: el.getAttribute("name"),
      placeholder: (el.textContent ?? "").trim().slice(0, 40) || null,
      isSubmit,
      bbox: toBBox(el)
    });
  }

  return { fields, devicePixelRatio: window.devicePixelRatio || 1 };
}
