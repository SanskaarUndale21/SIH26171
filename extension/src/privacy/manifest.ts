import type { DomFieldInfo, DomSnapshot, InteractiveElementSummary, RedactionEntry, RiskTier, StructuredSummary } from "../types";

const MAX_INTERACTIVE_ELEMENTS = 40;

// A field's selector, tag, and label (placeholder/button text -- never its value) are
// structural pointers, not PII: knowing that "#password" exists and is a password field
// reveals nothing about what's actually typed into it. Without this, the planner has no real
// selectors to target at all -- only a sanitized image -- and it was observed inventing
// plausible-looking selectors (e.g. "button[class*='menu']") that match nothing on the real
// page, which is indistinguishable from a flaky click until you trace it back to this gap.
function toInteractiveElement(field: DomFieldInfo): InteractiveElementSummary {
  return {
    selector: field.selector,
    tag: field.tag,
    label: field.placeholder ?? field.name ?? null,
    isSubmit: field.isSubmit
  };
}

export function buildStructuredSummary(dom: DomSnapshot, redactionEntries: RedactionEntry[]): StructuredSummary {
  const submitField = dom.fields.find((f) => f.isSubmit);
  return {
    fields: dom.fields.filter((f) => !f.isSubmit).length,
    submit_button: submitField?.placeholder ?? (submitField ? submitField.selector : null),
    detected_via: dom.fields.length > 0 ? "dom" : "vision",
    interactive_elements: dom.fields.slice(0, MAX_INTERACTIVE_ELEMENTS).map(toInteractiveElement)
  };
}

const HIGH_RISK_PATTERN = /submit|pay|payment|delete|confirm|purchase|checkout|transfer/i;

export function classifyRiskTier(summary: StructuredSummary, taskGoal: string): RiskTier {
  const haystack = `${summary.submit_button ?? ""} ${taskGoal}`;
  return HIGH_RISK_PATTERN.test(haystack) ? "high_risk" : "routine";
}
