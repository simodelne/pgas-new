#!/usr/bin/env bash
# server-typecheck.test.sh — END-TO-END server template typecheck gate.
#
# This is the test v0.1.0 was MISSING. v0.1.0 shipped a server template
# that imported 8 symbols from @simodelne/pgas-server's main entry —
# but that entry exports NOTHING (it is a runnable bootstrap, not a
# library), so a freshly-scaffolded consumer's `npx tsc --noEmit`
# produced 8 TS2459/TS2305 errors. v0.1.1 worked around it with deep
# subpath imports; v0.2.0 replaced those with the
# `@simodelne/pgas-server/api` barrel that pgas#256 shipped in engine
# v1.9.0 (see templates/new-consumer/server/index.ts.tmpl).
# This script catches the next regression: anything that breaks the
# scaffolded server's typecheck against the installed package.
#
# What it does:
#   1. Scaffold a throwaway consumer (placeholder-substitute every
#      .tmpl under templates/new-consumer/).
#   2. Scaffold a bootstrap program "main" inside it (mirroring what
#      /pgas-new-program would do).
#   3. Inject lines at each of the 4 `[pgas-plugin:*-registry]`
#      markers in server/index.ts — the same injection shape
#      /pgas-new-program produces.
#   4. `npm install` against GitHub Packages (needs NPM_TOKEN).
#   5. `npx tsc --noEmit` on the scaffolded server.
#   6. Assert exit 0.
#
# NPM_TOKEN resolution:
#   - $NPM_TOKEN if exported (CI passes secrets.GITHUB_TOKEN this way).
#   - Else `gh auth token` (so a local dev with a logged-in gh CLI
#     doesn't have to export anything manually).
#   - Else SKIP (exit 0). Local-without-a-token shouldn't fail; CI
#     provides the token via secrets.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== server-typecheck.test.sh ==="

# ----- NPM_TOKEN resolution ------------------------------------------
NPM_TOKEN="${NPM_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [[ -z "$NPM_TOKEN" ]]; then
  echo "SKIP: NPM_TOKEN unavailable (neither \$NPM_TOKEN nor \`gh auth token\` produced one)"
  echo "      CI provides this via secrets.GITHUB_TOKEN; locally, \`gh auth login\` first."
  exit 0
fi
export NPM_TOKEN

# ----- working dir ---------------------------------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CONSUMER="test-stc"     # short → keeps GHCR scope name within limits
ENGINE_VERSION="^1.13.0"
GH_OWNER="simodelne"
PROGRAM="main"
PROGRAM_SLUG="main"
PROGRAM_PASCAL="Main"

# ----- Step 1: scaffold the consumer ---------------------------------
echo "[1/6] scaffolding consumer at $WORK"
mkdir -p "$WORK"
cp -R templates/new-consumer/. "$WORK/"
pass "copied templates/new-consumer/ → $WORK"

# Substitute placeholders on every .tmpl file (drop .tmpl suffix).
while IFS= read -r tmpl; do
  out="${tmpl%.tmpl}"
  sed -e "s/{{CONSUMER_NAME}}/$CONSUMER/g" \
      -e "s/{{ENGINE_VERSION}}/$(echo $ENGINE_VERSION | sed 's/[\/&]/\\&/g')/g" \
      -e "s/{{GH_OWNER}}/$GH_OWNER/g" \
      "$tmpl" > "$out"
  rm -f "$tmpl"
done < <(find "$WORK" -name "*.tmpl" -type f)
pass "rendered all .tmpl files"

# Sanity: .npmrc actually exists in the rendered tree.
if [[ -f "$WORK/.npmrc" ]]; then
  pass ".npmrc rendered"
else
  fail ".npmrc NOT rendered — scaffolded consumer cannot authenticate"
  exit 1
fi

# ----- Step 2: scaffold the bootstrap program ------------------------
echo "[2/6] scaffolding bootstrap program '$PROGRAM' under programs/$PROGRAM/"
mkdir -p "$WORK/programs/$PROGRAM"
cp -R templates/new-program/. "$WORK/programs/$PROGRAM/"
while IFS= read -r tmpl; do
  out="${tmpl%.tmpl}"
  sed -e "s/{{PROGRAM_NAME}}/$PROGRAM/g" \
      -e "s/{{PROGRAM_SLUG}}/$PROGRAM_SLUG/g" \
      -e "s/{{PROGRAM_NAME_PASCAL}}/$PROGRAM_PASCAL/g" \
      -e "s/{{CONSUMER_NAME}}/$CONSUMER/g" \
      -e "s/{{ENGINE_VERSION}}/$(echo $ENGINE_VERSION | sed 's/[\/&]/\\&/g')/g" \
      "$tmpl" > "$out"
  rm -f "$tmpl"
done < <(find "$WORK/programs/$PROGRAM" -name "*.tmpl" -type f)
pass "rendered new-program templates for '$PROGRAM'"

# ----- Step 3: marker-based injection --------------------------------
# The 4 markers in server/index.ts (post-render — the {{CONSUMER_NAME}}
# placeholder was substituted in step 1) are:
#   // [pgas-plugin:program-registry]      — auto-injected program imports
#   // [pgas-plugin:spec-registry]         — auto-injected spec loads
#   // [pgas-plugin:handler-registry]      — auto-injected handler imports
#   // [pgas-plugin:program-registration]  — registry.register(...) calls
#
# /pgas-new-program injects ABOVE each marker. We do the same here so
# the test exercises the exact wiring shape end-users will see.

