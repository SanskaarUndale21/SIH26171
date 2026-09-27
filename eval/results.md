# Eval results: privacy-preserving browser agent

Generated: 2026-09-27T10:30:12.634Z. Reproduce with `cd eval && npm install && npm run eval`.

Fixture (`eval/fixture.ts`, same ids as `demo/fixture.html`): an Indian scholarship
application with 21 items that must be masked (13 DOM fields, 2 fields only vision can
flag, 6 screen regions such as the photo and PII printed as page text) and 11 that must not
(including "pincode" and "company" traps for the DOM name hints). The vision side is 13
scripted detector outputs (what OCR+regex, OCR+NER and BlazeFace report on that page), fed into
the real fusion and redaction code: true hits, a weak lone face (fail-safe test), a duplicate
pair (fusion test), two false positives DOM evidence should suppress, and two it cannot. Model
accuracy on real screenshots is measured live in the side panel, not here.

## 1. Detection (32 ground-truth items)

| Metric | Result |
|---|---|
| Recall | **100.0%** (21/21) |
| Precision | **91.3%** (21/23) |
| F1 | 95.5% |
| False positives | 2/11 controls |
| Fusion latency | 0.080 ms per page (avg of 200 runs) |

## 2. Redaction precision (pixel level)

| Metric | Result |
|---|---|
| Masked pixels that are sensitive | **92.8%** |
| Sensitive pixels that got masked | **99.1%** |
| Mean IoU of correct masks vs ground truth | 0.988 |

## 3. Text PII detector (25 cases, shared/pii-rules.json)

| Metric | Result |
|---|---|
| Precision | **100.0%** (14/14) |
| Recall | **100.0%** (14/14) |
| Latency | 0.0838 ms per text |

| Type | TP | FN | FP | Precision | Recall |
|---|---|---|---|---|---|
| aadhaar | 2 | 0 | 0 | 100.0% | 100.0% |
| card_number | 2 | 0 | 0 | 100.0% | 100.0% |
| email | 2 | 0 | 0 | 100.0% | 100.0% |
| ip_address | 1 | 0 | 0 | 100.0% | 100.0% |
| pan | 1 | 0 | 0 | 100.0% | 100.0% |
| phone_number | 3 | 0 | 0 | 100.0% | 100.0% |
| secret | 3 | 0 | 0 | 100.0% | 100.0% |

No detector misses or false hits on this corpus.

## Per item

| Item | Kind | Expected | Got | Masked as | IoU |
|---|---|---|---|---|---|
| `#email` | field | mask | masked | email | 1.00 |
| `#password` | field | mask | masked | password_field | 1.00 |
| `#confirm_password` | field | mask | masked | password_field | 1.00 |
| `#mobile` | field | mask | masked | phone_number | 1.00 |
| `#alt_mobile` | field | mask | masked | phone_number | 1.00 |
| `#aadhaar` | field | mask | masked | aadhaar | 1.00 |
| `#pan` | field | mask | masked | pan | 1.00 |
| `#dob` | field | mask | masked | date_of_birth | 1.00 |
| `#bank_account` | field | mask | masked | bank_account | 1.00 |
| `#card` | field | mask | masked | card_number | 1.00 |
| `#cvv` | field | mask | masked | secret | 1.00 |
| `#otp` | field | mask | masked | secret | 1.00 |
| `#address` | field | mask | masked | address | 1.00 |
| `#fullname` | field (vision only) | mask | masked | person_name | 1.00 |
| `#father_name` | field (vision only) | mask | masked | person_name | 1.00 |
| `profile_photo` | screen region | mask | masked | face | 0.91 |
| `thumbnail_face` | screen region | mask | masked | face | 0.87 |
| `printed_mobile` | screen region | mask | masked | phone_number | 0.98 |
| `printed_email` | screen region | mask | masked | email | 0.99 |
| `printed_aadhaar` | screen region | mask | masked | aadhaar | 0.99 |
| `printed_card` | screen region | mask | masked | card_number | 0.99 |
| `#course` | field | keep | kept |  |  |
| `#state` | field | keep | kept |  |  |
| `#category` | field | keep | kept |  |  |
| `#gender` | field | keep | kept |  |  |
| `#college` | field | keep | **MASKED (FP)** |  |  |
| `#percentage` | field | keep | kept |  |  |
| `#pincode` | field | keep | kept |  |  |
| `#company` | field | keep | kept |  |  |
| `#sop` | field | keep | kept |  |  |
| `#search` | field | keep | kept |  |  |
| `state_emblem` | screen region | keep | **MASKED (FP)** |  |  |

## Known limitations shown above

- A plain text input whose content NER mistakes for a person (`#college`, "Vivekananda College")
  is masked: DOM can't prove a text input safe, and the fail-safe prefers over-masking.
- BlazeFace's weak hit on the state emblem is masked for the same reason.
Both cost precision, never privacy. Full manifest and raw numbers: `eval/benchmark_output.json`.
