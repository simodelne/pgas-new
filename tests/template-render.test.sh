#!/usr/bin/env bash
# template-render.test.sh — structural smoke test for template files.
#
# Validates:
#   1. Every .tmpl file has matched {{...}} braces (no unbalanced).
#   2. server/index.ts.tmpl contains all 3 markers + both FM2 consumer factories.
#   3. spec.yml.tmpl parses as valid YAML.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== template-render.test.sh ==="

# 1. Every .tmpl has matched {{...}} braces
echo "[1/3] .tmpl files have balanced {{...}} braces"
while IFS= read -r f; do
  OPENS=$(grep -oE '\{\{' "$f" | wc -l | tr -d ' ')
  CLOSES=$(grep -oE '\}\}' "$f" | wc -l | tr -d ' ')
  if [[ "$OPENS" -eq "$CLOSES" ]]; then
    pass "$f: $OPENS pairs"
  else
    fail "$f: $OPENS '{{' vs $CLOSES '}}'"
  fi
done < <(find templates -name "*.tmpl" -type f 2>/dev/null)

# 2. server/index.ts.tmpl has all 3 markers + both FM2 factories
echo "[2/3] server/index.ts.tmpl has all 3 markers + FM2 factories"
SERVER_TMPL="templates/new-consumer/server/index.ts.tmpl"
if [[ ! -f "$SERVER_TMPL" ]]; then
  fail "$SERVER_TMPL missing"
else
  for marker in 'program-registry' 'spec-registry' 'handler-registry'; do
    if grep -qE "// \[pgas-plugin:${marker}\]" "$SERVER_TMPL"; then
      pass "marker present: $marker"
    else
      fail "marker MISSING: $marker"
    fi
  done
  if grep -q "createInnerContinuationReplayConsumer" "$SERVER_TMPL"; then
    pass "FM2: createInnerContinuationReplayConsumer present"
  else
    fail "FM2: createInnerContinuationReplayConsumer MISSING"
  fi
  if grep -q "createSessionLockExhaustedConsumer" "$SERVER_TMPL"; then
    pass "FM2: createSessionLockExhaustedConsumer present"
  else
    fail "FM2: createSessionLockExhaustedConsumer MISSING"
  fi
fi

# 3. spec.yml.tmpl parses as valid YAML
echo "[3/3] spec.yml.tmpl parses as valid YAML (after placeholder substitution)"
SPEC_TMPL="templates/new-program/spec.yml.tmpl"
if [[ ! -f "$SPEC_TMPL" ]]; then
  fail "$SPEC_TMPL missing"
else
  # Substitute placeholders with stand-in values so YAML parsing works
  TMP_DIR=$(mktemp -d)
  SUBSTITUTED="$TMP_DIR/spec.yml"
  sed -e 's/{{PROGRAM_NAME}}/test-program/g' \
      -e 's/{{PROGRAM_SLUG}}/test_program/g' \
      -e 's/{{PROGRAM_NAME_PASCAL}}/TestProgram/g' \
      -e 's/{{CONSUMER_NAME}}/test-consumer/g' \
      -e 's/{{ENGINE_VERSION}}/\^1.8.0/g' \
      "$SPEC_TMPL" > "$SUBSTITUTED"

  # Use Node + js-yaml to parse (yq isn't always available in CI)
  if command -v node >/dev/null && node -e "require('js-yaml')" 2>/dev/null; then
    if node -e "const y=require('js-yaml'); const fs=require('fs'); y.load(fs.readFileSync('$SUBSTITUTED','utf8'));" 2>/dev/null; then
      pass "$SPEC_TMPL parses as YAML (post-substitution)"
    else
      fail "$SPEC_TMPL fails YAML parse"
      # Surface the actual parse error for debugging
      node -e "const y=require('js-yaml'); const fs=require('fs'); try { y.load(fs.readFileSync('$SUBSTITUTED','utf8')); } catch (e) { console.error('  →', e.message); }" 2>&1 | head -5
    fi
  elif command -v python3 >/dev/null && python3 -c "import yaml" 2>/dev/null; then
    if python3 -c "import yaml,sys; yaml.safe_load(open('$SUBSTITUTED'))" 2>/dev/null; then
      pass "$SPEC_TMPL parses as YAML (post-substitution, via python3)"
    else
      fail "$SPEC_TMPL fails YAML parse (via python3)"
      python3 -c "import yaml; yaml.safe_load(open('$SUBSTITUTED'))" 2>&1 | head -5
    fi
  else
    echo "  SKIP: neither node js-yaml nor python yaml available; install one"
  fi
  rm -rf "$TMP_DIR"
fi

# Bonus check: spec.yml.tmpl declares the engine-owned FM5 paths
echo "[bonus] spec.yml.tmpl declares engine-owned FM5 paths"
for p in 'inputs.query_meta.source_path' 'inputs.query_meta.message' 'inputs.query_result.kind'; do
  if grep -q "$p:" "$SPEC_TMPL" 2>/dev/null; then
    pass "FM5: $p declared"
  else
    fail "FM5: $p NOT declared (this breaks v1.8.x sync-out replay)"
  fi
done

# Bonus check: spec.yml.tmpl only admits system_mode_entry on `start` mode (FM3)
echo "[bonus] spec.yml.tmpl admits system_mode_entry on bootstrap mode only (FM3)"
# Count mode blocks that have system_mode_entry in channels
SME_MODE_COUNT=$(awk '
  /^modes:/{in_modes=1; next}
  in_modes && /^[a-z_]+:/{mode_name=$1; gsub(":","",mode_name)}
  in_modes && /channels:.*system_mode_entry/{print mode_name}
' "$SPEC_TMPL" | wc -l | tr -d ' ')
if [[ "$SME_MODE_COUNT" -le 1 ]]; then
  pass "FM3: system_mode_entry admitted on $SME_MODE_COUNT mode(s)"
else
  fail "FM3: system_mode_entry admitted on $SME_MODE_COUNT modes (broaden = FM3 foot-gun)"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
