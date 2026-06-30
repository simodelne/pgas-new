# SOTA Scorecard first-qwen-2026-06-29

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 0
- task success rate: 0
- holdout: 0/2
- dev: 0/4

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | no | functional-oracle | 2 | 30162 |
| brief-summarizer | dev | no | typecheck | 0 | 1018 |
| crm-mock-lookup | dev | no | functional-oracle | 4 | 45249 |
| fee-calculator | dev | no | functional-oracle | 2 | 36884 |
| proposal-ops-stateful | dev | no | functional-oracle | 3 | 63384 |
| risk-router | holdout | no | functional-oracle | 4 | 86090 |
