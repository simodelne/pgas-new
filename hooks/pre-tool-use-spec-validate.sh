#!/usr/bin/env bash
# pre-tool-use-spec-validate.sh
#
# Claude Code PreToolUse hook for the claude-pgas-plugin.
#
# Triggers on Bash tool calls. When the command is `git commit*`,
# inspects staged files; if any `*spec.yml` or `*specs.yml` is staged,
# runs `pgas:spec-validate` against each one. Exit non-zero on failure
# → blocks the commit.
#
# This catches the pgas#235 trap class (unknown-key errors that
# loadSpec() rejects but compileSpecification() would silently accept)
# at commit time rather than at runtime in production.
#
# Hook contract (Claude Code):
#   - Hook receives the tool input on stdin as JSON.
#   - Hook may print a `decision: block` JSON on stdout to block.
#   - Exit code 0 = allow; non-zero = block.

set -euo pipefail

# Read tool input from stdin
INPUT="$(cat 2>/dev/null || true)"

# Extract the bash command — works whether the input is JSON or empty
COMMAND="$(printf '%s' "$INPUT" | grep -oE '"command"\s*:\s*"[^"]*"' | head -1 | sed -E 's/.*"command"\s*:\s*"([^"]*)"/\1/' || true)"

# Only act on git commit invocations
if [[ "$COMMAND" != git\ commit* ]]; then
  exit 0
fi

# Only act when staged changes include a spec.yml
if ! git diff --cached --name-only 2>/dev/null | grep -qE '(^|/)(spec|specs)\.ya?ml$'; then
  exit 0
fi

STAGED_SPECS="$(git diff --cached --name-only | grep -E '(^|/)(spec|specs)\.ya?ml$' || true)"
[[ -z "$STAGED_SPECS" ]] && exit 0

# Verify we're in a pgas consumer
if ! grep -q '"@simodelne/pgas-' package.json 2>/dev/null; then
  # Not a pgas consumer — let the commit proceed
  exit 0
fi

# Validate each staged spec via the installed @simodelne/pgas-runtime
FAIL=0
for spec in $STAGED_SPECS; do
  if [[ ! -f "$spec" ]]; then
    # Deleted file; skip
    continue
  fi
  if ! node --input-type=module -e "
    import('@simodelne/pgas-runtime').then(async (m) => {
      try {
        await m.loadSpec('$spec');
        process.exit(0);
      } catch (e) {
        console.error('  ' + e.message);
        process.exit(1);
      }
    }).catch((e) => { console.error('  ' + e.message); process.exit(1); });
  " 2>&1; then
    echo "[pgas-plugin] FAIL: $spec failed loadSpec() validation"
    FAIL=1
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo ""
  echo "[pgas-plugin] commit blocked: at least one staged spec.yml fails loadSpec()."
  echo "             Run /pgas:spec-validate for the full report."
  echo "             To bypass for an emergency (logged in git history),"
  echo "             use 'git commit --no-verify' (NOT RECOMMENDED)."
  exit 1
fi

exit 0
