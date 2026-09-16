import type { DomSnapshot, RedactionEntry, RiskTier, StructuredSummary } from "../types";

export function buildStructuredSummary(dom: DomSnapshot, redactionEntries: RedactionEntry[]): StructuredSummary {
  const submitField = dom.fields.find((f) => f.isSubmit);
  return {
    fields: dom.fields.filter((f) => !f.isSubmit).length,
    submit_button: submitField?.placeholder ?? (submitField ? submitField.selector : null),
    detected_via: dom.fields.length > 0 ? "dom" : "vision"
  };
}

const HIGH_RISK_PATTERN = /submit|pay|payment|delete|confirm|purchase|checkout|transfer/i;

export function classifyRiskTier(summary: StructuredSummary, taskGoal: string): RiskTier {
  const haystack = `${summary.submit_button ?? ""} ${taskGoal}`;
  return HIGH_RISK_PATTERN.test(haystack) ? "high_risk" : "routine";
}
