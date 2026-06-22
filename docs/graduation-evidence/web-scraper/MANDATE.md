# Mandate — web-scraper

This MANDATE captures what v3.0's `synthesize_program_spec` action should produce when given this intake. The artifacts in this directory are the frozen v2.x baseline used for regression testing.

## Q1 Purpose
Scrape an ethical legal corpus under hard network, robots, terms, rate-limit, privacy, and single-asset verification guardrails.

## Q2 Entry channel
user_text

## Q3 Stages
1. intake — Collect scraping objective, jurisdiction, target legal domain, allowed source classes, user constraints, privacy/anonymity requirements, and maximum network budget.
2. intelligence — Use web_search_sources to identify candidate official/public sources without fetching target sites directly.
3. egress_verification — Confirm the egress IP of the actual request stack before any target-site call and halt if unverifiable.
4. web_analysis — Analyze candidate website structure within the analysis call budget and halt on captcha, login wall, paywall, bot prohibition, robots disallow, or legal uncertainty.
5. strategy_review — Propose a scraping strategy and obtain explicit user approval before any scrape.
6. scraping — Fetch exactly one asset per action, never parallelize, and verify before the next fetch.
7. asset_verification — Verify the fetched asset and append it to the durable ledger.
8. complete — Report completion and the ledger location.
9. blocked — Report the precise block reason and the next user action required without bypass attempts.

## Q4 Decision points
- intake → intelligence when intake.complete = true
- intelligence → egress_verification when intelligence.complete = true
- egress_verification → web_analysis when egress.confirmed = true
- egress_verification → blocked when run.block_reason = true
- web_analysis → strategy_review when analysis.complete = true
- web_analysis → blocked when analysis.halt_reason = true
- strategy_review → scraping when strategy.user_approved = true
- strategy_review → blocked when run.block_reason = true
- scraping → asset_verification when scraping.last_asset_id = true
- asset_verification → scraping when scraping.last_asset_verified = true
- asset_verification → complete when scraping.budget_exhausted = true
- asset_verification → blocked when verification.requires_user_decision = true

## Q5 Delegation
none

## Q6 Completion criteria
- Terminal mode: complete
- Guard: scraping.budget_exhausted = true
