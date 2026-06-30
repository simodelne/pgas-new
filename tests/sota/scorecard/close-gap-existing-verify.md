# SOTA Scorecard close-gap-existing-verify

- Model: qwen36-27b
- Provider: http://100.100.74.6:8000/v1
- pass@1: 1
- task success rate: 1
- holdout: 6/6
- dev: 5/5

| Benchmark | Split | Passed | Failure | Attempts | Latency ms |
|---|---:|---:|---|---:|---:|
| ambiguous-policy-refusal | holdout | yes |  | 0 | 2186 |
| brief-summarizer | dev | yes |  | 0 | 1691 |
| crm-mock-lookup | dev | yes |  | 0 | 2285 |
| fee-calculator | dev | yes |  | 0 | 1839 |
| proposal-ops-stateful | dev | yes |  | 0 | 2272 |
| refund-ledger-stateful | holdout | yes |  | 0 | 2404 |
| release-note-extractor | holdout | yes |  | 0 | 2256 |
| risk-router | dev | yes |  | 0 | 2297 |
| sla-policy-refusal | holdout | yes |  | 0 | 2128 |
| usage-invoice-calculator | holdout | yes |  | 0 | 2302 |
| warehouse-mock-reservation | holdout | yes |  | 0 | 2090 |
