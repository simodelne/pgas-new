# UAT Prompt Template Convention

Future UAT prompts must start with an intent-verification block that asks:

1. What is the user-facing behavior being changed?
2. What was that behavior before?
3. What evidence proves the new behavior matches intent?
4. What would prove this is a regression?

The working template lives at `.uat/uat-prompt-template.md`. The `.uat/`
directory is intentionally local and gitignored for transcript and handoff
artifacts, so this tracked companion document records the convention for future
contributors.
