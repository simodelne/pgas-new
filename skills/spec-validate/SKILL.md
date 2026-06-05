---
name: pgas:spec-validate
description: Load and validate a consumer's spec.yml using the installed @simodelne/pgas-runtime-core loadSpecWithPatterns(). Reports unknown-key errors verbatim and flags them as the pgas#235 trap class. Run before staging any spec.yml change, and on every CI run that touches a spec.
---

# pgas:spec-validate

Validate a consumer's `spec.yml` (or `specs.yml`) using the SAME loader
the consumer's `registration.ts` actually runs:
`loadSpecWithPatterns()` from
`@simodelne/pgas-runtime-core/pattern-composer/load-with-patterns.js`.

That function expands any `patterns:` entries, resolves `$ref(...)`
prompt fragments, then delegates to the lower-level
`@simodelne/pgas-runtime` `loadSpec()`, which runs the strict-keys gate
(`assertNoUnknownSpecKeys` in
`pgas-runtime/spec-loader/unknown-keys.ts`). Validating with
`loadSpecWithPatterns` reproduces ground truth: a spec that loads here
loads in the consumer; a spec that only loads via the bare `loadSpec`
may still fail in a consumer whose spec uses `patterns:`.

Plain `loadSpec(yamlPath)` is the lower-level path — use it directly only
for a pattern-free spec. NEVER use the even-lower `compileSpecification`.

This skill catches the **#235 trap class** — `compileSpecification`
bypasses the strict-keys gate, so a `compileSpecification`-only test
passes locally while real consumers (who go through `loadSpec` /
`loadSpecWithPatterns`) crash with
`Spec compiler check failed: unknown key "..."`. The strict-keys gate is
unforgiving: as of engine 1.13, every top-level key, every per-mode key,
and every transition/guard key is checked against a fixed allowlist
(`unknown-keys.ts`). The legacy pre-1.9 shapes — top-level
`mode_initial:`, a top-level `transitions:` block, and `channel_paths:` —
are NOT in the allowlist and are rejected verbatim (the current shape is
`initial:` + per-mode `transitions:` + `ingestion:`; see Step 3).

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

## Step 2 — invoke loadSpecWithPatterns()

For each spec file, run the installed engine's `loadSpecWithPatterns()`
via a one-liner Node script. The function is synchronous and returns
`{ spec, report, promptReport }`; `spec.modes` is the compiled modes map.

```bash
for spec in $SPECS; do
  echo "--- $spec ---"
  node --input-type=module -e "
    import('@simodelne/pgas-runtime-core/pattern-composer/load-with-patterns.js')
      .then((m) => {
        try {
          const { spec: compiled, report } = m.loadSpecWithPatterns('$spec');
          const patterns = report.patterns.map((p) => p.name).join(', ') || 'none';
          console.log('OK:', '$spec', '— compiled', Object.keys(compiled.modes).length, 'modes; patterns:', patterns);
          process.exit(0);
        } catch (e) {
          console.error('FAIL:', '$spec');
          console.error('  ', e.message);
          process.exit(1);
        }
      })
      .catch((e) => { console.error('FAIL:', '$spec'); console.error('  ', e.message); process.exit(1); });
  " || EXIT=1
done
exit ${EXIT:-0}
```

For a spec with no `patterns:` block you may import
`@simodelne/pgas-runtime/spec-loader/index.js` and call `loadSpec('$spec')`
directly — same strict-keys gate, no pattern expansion. Prefer
`loadSpecWithPatterns` unless you have a reason not to: it is what the
consumer runs.

If `@simodelne/pgas-runtime-core` is not installed (no `node_modules/`),
abort with: "Run `npm install` first — the validator needs the installed
runtime." Do NOT try to use a bundled copy — the validation must reflect
what the consumer's actually-installed version accepts.

## Step 3 — classify errors

Inspect the error message. Common error classes:

### Unknown-key error → pgas#235 trap class

```
Spec compiler check failed: unknown key "<KEY>"
```

The error names the offending key with its full dotted path. The most
common one in the wild is a **legacy-shape** spec that predates the 1.9
shape migration. For example, a spec that still declares its start mode
with a top-level `mode_initial:` fails on engine 1.13 with the verbatim
message:

```
Spec compiler check failed: unknown key "spec.mode_initial"
```

because `mode_initial` is not in the `ROOT_KEYS` allowlist
(`unknown-keys.ts`). The current shape uses `initial:` instead:

```yaml
# WRONG (rejected: unknown key "spec.mode_initial")
mode_initial: intake

# CURRENT SHAPE
initial: intake
terminal: [complete]
```

The same trap class catches a top-level `transitions:` block (transitions
are per-mode now — see below) and a top-level `channel_paths:` block
(renamed `ingestion:`).

When you see an unknown-key error, report:

> **pgas#235 trap class** — `loadSpec()` / `loadSpecWithPatterns()` reject
> unknown keys that `compileSpecification()` would silently accept. Two
> fixes:
>
> 1. **If the key is a legacy-shape leftover** (the common case —
>    `mode_initial`, top-level `transitions:`, `channel_paths:`): migrate
>    it to the current shape (`initial:`, per-mode `transitions:`,
>    `ingestion:`). The error message names the offending key directly.
> 2. **If the key is intentional** (your spec is ahead of the installed
>    engine, e.g. a key the runtime hasn't shipped yet): add the key to
>    `pgas-runtime/spec-loader/unknown-keys.ts`'s allowlist. This requires
>    bumping the engine — file a Channel 4 issue on `simodelne/pgas`.

### Current transition shape (for migration reference)

Transitions live PER MODE as an array of `{guard, target, crystallize?}`
objects; guards are predicate objects `{kind, path, value?}`. Action →
mode routing is the top-level `proceed_to:` map (action name → target
mode), NOT a top-level `transitions:` block.

```yaml
modes:
  plan:
    vocabulary: [analyze_query, query_state]
    channels: [system_query_result, system_mode_entry, widget_output, tool_call]
    transitions:
      - guard: { kind: FieldTruthy, path: decisions.plan_ready }
        target: describe
        crystallize: [decisions.plan_ready]

proceed_to:
  analyze_query: describe
```

### Other validation errors

Report the error verbatim. Common ones:

- `Spec compiler check failed: <SC|FV|IC|RC>-N` — Alloy-aligned static
  check. Read `pgas.als` and `docs/Specifications.md` for the rule.
- `Unknown channel: <name>` — listed a channel in a mode's `channels:`
  block but did not define it in the spec's top-level `channels:` block.
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
