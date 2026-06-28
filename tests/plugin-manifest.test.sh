#!/usr/bin/env bash
# Structural smoke test for the pgas-new foundry repository.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== plugin-manifest.test.sh ==="

echo "[1/5] .claude-plugin/plugin.json is valid JSON"
if [[ -f .claude-plugin/plugin.json ]] && \
   node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))" 2>/dev/null; then
  pass ".claude-plugin/plugin.json parses as JSON"
else
  fail ".claude-plugin/plugin.json missing or invalid JSON"
fi

echo "[2/5] plugin.json + package.json version pinned to 3.4.0"
EXPECTED_VERSION="3.4.0"
MANIFEST_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')).version ?? '')" 2>/dev/null)
PKG_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version ?? '')" 2>/dev/null)
if [[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]]; then
  pass "plugin.json version = $MANIFEST_VERSION"
else
  fail "plugin.json version = '$MANIFEST_VERSION' (expected $EXPECTED_VERSION)"
fi
if [[ "$PKG_VERSION" == "$EXPECTED_VERSION" ]]; then
  pass "package.json version = $PKG_VERSION"
else
  fail "package.json version = '$PKG_VERSION' (expected $EXPECTED_VERSION)"
fi
BIN_ENTRY=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).bin?.['pgas-new'] ?? '')" 2>/dev/null)
if [[ "$BIN_ENTRY" == "./bin/pgas-new" ]]; then
  pass "package.json bin pgas-new = $BIN_ENTRY"
else
  fail "package.json bin pgas-new = '$BIN_ENTRY' (expected ./bin/pgas-new)"
fi
if [[ -x bin/pgas-new ]]; then
  pass "bin/pgas-new is executable"
else
  fail "bin/pgas-new missing or not executable"
fi

echo "[3/5] pgas-new foundry sources exist"
for path in \
  src/cli.ts \
  src/pgas-new/model.ts \
  src/pgas-new/gates.ts \
  src/pgas-new/template-renderer.ts \
  src/foundry-program/specs.yml \
  src/foundry-program/registration.ts \
  templates/pgas-new/program/spec-skeleton.yml.tmpl \
  templates/pgas-new/program/registration-skeleton.ts.tmpl \
  templates/pgas-new/repo/.pgas/wiring.yml.tmpl \
  docs/PGAS-NEW-ARCHITECTURE.md \
  docs/PGAS-NEW-LIVE-GRADUATION.md; do
  if [[ -f "$path" ]]; then
    pass "exists: $path"
  else
    fail "missing: $path"
  fi
done

echo "[4/5] legacy v1 plugin surfaces are absent"
for path in commands templates/new-consumer templates/new-program templates/frontend skills hooks; do
  if [[ -e "$path" ]]; then
    fail "legacy path still exists: $path"
  else
    pass "absent: $path"
  fi
done

echo "[5/5] governance docs present"
if [[ -f CLAUDE.md ]]; then
  pass "exists: CLAUDE.md"
  if grep -q "Claude Code auto-mode classifier" CLAUDE.md && grep -qi "hard stop" CLAUDE.md; then
    pass "CLAUDE.md carries the classifier-denial hard stop"
  else
    fail "CLAUDE.md missing the classifier-denial hard stop"
  fi
else
  fail "missing: CLAUDE.md"
fi
if [[ -f MEMORY.md ]]; then
  pass "exists: MEMORY.md"
else
  fail "missing: MEMORY.md"
fi

echo "[bonus] local session artifacts ignored"
if git check-ignore -q .remember/remember.md; then
  pass ".remember/ is ignored"
else
  fail ".remember/remember.md is not ignored"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
