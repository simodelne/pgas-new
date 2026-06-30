# SOTA Scorecard holdout-firm

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 0.9091
- task success rate: 0.9091
- holdout: 5/6
- dev: 5/5

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | yes |  | 1 | 17418 |
| brief-summarizer | dev | yes |  | 0 | 2368 |
| crm-mock-lookup | dev | yes |  | 2 | 36293 |
| fee-calculator | dev | yes |  | 1 | 20488 |
| proposal-ops-stateful | dev | yes |  | 2 | 31168 |
| refund-ledger-stateful | holdout | no | hardfail-exhausted | 4 | 49029 |
| release-note-extractor | holdout | yes |  | 0 | 2139 |
| risk-router | dev | yes |  | 2 | 41314 |
| sla-policy-refusal | holdout | yes |  | 1 | 17728 |
| usage-invoice-calculator | holdout | yes |  | 1 | 19261 |
| warehouse-mock-reservation | holdout | yes |  | 2 | 33111 |
