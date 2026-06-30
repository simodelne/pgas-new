# SOTA Scorecard close-gap

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 0.9231
- task success rate: 0.9231
- holdout: 7/8
- dev: 5/5

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | yes |  | 1 | 17443 |
| brief-summarizer | dev | yes |  | 0 | 2377 |
| credit-memo-stateful | holdout | yes |  | 3 | 48943 |
| crm-mock-lookup | dev | yes |  | 2 | 39979 |
| entitlement-seat-stateful | holdout | yes |  | 3 | 49744 |
| fee-calculator | dev | yes |  | 1 | 22545 |
| proposal-ops-stateful | dev | yes |  | 2 | 35062 |
| refund-ledger-stateful | holdout | no | smoke | 3 | 62350 |
| release-note-extractor | holdout | yes |  | 0 | 2260 |
| risk-router | dev | yes |  | 2 | 69511 |
| sla-policy-refusal | holdout | yes |  | 1 | 32038 |
| usage-invoice-calculator | holdout | yes |  | 1 | 26267 |
| warehouse-mock-reservation | holdout | yes |  | 2 | 31752 |
