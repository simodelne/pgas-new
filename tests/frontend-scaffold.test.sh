#!/usr/bin/env bash
# frontend-scaffold.test.sh — scaffold-time smoke test for the vendored
# frontend snapshot (Brief 3).
#
# Simulates the --with-frontend flag of /pgas-new-consumer:
#   1. Copy templates/frontend/ into a throwaway temp dir.
#   2. Substitute placeholders on every .tmpl file (drop the suffix).
#   3. Verify every expected file exists in the rendered tree.
#   4. Verify no rendered file has leftover {{...}} placeholders.
#   5. If npm + node are available, run `npm install && npm run build`
#      and assert exit 0 + check the consumer name flows through to
#      the built output. CI environments without network access skip
#      the install step but still verify file shape.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== frontend-scaffold.test.sh ==="

CONSUMER="test-consumer-fe"
TARGET=$(mktemp -d)
trap 'rm -rf "$TARGET"' EXIT

# 1. Copy template tree
echo "[1/5] copy templates/frontend/ -> \$TARGET/frontend/"
mkdir -p "$TARGET/frontend"
cp -R templates/frontend/. "$TARGET/frontend/"
pass "copied to $TARGET/frontend"

# 2. Substitute placeholders on every .tmpl file (and drop .tmpl suffix)
echo "[2/5] substitute placeholders + drop .tmpl"
while IFS= read -r tmpl; do
  out="${tmpl%.tmpl}"
  sed -e "s/{{CONSUMER_NAME}}/$CONSUMER/g" \
      -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
      -e 's/{{GH_OWNER}}/simodelne/g' \
      "$tmpl" > "$out"
  rm -f "$tmpl"
done < <(find "$TARGET/frontend" -name "*.tmpl" -type f)
pass "all .tmpl files rendered"

# 3. Verify expected files exist in rendered tree
echo "[3/5] expected files exist in rendered tree"
EXPECTED=(
  "package.json"
  "index.html"
  "vite.config.ts"
  "tsconfig.json"
  "tsconfig.app.json"
  "tsconfig.node.json"
  "eslint.config.js"
  ".env.example"
  ".gitignore"
  "README.md"
  "src/main.tsx"
  "src/App.tsx"
  "src/index.css"
  "src/vite-env.d.ts"
  "src/lib/auth.ts"
  "src/lib/api.ts"
  "src/lib/ws.ts"
  "src/lib/navigate.ts"
  "src/stores/auth.ts"
  "src/components/Router.tsx"
  "src/pages/Login.tsx"
  "src/pages/MagicLinkCallback.tsx"
  "src/pages/SessionList.tsx"
  "src/pages/Chat.tsx"
)
for f in "${EXPECTED[@]}"; do
  if [[ -f "$TARGET/frontend/$f" ]]; then
    pass "exists: $f"
  else
    fail "MISSING: $f"
  fi
done

# 4. No rendered file has leftover {{...}} placeholders
echo "[4/5] rendered files have no leftover {{...}} placeholders"
LEFTOVER=0
while IFS= read -r f; do
  if grep -qE '\{\{[A-Z_]+\}\}' "$f" 2>/dev/null; then
    LEFTOVER=$((LEFTOVER+1))
    fail "leftover placeholder in: ${f#$TARGET/frontend/}"
  fi
done < <(find "$TARGET/frontend" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.json" -o -name "*.html" -o -name ".env.example" -o -name "*.md" \))
if [[ "$LEFTOVER" -eq 0 ]]; then
  pass "no leftover placeholders in any rendered file"
fi

# 4b. Consumer name flows through to the rendered package.json
if grep -q "\"name\": \"$CONSUMER-frontend\"" "$TARGET/frontend/package.json"; then
  pass "package.json name = '$CONSUMER-frontend'"
else
  fail "package.json name NOT substituted to '$CONSUMER-frontend'"
fi

# 4c. index.html title carries the consumer name
if grep -q "<title>$CONSUMER</title>" "$TARGET/frontend/index.html"; then
  pass "index.html title = '$CONSUMER'"
else
  fail "index.html title NOT substituted"
fi

# 4d. Login.tsx switches on VITE_PGAS_AUTH_MODE
if grep -q "VITE_PGAS_AUTH_MODE" "$TARGET/frontend/src/pages/Login.tsx"; then
  pass "Login.tsx switches on VITE_PGAS_AUTH_MODE"
else
  fail "Login.tsx MISSING VITE_PGAS_AUTH_MODE switch"
fi

# 4e. auth.ts stores the token in localStorage
if grep -q "localStorage" "$TARGET/frontend/src/lib/auth.ts"; then
  pass "lib/auth.ts uses localStorage"
else
  fail "lib/auth.ts does NOT use localStorage"
fi

# 4f. ws.ts attaches the token on connect
if grep -q "token=" "$TARGET/frontend/src/lib/ws.ts"; then
  pass "lib/ws.ts attaches ?token= on WS connect"
else
  fail "lib/ws.ts does NOT attach token"
fi

# 5. Optional: npm install + build. Skipped when:
#   - npm is not on PATH, OR
#   - SKIP_NPM=1 (used in CI environments without network egress)
echo "[5/5] npm install + build (optional, skipped if npm missing or SKIP_NPM=1)"
if [[ "${SKIP_NPM:-0}" == "1" ]]; then
  echo "  SKIP: SKIP_NPM=1"
elif ! command -v npm >/dev/null 2>&1; then
  echo "  SKIP: npm not on PATH"
else
  pushd "$TARGET/frontend" >/dev/null
  if npm install --no-audit --no-fund --prefer-offline >/tmp/fe-install.log 2>&1; then
    pass "npm install succeeded"
    if npm run build >/tmp/fe-build.log 2>&1; then
      pass "npm run build succeeded"
      # Verify the consumer name landed in the built HTML
      if grep -q "$CONSUMER" dist/index.html 2>/dev/null; then
        pass "consumer name '$CONSUMER' present in dist/index.html"
      else
        fail "consumer name '$CONSUMER' NOT in dist/index.html"
        cat dist/index.html 2>/dev/null | head -20
      fi
    else
      fail "npm run build FAILED — see /tmp/fe-build.log"
      tail -30 /tmp/fe-build.log
    fi
    if npm run lint >/tmp/fe-lint.log 2>&1; then
      pass "npm run lint succeeded"
    else
      fail "npm run lint FAILED — see /tmp/fe-lint.log"
      tail -20 /tmp/fe-lint.log
    fi
  else
    fail "npm install FAILED — see /tmp/fe-install.log"
    tail -20 /tmp/fe-install.log
  fi
  popd >/dev/null
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
