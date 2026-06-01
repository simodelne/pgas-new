---
name: pgas:spec-validate
description: Load and validate a consumer's spec.yml using the installed @simodelne/pgas-runtime loadSpec(). Reports unknown-key errors verbatim and flags them as the pgas#235 trap class. Run before staging any spec.yml change, and on every CI run that touches a spec.
---

# pgas:spec-validate

Validate a consumer's `spec.yml` using the installed
`@simodelne/pgas-runtime`'s `loadSpec()` function.

This skill catches the **#235 trap class** — `compileSpecification`
bypasses the strict-keys gate, so a `compileSpecification`-only test
passes locally while real consumers (who go through `loadSpec`) crash
with `Spec compiler check failed: unknown key "..."`. Always use
`loadSpec(yamlPath)`, never the lower-level compiler.

## When to use

- Before staging any change to a `spec.yml` (the plugin's
  `pre-tool-use-spec-validate.sh` hook auto-fires on
  `git commit*` and runs this skill on any staged `spec.yml`).
- On CI for every PR touching `programs/**/*.yml`.
- After bumping `@simodelne/pgas-*` deps — newer engine versions can
  add or remove allowed spec keys.

## Step 1 — locate the spec(s) to validate

If invoked with a path argument, validate that file. Otherwise scan:

```bash
SPECS=$(find programs -type f \( -name "spec.yml" -o -name "specs.yml" \) 2>/dev/null)
if [[ -z "$SPECS" ]]; then
  echo "No spec.yml files found under programs/"
  exit 0
fi
```

## Step 2 — invoke loadSpec()

For each spec file, run the installed engine's `loadSpec()` via a one-liner Node script:

```bash
for spec in $SPECS; do
  echo "--- $spec ---"
  node --input-type=module -e "
    import('@simodelne/pgas-runtime').then(async (m) => {
      try {
        const result = await m.loadSpec('$spec');
        console.log('OK:', '$spec', '— compiled', Object.keys(result.modes).length, 'modes');
        process.exit(0);
      } catch (e) {
        console.error('FAIL:', '$spec');
        console.error('  ', e.message);
        process.exit(1);
      }
    });
  " || EXIT=1
done
exit ${EXIT:-0}
```

If `@simodelne/pgas-runtime` is not installed (no `node_modules/`), abort
with: "Run `npm install` first — the validator needs the installed
runtime." Do NOT try to use a bundled copy — the validation must reflect
what the consumer's actually-installed version accepts.

## Step 3 — classify errors

Inspect the error message. Common error classes:

### Unknown-key error → pgas#235 trap class

```
Spec compiler check failed: unknown key "<KEY>"
```

When you see this, report:

> **pgas#235 trap class** — `loadSpec()` rejects unknown keys that
> `compileSpecification()` would silently accept. Two fixes:
>
> 1. **If the key is intentional** (your spec is ahead of the engine
>    version, e.g. a v1.9 key on a v1.8 runtime): add the key to
>    `pgas-runtime/spec-loader/unknown-keys.ts`'s allowlist. This
>    requires bumping the engine — file a Channel 4 issue on
>    `simodelne/pgas`.
> 2. **If the key is a typo** (the common case): remove or rename the
>    key. The error message names the offending key directly.

### Other validation errors

Report the error verbatim. Common ones:

- `Spec compiler check failed: <SC|FV|IC|RC>-N` — Alloy-aligned static
  check. Read `pgas.als` and `docs/Specifications.md` for the rule.
- `Unknown channel: <name>` — declared a channel in `mode_entry_channels`
  but did not define it in the spec's `channels:` block.
- `Schema path not declared: <path>` — a payload references a path
  not listed under `schema:`. Common FM5 indicator
  (engine-owned `inputs.query_meta.*` paths).

## Step 4 — report

Emit:

```
pgas:spec-validate report
  validated: <N> spec(s)
  pass: <K>
  fail: <N - K>

[for each failure:]
  FAIL: <path>
    error: <message>
    classification: <pgas#235 / SC-N / FM5 / other>
    suggested fix: <one line>
```

Exit 0 if all pass, 1 if any fail. The pre-commit hook depends on this
exit code.

## Step 5 — escape hatches

If a consumer needs to ship a spec.yml that genuinely uses an
allowed-but-not-yet-allowlisted key, the **only** correct path is to
file a `Channel 4` issue on `simodelne/pgas` (per
CONSUMER-COMMS-PROTOCOL § Channel 4). Do NOT:

- Mutate `node_modules/@simodelne/pgas-runtime/` to disable the check.
- Bypass the pre-commit hook with `--no-verify`.
- Swap `loadSpec` for `compileSpecification` to hide the error.

All three are bug-shipping and explicitly forbidden by the consumer
governance.
