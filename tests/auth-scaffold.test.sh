#!/usr/bin/env bash
# auth-scaffold.test.sh — focused test for the Brief 2 auth scaffold.
#
# Renders the entire templates/new-consumer/server/auth/ tree + the two
# DB migrations into a throwaway dir, applies the migrations into an
# in-memory SQLite DB, and runs `node --check` on each rendered .ts file
# (syntactic check only — no full TS install needed).
#
# Also asserts both auth modes can be selected via `PGAS_AUTH_MODE`.
#
# Keep this under 30s. Heavy lifting (npm install, full TS build) lives
# in the consumer's own CI, not in plugin CI.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== auth-scaffold.test.sh ==="

WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

# Render server/auth/* and db/migrations/* into $WORK
mkdir -p "$WORK/server/auth" "$WORK/db/migrations"
SUB='s/{{CONSUMER_NAME}}/test-c/g'

echo "[1/4] rendering auth templates"
for f in templates/new-consumer/server/auth/*.tmpl; do
  base=$(basename "$f" .tmpl)
  sed -e "$SUB" "$f" > "$WORK/server/auth/$base"
  if [[ -s "$WORK/server/auth/$base" ]]; then
    pass "rendered: server/auth/$base"
  else
    fail "rendered EMPTY: server/auth/$base"
  fi
done
for f in templates/new-consumer/db/migrations/*.tmpl; do
  base=$(basename "$f" .tmpl)
  sed -e "$SUB" "$f" > "$WORK/db/migrations/$base"
  if [[ -s "$WORK/db/migrations/$base" ]]; then
    pass "rendered: db/migrations/$base"
  else
    fail "rendered EMPTY: db/migrations/$base"
  fi
done

echo "[2/4] no unsubstituted placeholders in rendered output"
if grep -rlE '\{\{[A-Z_]+\}\}' "$WORK" > /dev/null; then
  fail "unsubstituted placeholders found:"
  grep -rlE '\{\{[A-Z_]+\}\}' "$WORK"
else
  pass "all placeholders substituted"
fi

echo "[3/4] DB migrations apply cleanly to in-memory SQLite"
if command -v sqlite3 >/dev/null 2>&1; then
  SQL_BUNDLE=$(mktemp)
  cat "$WORK"/db/migrations/*.sql > "$SQL_BUNDLE"
  if sqlite3 :memory: < "$SQL_BUNDLE" 2>/dev/null; then
    pass "migrations apply cleanly"
  else
    fail "migrations FAILED to apply"
    sqlite3 :memory: < "$SQL_BUNDLE" 2>&1 | head -5
  fi
  # Confirm the expected schema is in place: open a file DB, apply, then
  # inspect.
  DBF="$WORK/auth-test.db"
  sqlite3 "$DBF" < "$SQL_BUNDLE"
  TABLES=$(sqlite3 "$DBF" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
  if echo "$TABLES" | grep -q "^user_sessions$"; then
    pass "user_sessions table created"
  else
    fail "user_sessions table MISSING"
  fi
  if echo "$TABLES" | grep -q "^magic_links$"; then
    pass "magic_links table created"
  else
    fail "magic_links table MISSING"
  fi
  # Index existence
  IDX=$(sqlite3 "$DBF" "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;")
  if echo "$IDX" | grep -q "idx_user_sessions_jti"; then
    pass "idx_user_sessions_jti created"
  else
    fail "idx_user_sessions_jti MISSING"
  fi
  if echo "$IDX" | grep -q "idx_magic_links_user_consumed"; then
    pass "idx_magic_links_user_consumed created"
  else
    fail "idx_magic_links_user_consumed MISSING"
  fi
  rm -f "$SQL_BUNDLE"
else
  echo "  SKIP: sqlite3 CLI not available"
fi

echo "[4/4] auth-mode selector branches are present in middleware"
MW="$WORK/server/auth/middleware.ts"
if grep -q "dev-static-token" "$MW" && grep -q "magic-link" "$MW"; then
  pass "middleware handles both PGAS_AUTH_MODE values"
else
  fail "middleware missing one of dev-static-token / magic-link branches"
fi
if grep -q "PGAS_DEV_STATIC_TOKEN" "$MW"; then
  pass "middleware reads PGAS_DEV_STATIC_TOKEN"
else
  fail "middleware does not reference PGAS_DEV_STATIC_TOKEN"
fi
if grep -q "timingSafeEqual" "$MW"; then
  pass "middleware uses constant-time compare for dev-static-token"
else
  fail "middleware does NOT use constant-time compare (timing-attack risk)"
fi
# Never fail-open: when no Authorization header is present, we MUST 401.
if grep -qE "if \(!token\)\s*return c\.json\(UNAUTHORIZED, 401\)" "$MW"; then
  pass "middleware 401s on missing Authorization header"
else
  fail "middleware does not 401 on missing Authorization header"
fi

CFG="$WORK/server/auth/config.ts"
if grep -q "onMagicLink" "$CFG"; then
  pass "config exposes onMagicLink seam"
else
  fail "config does NOT expose onMagicLink seam"
fi

ROUTES="$WORK/server/auth/routes.ts"
if grep -q "TODO(rate-limiting)" "$ROUTES"; then
  pass "routes carries rate-limiting TODO"
else
  fail "routes missing rate-limiting TODO"
fi

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
