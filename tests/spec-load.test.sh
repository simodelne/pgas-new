#!/usr/bin/env bash
# spec-load.test.sh — END-TO-END program-spec LOAD gate.
#
# This is the gate v0.2.0 was MISSING. server-typecheck.test.sh proves
# the scaffolded server TYPECHECKS, but `tsc --noEmit` never executes
# `loadSpecWithPatterns(...)` — so a spec.yml.tmpl written against a
# stale engine key vocabulary (mode_initial, top-level transitions,
# per-mode prompts, tools.*.args, channel_paths, missing fallback)
# typechecked green while the REAL loader rejected the rendered spec
# with `unknown key` / compiler-check errors. This script catches that
# class of regression: it renders the new-program spec template and
# feeds it to the real installed engine loader.
#
# What it does:
#   1. Render templates/new-program/spec.yml.tmpl (sed substitution).
#   2. Create a throwaway npm package (.npmrc → GitHub Packages) and
#      install the REAL @simodelne/pgas-runtime-core + pgas-runtime.
#   3. Run a verify script via tsx that calls loadSpecWithPatterns()
#      on the rendered spec.
#   4. PASS iff the loader prints LOADED_OK; FAIL with the full loader
#      error otherwise.
#
# NPM_TOKEN resolution (same contract as server-typecheck.test.sh):
#   - $NPM_TOKEN if exported (CI passes secrets this way).
#   - Else `gh auth token` (local dev with a logged-in gh CLI).
#   - Else SKIP (exit 0). A 403 from GitHub Packages also SKIPs —
#     a token-config problem must not masquerade as a template bug.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== spec-load.test.sh ==="

# ----- NPM_TOKEN resolution ------------------------------------------
NPM_TOKEN="${NPM_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [[ -z "$NPM_TOKEN" ]]; then
  echo "SKIP: NPM_TOKEN unavailable (neither \$NPM_TOKEN nor \`gh auth token\` produced one)"
  echo "      CI provides this via secrets; locally, \`gh auth login\` first."
  exit 0
fi
export NPM_TOKEN

# ----- working dir ---------------------------------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PROGRAM="main"
PROGRAM_SLUG="main"
PROGRAM_PASCAL="Main"
CONSUMER="test-sl"
# Lowest engine version whose loader surface this template targets.
ENGINE_RANGE="^1.13.0"

# ----- Step 1: render the spec template ------------------------------
echo "[1/4] rendering templates/new-program/spec.yml.tmpl"
SPEC_TMPL="templates/new-program/spec.yml.tmpl"
if [[ ! -f "$SPEC_TMPL" ]]; then
  fail "$SPEC_TMPL missing"
  echo "=== Result: $PASS pass, $FAIL fail ==="
  exit 1
fi
sed -e "s/{{PROGRAM_NAME}}/$PROGRAM/g" \
    -e "s/{{PROGRAM_SLUG}}/$PROGRAM_SLUG/g" \
    -e "s/{{PROGRAM_NAME_PASCAL}}/$PROGRAM_PASCAL/g" \
    -e "s/{{CONSUMER_NAME}}/$CONSUMER/g" \
    "$SPEC_TMPL" > "$WORK/spec.yml"
if grep -qE '\{\{[A-Z_]+\}\}' "$WORK/spec.yml"; then
  fail "rendered spec.yml still contains unsubstituted placeholders:"
  grep -oE '\{\{[A-Z_]+\}\}' "$WORK/spec.yml" | sort -u | sed 's/^/          /'
  echo "=== Result: $PASS pass, $FAIL fail ==="
  exit 1
fi
pass "rendered spec.yml (no leftover placeholders)"

# ----- Step 2: throwaway package + real engine install ---------------
echo "[2/4] npm install real engine loader (with NPM_TOKEN)"
cat > "$WORK/.npmrc" <<'NPMRC'
@simodelne:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
always-auth=true
NPMRC
cat > "$WORK/package.json" <<'PKG'
{
  "name": "spec-load-gate",
  "private": true,
  "type": "module"
}
PKG

pushd "$WORK" >/dev/null
if npm install --no-audit --no-fund --prefer-offline \
    "@simodelne/pgas-runtime-core@$ENGINE_RANGE" \
    "@simodelne/pgas-runtime@$ENGINE_RANGE" \
    tsx > /tmp/spec-load-install.log 2>&1; then
  pass "npm install succeeded"
else
  # Same documented footgun as server-typecheck.test.sh: a repo-scoped
  # GITHUB_TOKEN cannot read packages published by the sibling repo
  # simodelne/pgas → 403 → SKIP, loudly.
  if grep -qE 'E403|permission_denied|403 Forbidden' /tmp/spec-load-install.log; then
    echo ""
    echo "  SKIP: NPM_TOKEN cannot read @simodelne packages (403 Forbidden)."
    echo "        See tests/server-typecheck.test.sh + docs/PLUGIN-DEVELOPMENT.md"
    echo "        → 'CI secrets' for the org-scoped PLUGIN_NPM_TOKEN fix."
    echo ""
    echo "        Token surface (truncated):"
    head -5 /tmp/spec-load-install.log | sed 's/^/          /'
    echo ""
    echo "=== Result: $PASS pass, $FAIL fail (SKIPPED — see above) ==="
    popd >/dev/null
    exit 0
  fi
  fail "npm install FAILED — see /tmp/spec-load-install.log"
  tail -40 /tmp/spec-load-install.log
  popd >/dev/null
  echo ""
  echo "=== Result: $PASS pass, $FAIL fail ==="
  exit 1
fi
popd >/dev/null

# ----- Step 3: load the rendered spec with the REAL loader ------------
echo "[3/4] loadSpecWithPatterns() on the rendered spec"
cat > "$WORK/verify.ts" <<EOF
import { loadSpecWithPatterns } from '@simodelne/pgas-runtime-core/pattern-composer/load-with-patterns.js';

async function main(): Promise<void> {
  try {
    const r = await loadSpecWithPatterns('$WORK/spec.yml') as { spec?: { name?: string }, name?: string };
    const name = r?.spec?.name ?? r?.name ?? '?';
    if (name !== '$PROGRAM_SLUG') {
      console.error('LOAD_FAILED: loaded spec name "' + name + '" != expected "$PROGRAM_SLUG"');
      process.exit(1);
    }
    console.log('LOADED_OK name=' + name);
  } catch (e) {
    console.error('LOAD_FAILED: ' + (e as Error).message);
    process.exit(1);
  }
}
main();
EOF

pushd "$WORK" >/dev/null
if ./node_modules/.bin/tsx verify.ts > /tmp/spec-load-verify.log 2>&1 \
    && grep -q 'LOADED_OK' /tmp/spec-load-verify.log; then
  pass "real engine loader accepted the rendered spec: $(grep 'LOADED_OK' /tmp/spec-load-verify.log)"
  LOAD_OK=1
else
  fail "real engine loader REJECTED the rendered spec:"
  cat /tmp/spec-load-verify.log | sed 's/^/          /'
  LOAD_OK=0
fi
popd >/dev/null

# ----- Step 4: report ------------------------------------------------
echo "[4/4] result"
if [[ "${LOAD_OK:-0}" -eq 1 ]]; then
  pass "spec.yml.tmpl loads against installed @simodelne/pgas-runtime-core@$ENGINE_RANGE"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
