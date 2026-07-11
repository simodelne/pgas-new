# SOTA Scorecard sota-2026-07-11T02-28-30-359Z

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 1
- task success rate: 1
- holdout: 8/8
- dev: 5/5

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | yes |  | 3 | 43151 |
| brief-summarizer | dev | yes |  | 2 | 32210 |
| credit-memo-stateful | holdout | yes |  | 4 | 63815 |
| crm-mock-lookup | dev | yes |  | 3 | 49809 |
| entitlement-seat-stateful | holdout | yes |  | 4 | 63499 |
| fee-calculator | dev | yes |  | 2 | 38154 |
| proposal-ops-stateful | dev | yes |  | 4 | 68357 |
| refund-ledger-stateful | holdout | yes |  | 5 | 78600 |
| release-note-extractor | holdout | yes |  | 2 | 39823 |
| risk-router | dev | yes |  | 4 | 74624 |
| sla-policy-refusal | holdout | yes |  | 3 | 44968 |
| usage-invoice-calculator | holdout | yes |  | 3 | 58846 |
| warehouse-mock-reservation | holdout | yes |  | 3 | 45679 |
