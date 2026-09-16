# Eval Results — Privacy-Preserving Browser Agent

Generated: 2026-09-16T18:14:28.322Z
Fixture: `eval/fixture.ts` (8 DOM fields: 5 must-redact, 2 control, 1 submit; 5 vision
regions including one deliberately duplicated detection and one deliberately mislocated
false-positive-shaped hit over a control field)

## Redaction precision/recall (privacy/fuse.ts + privacy/confidence.ts, real code, real run)

| Metric | Result |
|---|---|
| Manifest entries produced | 7 |
| True positives (sensitive fields correctly redacted) | 5 / 5 |
| False negatives (sensitive fields missed) | 0 / 5 |
| False positives (control fields wrongly redacted) | 0 / 2 |
| True negatives (control fields correctly left alone) | 2 / 2 |
| Recall | 100.0% |
| Precision | 100.0% |
| Fusion latency (fuseForRedaction call, this machine) | 0.619 ms |

Notes: `#fullname` has no DOM `type` hint and is redacted purely on the vision-side
person_name detection -- this is the one field in the fixture that actually exercises
vision, not just DOM. The duplicate email detections (regex + NER on the same span) are
merged by `fuseVisionConfidence`'s noisy-OR into one higher-confidence entry rather than
two. The phone_number-shaped false-positive region placed over `#bio` is correctly
suppressed because `#bio` is a `<textarea>` -- structurally confirmed non-PII by the DOM,
which overrides the vision guess (see `domSafeBoxes` in fuse.ts).

## Regex PII detector precision/recall (perception/regex.ts, real code, real run)

| Metric | Result |
|---|---|
| Text cases | 4 |
| True positive matches | 3 |
| False negative matches | 0 |
| False positive card matches (Luhn-invalid, must be 0) | 0 |
| Latency (4 cases, this machine) | 0.802 ms |

Full manifest and raw numbers: `eval/benchmark_output.json`.
