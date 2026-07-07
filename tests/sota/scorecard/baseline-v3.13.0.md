# SOTA Scorecard sota-2026-07-07T11-40-30-075Z

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 0.8462
- task success rate: 0.8462
- holdout: 7/8
- dev: 4/5

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | yes |  | 3 | 54543 |
| brief-summarizer | dev | yes |  | 2 | 47283 |
| credit-memo-stateful | holdout | yes |  | 4 | 60787 |
| crm-mock-lookup | dev | yes |  | 3 | 49371 |
| entitlement-seat-stateful | holdout | yes |  | 4 | 63791 |
| fee-calculator | dev | yes |  | 2 | 39416 |
| proposal-ops-stateful | dev | no | functional-oracle | 4 | 72604 |
| refund-ledger-stateful | holdout | no | functional-oracle | 7 | 113508 |
| release-note-extractor | holdout | yes |  | 2 | 39633 |
| risk-router | dev | yes |  | 4 | 74383 |
| sla-policy-refusal | holdout | yes |  | 3 | 44998 |
| usage-invoice-calculator | holdout | yes |  | 3 | 58461 |
| warehouse-mock-reservation | holdout | yes |  | 3 | 46091 |