SERVER_TS="$WORK/server/index.ts"
echo "[3/6] injecting marker-based program wiring into $SERVER_TS"
for marker in 'program-registry' 'spec-registry' 'handler-registry' 'program-registration'; do
  if ! grep -q "\[pgas-plugin:${marker}\]" "$SERVER_TS"; then
    fail "marker missing in rendered server/index.ts: $marker"
  fi
done

# The rendered registration.ts (step 2 copied + substituted the whole
# templates/new-program/ tree) now encapsulates spec-load + handler
# imports + createProgramAdapters. So the marker injection is exactly
# what /pgas-new-program produces in real life: an import of the
# program's ProgramEntry factory at program-registry, and a
# registry.register(...) call at program-registration. The spec-registry
# and handler-registry markers get NOTHING injected (registration.ts owns
# that wiring) — the markers themselves stay untouched in the template.
python3 - <<PY
import re, pathlib
p = pathlib.Path("$SERVER_TS")
src = p.read_text()

PROGRAM = "$PROGRAM"
PROGRAM_SLUG = "$PROGRAM_SLUG"
PROGRAM_PASCAL = "$PROGRAM_PASCAL"

# program-registry marker — import the program's ProgramEntry factory
# from its scaffolded registration.ts.
imp_program = "\n".join([
  f"import {{ create{PROGRAM_PASCAL}ProgramEntry }} from '../programs/{PROGRAM}/registration.js';",
  "",
])

# program-registration marker — register the program under its slug.
register_call = "\n".join([
  f"registry.register('{PROGRAM_SLUG}', create{PROGRAM_PASCAL}ProgramEntry());",
  "",
])

def inject_above(text, marker, content):
  pat = re.compile(rf"^(.*\[pgas-plugin:{re.escape(marker)}\].*)$", re.M)
  return pat.sub(lambda m: content + m.group(1), text)

# spec-registry + handler-registry: inject NOTHING — registration.ts
# encapsulates the spec load and handler imports. The markers remain in
# place for any consumer that hand-wires a program without registration.ts.
src = inject_above(src, "program-registry", imp_program)
src = inject_above(src, "program-registration", register_call)

p.write_text(src)
PY
pass "injected marker content for program '$PROGRAM'"

# ----- Step 4: npm install -------------------------------------------
echo "[4/6] npm install (with NPM_TOKEN)"
pushd "$WORK" >/dev/null
if npm install --no-audit --no-fund --prefer-offline > /tmp/server-typecheck-install.log 2>&1; then
  pass "npm install succeeded"
else
  # If the token can't read packages (403 / permission_denied / E403),
  # SKIP the rest of the gate instead of failing. This is the documented
  # GitHub Actions footgun: `secrets.GITHUB_TOKEN` on a workflow running
  # in repo A can only read packages owned by repo A. The @simodelne/*
  # packages are published by `simodelne/pgas`, a sibling repo, so the
  # plugin's default GITHUB_TOKEN gets 403. The fix is an org-level PAT
  # (set as a repo secret with `read:packages` on the simodelne org) —
  # until that lands, surface the diagnostic loud + skip the gate so a
  # token-config problem doesn't masquerade as a template regression.
  if grep -qE 'E403|permission_denied|403 Forbidden' /tmp/server-typecheck-install.log; then
    echo ""
    echo "  SKIP: NPM_TOKEN cannot read @simodelne packages (403 Forbidden)."
    echo "        Default \`secrets.GITHUB_TOKEN\` on this repo only sees"
    echo "        packages published BY this repo. The @simodelne/* packages"
    echo "        live in simodelne/pgas; an org-scoped PAT with"
    echo "        \`read:packages\` is required to exercise this gate in CI."
    echo "        Locally, \`gh auth token\` covers it because the user account"
    echo "        owns the read scope across the whole org."
    echo ""
    echo "        Suspected token surface (truncated):"
    head -5 /tmp/server-typecheck-install.log | sed 's/^/          /'
    echo ""
    echo "=== Result: $PASS pass, $FAIL fail (SKIPPED — see above) ==="
    popd >/dev/null
    exit 0
  fi
  fail "npm install FAILED — see /tmp/server-typecheck-install.log"
  tail -40 /tmp/server-typecheck-install.log
  popd >/dev/null
  echo ""
  echo "=== Result: $PASS pass, $FAIL fail ==="
  exit 1
fi
popd >/dev/null

# ----- Step 5: npx tsc --noEmit --------------------------------------
echo "[5/6] npx tsc --noEmit on scaffolded server"
pushd "$WORK" >/dev/null
if npx --offline tsc --noEmit > /tmp/server-typecheck-tsc.log 2>&1; then
  pass "tsc --noEmit succeeded (exit 0)"
  TYPECHECK_OK=1
else
  fail "tsc --noEmit FAILED — see /tmp/server-typecheck-tsc.log"
  tail -60 /tmp/server-typecheck-tsc.log
  TYPECHECK_OK=0
fi
popd >/dev/null

# ----- Step 6: report ------------------------------------------------
echo "[6/6] result"
if [[ "${TYPECHECK_OK:-0}" -eq 1 ]]; then
  pass "scaffolded consumer typechecks against installed @simodelne/pgas-server"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
