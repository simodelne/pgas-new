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
  # `|| true` so a tmpl with ZERO placeholders (e.g. .npmrc.tmpl, which
  # uses shell-style ${NPM_TOKEN}) doesn't trip `set -e -o pipefail` via
  # grep's exit-1-on-no-match. 0 == 0 is balanced.
  OPENS=$( { grep -oE '\{\{' "$f" || true; } | wc -l | tr -d ' ')
  CLOSES=$( { grep -oE '\}\}' "$f" || true; } | wc -l | tr -d ' ')
  if [[ "$OPENS" -eq "$CLOSES" ]]; then
    pass "$f: $OPENS pairs"
  else
    fail "$f: $OPENS '{{' vs $CLOSES '}}'"
  fi
done < <(find templates -name "*.tmpl" -type f 2>/dev/null)

# 1b. The .npmrc.tmpl exists, scopes @simodelne to GitHub Packages, and
# wires NPM_TOKEN — without this, a freshly-scaffolded consumer can't
# `npm install` on a clean machine. v0.1.0 shipped without it.
echo "[1b/3] .npmrc.tmpl is present and correctly scopes the registry"
NPMRC_TMPL="templates/new-consumer/.npmrc.tmpl"
if [[ -f "$NPMRC_TMPL" ]]; then
  pass "exists: $NPMRC_TMPL"
  if grep -qE '^@simodelne:registry=https://npm\.pkg\.github\.com$' "$NPMRC_TMPL"; then
    pass ".npmrc.tmpl scopes @simodelne to GitHub Packages"
  else
    fail ".npmrc.tmpl missing '@simodelne:registry=https://npm.pkg.github.com' line"
  fi
  if grep -q '_authToken=${NPM_TOKEN}' "$NPMRC_TMPL"; then
    pass ".npmrc.tmpl wires \${NPM_TOKEN}"
  else
    fail ".npmrc.tmpl missing '\${NPM_TOKEN}' auth wiring"
  fi
  if grep -qE '^always-auth=true$' "$NPMRC_TMPL"; then
    pass ".npmrc.tmpl pins always-auth=true"
  else
    fail ".npmrc.tmpl missing 'always-auth=true'"
  fi
else
  fail "MISSING: $NPMRC_TMPL — scaffolded consumer can't authenticate to GitHub Packages"
fi

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
      -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
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

