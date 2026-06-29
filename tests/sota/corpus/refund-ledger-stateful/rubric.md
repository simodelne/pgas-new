# Refund Ledger Stateful Rubric

- Keeps normalized order state separate from policy decisions.
- Carries refund_cents and policy_code forward into ledger_posting without recomputing inconsistently.
- Rejects outputs that break cross-stage state dependencies.
