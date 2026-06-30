# Credit Memo Stateful Rubric

- Keeps invoice normalization separate from credit decisions.
- Carries calculated credit_cents and reason_code into memo_posting without recomputing from the original request.
- Rejects outputs that break cross-stage amount or reason preservation.