# Bonus check: workflow .yml.tmpl files YAML-parse (catch colon-in-echo bugs)
echo "[bonus] workflow tmpls YAML-parse after substitution"
for wf in templates/new-consumer/.github/workflows/*.yml.tmpl .github/workflows/*.yml; do
  [[ -f "$wf" ]] || continue
  TMP=$(mktemp)
  sed -e 's/{{CONSUMER_NAME}}/test-c/g' \
      -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
      -e 's/{{GH_OWNER}}/simodelne/g' \
      -e 's/{{PROGRAM_NAME}}/test-p/g' \
      -e 's/{{PROGRAM_SLUG}}/test_p/g' \
      "$wf" > "$TMP"
  if node -e "const y=require('js-yaml'); const fs=require('fs'); y.load(fs.readFileSync('$TMP','utf8'));" 2>/dev/null; then
    pass "$wf YAML-parses"
  else
    fail "$wf FAILS to YAML-parse"
    node -e "const y=require('js-yaml'); const fs=require('fs'); try { y.load(fs.readFileSync('$TMP','utf8')); } catch (e) { console.error('  →', e.message); }" 2>&1 | head -3
  fi
  rm -f "$TMP"
done

# Bonus check: spec.yml.tmpl declares the engine-owned FM5 paths
echo "[bonus] spec.yml.tmpl declares engine-owned FM5 paths"
for p in 'inputs.query_meta.source_path' 'inputs.query_meta.message' 'inputs.query_result.kind'; do
  if grep -q "$p:" "$SPEC_TMPL" 2>/dev/null; then
    pass "FM5: $p declared"
  else
    fail "FM5: $p NOT declared (this breaks v1.8.x sync-out replay)"
  fi
done

# Brief 2 checks — auth scaffold ----------------------------------------
echo "[brief2] auth scaffold files present + Brief 1 stub deleted"
AUTH_DIR="templates/new-consumer/server/auth"
for f in jwt.ts.tmpl middleware.ts.tmpl routes.ts.tmpl types.ts.tmpl magic-link.ts.tmpl config.ts.tmpl; do
  if [[ -f "$AUTH_DIR/$f" ]]; then
    pass "exists: $AUTH_DIR/$f"
  else
    fail "MISSING: $AUTH_DIR/$f"
  fi
done
if [[ -e "$AUTH_DIR/README.md" ]]; then
  fail "Brief 1 stub still present: $AUTH_DIR/README.md (should be deleted)"
else
  pass "Brief 1 stub deleted: $AUTH_DIR/README.md"
fi

echo "[brief2] DB migrations present"
MIG_DIR="templates/new-consumer/db/migrations"
for f in 0001_user_sessions.sql.tmpl 0002_magic_links.sql.tmpl; do
  if [[ -f "$MIG_DIR/$f" ]]; then
    pass "exists: $MIG_DIR/$f"
  else
    fail "MISSING: $MIG_DIR/$f"
  fi
done

echo "[brief2] server/index.ts.tmpl removes Brief 2 TODO + mounts auth"
SERVER_TMPL="templates/new-consumer/server/index.ts.tmpl"
if grep -q "TODO: auth middleware mounts here" "$SERVER_TMPL"; then
  fail "Brief 2 TODO still present in $SERVER_TMPL"
else
  pass "Brief 2 TODO removed from $SERVER_TMPL"
fi
if grep -q "app.use('/api/\*', authMiddleware)" "$SERVER_TMPL"; then
  pass "authMiddleware mounted on /api/*"
else
  fail "authMiddleware NOT mounted on /api/* in $SERVER_TMPL"
fi
if grep -q "app.route('/auth', authRoutes)" "$SERVER_TMPL"; then
  pass "authRoutes mounted on /auth"
else
  fail "authRoutes NOT mounted on /auth in $SERVER_TMPL"
fi
# Order matters: app.route('/auth', ...) MUST come before app.use('/api/*', ...).
ROUTE_LINE=$(grep -n "app.route('/auth', authRoutes)" "$SERVER_TMPL" | head -1 | cut -d: -f1)
USE_LINE=$(grep -n "app.use('/api/\*', authMiddleware)" "$SERVER_TMPL" | head -1 | cut -d: -f1)
if [[ -n "$ROUTE_LINE" && -n "$USE_LINE" && "$ROUTE_LINE" -lt "$USE_LINE" ]]; then
  pass "auth route ordering OK (app.route before app.use)"
else
  fail "auth route ordering WRONG: route=$ROUTE_LINE use=$USE_LINE"
fi

echo "[brief2] .env.example.tmpl documents all 5 auth env vars"
ENV_TMPL="templates/new-consumer/.env.example.tmpl"
for v in PGAS_AUTH_MODE PGAS_JWT_SECRET PGAS_DEV_STATIC_TOKEN PGAS_SESSION_TTL_SECONDS PGAS_MAGIC_LINK_TTL_SECONDS; do
  if grep -q "^${v}=" "$ENV_TMPL"; then
    pass ".env.example.tmpl documents $v"
  else
    fail ".env.example.tmpl missing $v"
  fi
done
# The retired AUTH_DEV_TOKEN should NOT linger.
if grep -q "^AUTH_DEV_TOKEN=" "$ENV_TMPL"; then
  fail ".env.example.tmpl still has retired AUTH_DEV_TOKEN entry"
else
  pass ".env.example.tmpl: retired AUTH_DEV_TOKEN removed"
fi

echo "[brief2] secrets-manifest has Auth section"
SECRETS_TMPL="templates/new-consumer/docs/secrets-manifest.md.tmpl"
if grep -q "^## Auth secrets" "$SECRETS_TMPL"; then
  pass "secrets-manifest has '## Auth secrets' section"
else
  fail "secrets-manifest missing '## Auth secrets' section"
fi
for v in PGAS_JWT_SECRET PGAS_DEV_STATIC_TOKEN; do
  if grep -q "\`${v}\`" "$SECRETS_TMPL"; then
    pass "secrets-manifest lists $v"
  else
    fail "secrets-manifest missing $v"
  fi
done
if grep -q "NEVER COMMIT" "$SECRETS_TMPL"; then
  pass "secrets-manifest has NEVER COMMIT notice"
else
  fail "secrets-manifest missing NEVER COMMIT notice"
fi

echo "[brief2] package.json.tmpl pins better-sqlite3 + jose"
PKG_TMPL="templates/new-consumer/package.json.tmpl"
for dep in 'better-sqlite3' 'jose'; do
  if grep -q "\"$dep\":" "$PKG_TMPL"; then
    pass "package.json.tmpl pins $dep"
  else
    fail "package.json.tmpl missing $dep"
  fi
done

echo "[brief2] rendered .ts files pass node --check"
RENDER_DIR=$(mktemp -d)
for tmpl in "$AUTH_DIR"/*.tmpl; do
  base=$(basename "$tmpl" .tmpl)
  sed -e 's/{{CONSUMER_NAME}}/test-c/g' \
      -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
      -e 's/{{GH_OWNER}}/simodelne/g' \
      "$tmpl" > "$RENDER_DIR/$base"
done
# Render server/index.ts too
sed -e 's/{{CONSUMER_NAME}}/test-c/g' \
    -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
    -e 's/{{GH_OWNER}}/simodelne/g' \
    "$SERVER_TMPL" > "$RENDER_DIR/index.ts"

# Use a tsx-style syntax-only check via node 24's `--check` (works for ESM TS-free JS).
# For .ts files, we use a transpile-free regex sanity check: must NOT contain
# unsubstituted {{...}} markers.
for f in "$RENDER_DIR"/*.ts; do
  if grep -qE '\{\{[A-Z_]+\}\}' "$f"; then
    fail "rendered file contains unsubstituted placeholder: $f"
  else
    pass "rendered file fully substituted: $(basename "$f")"
  fi
done

# Verify rendered server/index.ts has the expected wiring strings (post-render).
if ! grep -q "TODO: auth middleware mounts here" "$RENDER_DIR/index.ts"; then
  pass "rendered index.ts: Brief 2 TODO removed"
else
  fail "rendered index.ts: Brief 2 TODO still present"
fi
if grep -q "app.use('/api/\*', authMiddleware)" "$RENDER_DIR/index.ts"; then
  pass "rendered index.ts: app.use('/api/*', authMiddleware) present"
else
  fail "rendered index.ts: app.use('/api/*', authMiddleware) MISSING"
fi
rm -rf "$RENDER_DIR"

echo "[brief2] DB migrations are syntactically valid SQLite"
if command -v sqlite3 >/dev/null 2>&1; then
  for mig in "$MIG_DIR"/*.sql.tmpl; do
    SUBST=$(mktemp)
    sed -e 's/{{CONSUMER_NAME}}/test-c/g' "$mig" > "$SUBST"
    if sqlite3 :memory: < "$SUBST" 2>/dev/null; then
      pass "sqlite parses: $(basename "$mig")"
    else
      fail "sqlite REJECTED: $(basename "$mig")"
      sqlite3 :memory: < "$SUBST" 2>&1 | head -3
    fi
    rm -f "$SUBST"
  done
else
  echo "  SKIP: sqlite3 CLI not available (CI image should have it)"
fi
# -----------------------------------------------------------------------

# Brief 3 checks — vendored frontend snapshot ----------------------------
echo "[brief3] frontend snapshot files present + Brief 1 stub deleted"
FRONTEND_DIR="templates/frontend"
if [[ -e "$FRONTEND_DIR/README.md" ]]; then
  # README.md MUST exist post-Brief-3 (the *real* README, not the stub).
  # The stub had a "Brief 3 (v0.3 of the plugin) will land" sentence;
  # the real README does not.
  if grep -q "Brief 3 (v0.3 of the plugin) will land" "$FRONTEND_DIR/README.md"; then
    fail "Brief 1 stub still present in $FRONTEND_DIR/README.md"
  else
    pass "$FRONTEND_DIR/README.md exists and is not the Brief 1 stub"
  fi
else
  fail "MISSING: $FRONTEND_DIR/README.md"
fi

# Required snapshot files
FRONTEND_REQUIRED=(
  "package.json.tmpl"
  "index.html.tmpl"
  "vite.config.ts"
  "tsconfig.json"
  "tsconfig.app.json"
  "tsconfig.node.json"
  "eslint.config.js"
  ".env.example.tmpl"
  ".gitignore"
  "src/main.tsx"
  "src/App.tsx.tmpl"
  "src/index.css"
  "src/vite-env.d.ts"
  "src/lib/auth.ts"
  "src/lib/api.ts.tmpl"
  "src/lib/ws.ts"
  "src/lib/navigate.ts"
  "src/stores/auth.ts"
  "src/components/Router.tsx"
  "src/pages/Login.tsx.tmpl"
  "src/pages/MagicLinkCallback.tsx"
  "src/pages/SessionList.tsx.tmpl"
  "src/pages/Chat.tsx.tmpl"
)
for f in "${FRONTEND_REQUIRED[@]}"; do
  if [[ -f "$FRONTEND_DIR/$f" ]]; then
    pass "exists: $FRONTEND_DIR/$f"
  else
    fail "MISSING: $FRONTEND_DIR/$f"
  fi
done

# Discipline check: under 30 source files under templates/frontend/src/
SRC_COUNT=$(find "$FRONTEND_DIR/src" -type f 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SRC_COUNT" -lt 30 ]]; then
  pass "frontend src budget: $SRC_COUNT files under 30"
else
  fail "frontend src OVER BUDGET: $SRC_COUNT files (max 30)"
fi

# All rendered .tmpl files must be fully substituted
echo "[brief3] rendered frontend .tmpl files have no leftover placeholders"
FE_RENDER=$(mktemp -d)
mkdir -p "$FE_RENDER/src/lib" "$FE_RENDER/src/pages"
while IFS= read -r tmpl; do
  rel="${tmpl#$FRONTEND_DIR/}"
  out="$FE_RENDER/${rel%.tmpl}"
  mkdir -p "$(dirname "$out")"
  sed -e 's/{{CONSUMER_NAME}}/test-c/g' \
      -e 's/{{ENGINE_VERSION}}/\^1.13.0/g' \
      -e 's/{{GH_OWNER}}/simodelne/g' \
      "$tmpl" > "$out"
done < <(find "$FRONTEND_DIR" -name "*.tmpl" -type f 2>/dev/null)
RENDERED_TMPLS=0
while IFS= read -r f; do
  RENDERED_TMPLS=$((RENDERED_TMPLS+1))
  if grep -qE '\{\{[A-Z_]+\}\}' "$f"; then
    fail "rendered frontend file contains unsubstituted placeholder: ${f#$FE_RENDER/}"
  else
    pass "rendered frontend file fully substituted: ${f#$FE_RENDER/}"
  fi
done < <(find "$FE_RENDER" -type f)
if [[ "$RENDERED_TMPLS" -gt 0 ]]; then
  pass "rendered $RENDERED_TMPLS .tmpl files from $FRONTEND_DIR"
fi

# package.json.tmpl must parse as JSON after substitution
if node -e "JSON.parse(require('fs').readFileSync('$FE_RENDER/package.json','utf8'))" 2>/dev/null; then
  pass "frontend package.json parses as JSON after substitution"
else
  fail "frontend package.json FAILS JSON parse after substitution"
fi

# Login.tsx must reference VITE_PGAS_AUTH_MODE (so the two auth modes are switchable)
if grep -q "VITE_PGAS_AUTH_MODE" "$FE_RENDER/src/pages/Login.tsx"; then
  pass "rendered Login.tsx switches on VITE_PGAS_AUTH_MODE"
else
  fail "rendered Login.tsx MISSING VITE_PGAS_AUTH_MODE switch"
fi

# auth.ts (verbatim, not .tmpl) must store the token in localStorage
if grep -q "localStorage" "$FRONTEND_DIR/src/lib/auth.ts"; then
  pass "src/lib/auth.ts stores JWT/token in localStorage"
else
  fail "src/lib/auth.ts does NOT use localStorage"
fi

# ws.ts must include the token on connect
if grep -q "token=" "$FRONTEND_DIR/src/lib/ws.ts"; then
  pass "src/lib/ws.ts includes ?token= on WS connect"
else
  fail "src/lib/ws.ts does NOT pass token on WS connect"
fi

rm -rf "$FE_RENDER"
# -----------------------------------------------------------------------

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
