#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== pgas-new-static.test.sh ==="

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "[1/6] render standalone scaffold"
npm run pgas-new -- render-standalone --slug pgas-new --name "PGAS New" --out "$WORK" >/tmp/pgas-new-render.log
test -f "$WORK/src/programs/pgas-new/specs.yml" && pass "rendered specs.yml" || fail "missing generated specs.yml"
test -f "$WORK/src/repl/index.ts" && pass "rendered REPL index" || fail "missing generated REPL index"
test -f "$WORK/src/repl/renderer.ts" && pass "rendered REPL renderer" || fail "missing generated REPL renderer"
test -f "$WORK/tests/live-provider.test.ts" && pass "rendered live provider test" || fail "missing generated live provider test"

echo "[2/6] generated scaffold has no banned imports"
if grep -R --line-number -E '@simodelne/pgas-server/api|@simodelne/pgas-server/src|@simodelne/pgas-server/client/http|@simodelne/pgas-runtime|@simodelne/pgas-contracts|@simodelne/pgas-middleware|@simodelne/pgas-drivers' "$WORK"; then
  fail "generated scaffold contains banned imports"
else
  pass "no banned imports"
fi

echo "[3/6] generated specs.yml parses"
node --input-type=module -e "import yaml from 'js-yaml'; import fs from 'node:fs'; yaml.load(fs.readFileSync('$WORK/src/programs/pgas-new/specs.yml', 'utf8'));" \
  && pass "specs.yml parses as YAML" || fail "specs.yml YAML parse failed"

echo "[4/6] package typecheck"
npm run typecheck >/tmp/pgas-new-typecheck.log && pass "typecheck passed" || fail "typecheck failed"

echo "[5/6] unit/static tests"
CI=1 RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-1}" UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-1}" npm run test:unit >/tmp/pgas-new-vitest.log && pass "Vitest suite passed" || fail "Vitest suite failed"

echo "[6/6] optional generated scaffold install/test"
if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "  SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run"
else
  (
    cd "$WORK"
    cat > .npmrc <<'NPMRC'
@simodelne:registry=https://npm.pkg.github.com
    //npm.pkg.github.com/:_authToken=${NPM_TOKEN}
always-auth=true
NPMRC
    mkdir -p "$WORK/.npm-cache"
    NPM_TOKEN="$NPM_TOKEN" npm_config_cache="$WORK/.npm-cache" npm install --no-audit --no-fund >/tmp/pgas-new-generated-install.log 2>&1
    npm_config_cache="$WORK/.npm-cache" npm run typecheck >/tmp/pgas-new-generated-typecheck.log 2>&1
    # Keep the generated scaffold's nested vitest on the repo-standard threads
    # pool with one native worker so static verification is stable on constrained
    # hosts while still executing the scaffold tests.
    CI=1 RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-1}" UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-1}" npm_config_cache="$WORK/.npm-cache" npm test >/tmp/pgas-new-generated-test.log 2>&1
  ) && pass "generated scaffold install/typecheck/test passed" || fail "generated scaffold install/typecheck/test failed"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]]
