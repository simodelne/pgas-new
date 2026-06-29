# Risk Router Rubric

- Canonical intent: deterministically compute risk_score from severity, enterprise tier, failed-login threshold, and data exposure, then route to owner_queue values security_escalation, risk_review, or standard_ops with items_json shaped exactly as the mandate declares.
- Computes risk deterministically from all provided facts.
- Routes high enterprise or exposure cases to security escalation.
- Preserves the score and queue decision in machine-readable output.
