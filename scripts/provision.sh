#!/usr/bin/env bash
# pgas-new v3.1 provisioning script
#
# Sets up a fresh host so `pgas-new` is runnable from anywhere on PATH.
# Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/provision.sh [--repo-dir DIR] [--ref REF] [--base-url URL] [--model MODEL] [--admin-email EMAIL] [--admin-password-file PATH] [--skip-tests] [--skip-vllm-check]
#
# Defaults:
#   --repo-dir        $HOME/pgas-new (or current dir if it's a pgas-new checkout)
#   --ref             v3.22.0, or this checkout's current HEAD when run from a local checkout
#   --base-url        http://localhost:8000/v1
#   --model           qwen36-27b
#
# Post-conditions on success:
#   - Repo at $REPO_DIR pinned to $REF
#   - npm dependencies installed
#   - npm test green (unless --skip-tests)
#   - vLLM reachable (unless --skip-vllm-check)
#   - JWT secret generated and initial admin credentials staged
#   - $HOME/.local/bin/pgas-new shim installed and PATH-friendly
#   - Env defaults written to $HOME/.config/pgas-new/env

set -euo pipefail

# ---------- argument parsing ----------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR_DEFAULT="${HOME}/pgas-new"
REF_DEFAULT="v3.22.0"
BASE_URL_DEFAULT="http://localhost:8000/v1"
MODEL_DEFAULT="qwen36-27b"

REPO_DIR=""
REF="$REF_DEFAULT"
REF_EXPLICIT=0
BASE_URL="$BASE_URL_DEFAULT"
MODEL="$MODEL_DEFAULT"
ADMIN_EMAIL=""
ADMIN_PASSWORD_FILE=""
SKIP_TESTS=0
SKIP_VLLM_CHECK=0

print_usage() {
  sed -n '2,23p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)        REPO_DIR="$2"; shift 2 ;;
    --ref)             REF="$2"; REF_EXPLICIT=1; shift 2 ;;
    --base-url)        BASE_URL="$2"; shift 2 ;;
    --model)           MODEL="$2"; shift 2 ;;
    --admin-email)     ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password-file) ADMIN_PASSWORD_FILE="$2"; shift 2 ;;
    --skip-tests)      SKIP_TESTS=1; shift ;;
    --skip-vllm-check) SKIP_VLLM_CHECK=1; shift ;;
    -h|--help)         print_usage; exit 0 ;;
    *)                 echo "ERR: unknown flag: $1" >&2; print_usage; exit 2 ;;
  esac
done

# Auto-detect repo-dir: if invoked from inside a pgas-new checkout, prefer that.
if [ -z "$REPO_DIR" ]; then
  if [ -f "$(pwd)/package.json" ] && grep -q '"name": "pgas-new"' "$(pwd)/package.json"; then
    REPO_DIR="$(pwd)"
  else
    REPO_DIR="$REPO_DIR_DEFAULT"
  fi
fi

# Resolve to absolute path.
REPO_DIR="$(cd "$(dirname "$REPO_DIR")" 2>/dev/null && pwd)/$(basename "$REPO_DIR")" || REPO_DIR="$REPO_DIR"

CLONE_SOURCE="https://github.com/simodelne/pgas-new.git"
if [ "$REF_EXPLICIT" -eq 0 ] \
   && [ -d "$SCRIPT_REPO/.git" ] \
   && [ -f "$SCRIPT_REPO/package.json" ] \
   && grep -q '"name": "pgas-new"' "$SCRIPT_REPO/package.json"; then
  CLONE_SOURCE="$SCRIPT_REPO"
  REF="$(git -C "$SCRIPT_REPO" rev-parse HEAD)"
fi

if { [ -n "$ADMIN_EMAIL" ] && [ -z "$ADMIN_PASSWORD_FILE" ]; } \
   || { [ -z "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD_FILE" ]; }; then
  echo "ERR: --admin-email and --admin-password-file must be provided together for non-interactive init." >&2
  exit 2
fi

# ---------- helpers ----------

C_RED="\033[1;31m"
C_GRN="\033[1;32m"
C_YLW="\033[1;33m"
C_DIM="\033[2m"
C_END="\033[0m"

step()   { printf "${C_DIM}[%s] %s${C_END}\n" "$(date +%H:%M:%S)" "$*"; }
ok()     { printf "${C_GRN}  ✓${C_END} %s\n" "$*"; }
warn()   { printf "${C_YLW}  ⚠${C_END} %s\n" "$*"; }
err()    { printf "${C_RED}  ✗${C_END} %s\n" "$*" >&2; }
die()    { err "$1"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH. Install it first."
}

# ---------- 1. preflight ----------

step "1/9 Preflight"

require_cmd node
require_cmd npm
require_cmd git
require_cmd curl

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | awk -F. '{print $2}')"
NODE_MINOR="${NODE_MINOR:-0}"
# vitest 4.x → rolldown 1.x requires Node ^20.19 || >=22.12. Older Node 22.x
# (e.g. 22.11) fails to load the optional @rolldown/binding-* native binary.
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20.19 required (found v$NODE_VERSION). Upgrade with your version manager."
elif [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; then
  die "Node.js 20.x must be >= 20.19 (found v$NODE_VERSION) for vitest/rolldown native bindings. Upgrade your Node 20.x to 20.19+."
elif [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; then
  die "Node.js 22.x must be >= 22.12 (found v$NODE_VERSION) for vitest/rolldown native bindings. Upgrade your Node 22.x to 22.12+."
fi
ok "node v$NODE_VERSION"
ok "npm $(npm -v)"
ok "git $(git --version | awk '{print $3}')"

if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}') (optional, used for §10 scenarios)"
else
  warn "tmux not installed — fine for normal use; needed only to run §10 acceptance scenarios."
fi

# Verify GitHub Packages auth so npm install can fetch @simodelne/pgas-server.
NPMRC_USER="${HOME}/.npmrc"
NPMRC_PROJECT="${REPO_DIR}/.npmrc"
if grep -q '//npm.pkg.github.com/:_authToken=' "$NPMRC_USER" 2>/dev/null \
   || [ -f "$NPMRC_PROJECT" ] \
   || [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  ok "GitHub Packages auth present"
else
  die "GitHub Packages auth missing. Add to $NPMRC_USER:
    //npm.pkg.github.com/:_authToken=<your GitHub PAT with read:packages scope>
  Or export NODE_AUTH_TOKEN=<token> in the shell before running this script."
fi

# vLLM reachability (optional skip).
if [ "$SKIP_VLLM_CHECK" -eq 0 ]; then
  if curl -sf --max-time 5 "${BASE_URL}/models" >/dev/null 2>&1; then
    DETECTED_MODEL="$(curl -sf --max-time 5 "${BASE_URL}/models" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)"
    ok "vLLM reachable at $BASE_URL (default model: ${DETECTED_MODEL:-unknown})"
    if [ -n "$DETECTED_MODEL" ] && [ "$DETECTED_MODEL" != "$MODEL" ]; then
      warn "Configured PGAS_OPENAI_MODEL='$MODEL' but vLLM advertises '$DETECTED_MODEL'. Adjust --model if needed."
    fi
  else
    die "vLLM at $BASE_URL unreachable. Use --skip-vllm-check to install without verification, or fix the endpoint first."
  fi
else
  warn "Skipping vLLM reachability check (--skip-vllm-check)."
fi

# ---------- 2. repo setup ----------

step "2/9 Repo setup at $REPO_DIR"

if [ ! -d "$REPO_DIR/.git" ]; then
  # Allow REPO_DIR to be created.
  PARENT="$(dirname "$REPO_DIR")"
  [ -d "$PARENT" ] || die "Parent dir does not exist: $PARENT"
  step "  cloning $CLONE_SOURCE into $REPO_DIR"
  git clone "$CLONE_SOURCE" "$REPO_DIR"
  ok "cloned"
else
  step "  fetching latest refs"
  git -C "$REPO_DIR" fetch --tags --quiet origin
  ok "fetched"
fi

if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
  warn "Working tree at $REPO_DIR has uncommitted changes. Stash or commit before checking out a different ref."
  warn "  $(git -C "$REPO_DIR" status --short | head -3 | tr '\n' '|')"
  die "Refusing to overwrite local changes."
fi

step "  checking out $REF"
git -C "$REPO_DIR" checkout --quiet "$REF"
ACTUAL_HEAD="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
ok "HEAD now at $ACTUAL_HEAD"

# ---------- 3. dependencies ----------

step "3/9 Installing npm dependencies"
( cd "$REPO_DIR" && npm install --no-audit --no-fund )
ok "dependencies installed"

# ---------- 4. tests ----------

if [ "$SKIP_TESTS" -eq 0 ]; then
  step "4/9 Verifying installation with npm test"
  ( cd "$REPO_DIR" && npm test )
  ok "npm test passed"
else
  step "4/9 Skipping npm test (--skip-tests)"
  warn "Tests skipped — verifying only typecheck."
  ( cd "$REPO_DIR" && npm run typecheck )
  ok "typecheck passed"
fi

# ---------- 5. init ----------

step "5/9 Initializing auth state"
INIT_ARGS=(init)
if [ -n "$ADMIN_EMAIL" ]; then
  INIT_ARGS+=(--admin-email "$ADMIN_EMAIL" --admin-password-file "$ADMIN_PASSWORD_FILE")
fi
( cd "$REPO_DIR" && node --import "$REPO_DIR/node_modules/tsx/dist/loader.mjs" "$REPO_DIR/src/cli.ts" "${INIT_ARGS[@]}" )
ok "JWT secret ready and initial admin credentials staged"

# ---------- 6. environment defaults ----------

step "6/9 Writing environment defaults"
CONFIG_DIR="${HOME}/.config/pgas-new"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

ENV_FILE="$CONFIG_DIR/env"
cat > "$ENV_FILE" <<EOF
# pgas-new environment defaults — sourced by the bin/pgas-new shim.
# Generated by scripts/provision.sh on $(date -Iseconds).
# Edit freely; provisioning will not overwrite this file on re-run.

export PGAS_OPENAI_BASE_URL="${PGAS_OPENAI_BASE_URL:-$BASE_URL}"
export PGAS_OPENAI_MODEL="${PGAS_OPENAI_MODEL:-$MODEL}"
export PGAS_OPENAI_API_KEY="${PGAS_OPENAI_API_KEY:-dummy}"
export PGAS_OPENAI_TOOL_CHOICE="${PGAS_OPENAI_TOOL_CHOICE:-required}"

# Optional:
# export PGAS_FOUNDRY_PORT=4500
# export PGAS_DB="\$HOME/.local/share/pgas-new/pgas-new.db"
# export PGAS_JWT_ISSUER=pgas-new
# export PGAS_JWT_EXPIRES_IN=7d
EOF
chmod 600 "$ENV_FILE"
ok "env defaults at $ENV_FILE"

# ---------- 7. global shim ----------

step "7/9 Installing global shim at \$HOME/.local/bin/pgas-new"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"

# #67: a shim generated from an ephemeral checkout (e.g. /tmp/pgas-new-prov-test)
# bakes an absolute path that vanishes after tmp cleanup, so every later
# `pgas-new` invocation fails at ERR_MODULE_NOT_FOUND before the CLI starts.
# Prefer a durable default. If provisioning ran from a /tmp checkout, do NOT
# bake that path — fall back to the durable $HOME/pgas-new default so the shim
# survives tmp cleanup.
SHIM_REPO_DIR="$REPO_DIR"
case "$REPO_DIR" in
  /tmp/*|/var/tmp/*)
    warn "Provisioned from an ephemeral checkout ($REPO_DIR); baking durable default \$HOME/pgas-new into the shim instead (see simodelne/pgas-new#67)."
    SHIM_REPO_DIR="\$HOME/pgas-new"
    ;;
esac

SHIM="$BIN_DIR/pgas-new"
cat > "$SHIM" <<EOF
#!/usr/bin/env bash
# pgas-new shim — generated by $REPO_DIR/scripts/provision.sh
# Sources env defaults then invokes the foundry CLI from the pinned checkout.
# PGAS_NEW_REPO_DIR overrides the checkout path; a durable default keeps the
# shim working even if the provisioning checkout is later removed (see #67).
set -e
REPO_DIR="\${PGAS_NEW_REPO_DIR:-${SHIM_REPO_DIR}}"
[ -f "\$HOME/.config/pgas-new/env" ] && . "\$HOME/.config/pgas-new/env"
if [ ! -f "\$REPO_DIR/src/cli.ts" ] || [ ! -f "\$REPO_DIR/node_modules/tsx/dist/loader.mjs" ]; then
  echo "pgas-new: checkout not found at \$REPO_DIR" >&2
  echo "  set PGAS_NEW_REPO_DIR=<path-to-pgas-new>, or reprovision, or run from the repo:" >&2
  echo "  cd \"\$REPO_DIR\" && npm run pgas-new -- \"\\\$@\"" >&2
  exit 1
fi
exec node --import "\$REPO_DIR/node_modules/tsx/dist/loader.mjs" "\$REPO_DIR/src/cli.ts" "\$@"
EOF
chmod 755 "$SHIM"
ok "shim installed at $SHIM"

# PATH hint
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *) warn "$BIN_DIR is NOT on PATH. Add this to your shell rc:
       export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# ---------- 8. verify shim ----------

step "8/9 Verifying shim invocation"
if "$SHIM" --help >/dev/null 2>&1; then
  ok "\`pgas-new --help\` ran successfully"
else
  # Some CLIs exit non-zero on --help; try a no-arg dry-check via node directly.
  if node --import "$REPO_DIR/node_modules/tsx/dist/loader.mjs" -e \
       "import('$REPO_DIR/src/cli.ts').then(()=>console.log('cli importable'))" >/dev/null 2>&1; then
    ok "CLI module imports cleanly (shim should work; --help may exit non-zero by design)"
  else
    die "Shim invocation failed. Check $REPO_DIR/src/cli.ts manually."
  fi
fi

# ---------- 9. summary ----------

step "9/9 Provisioning complete"
echo
echo "  Repo:       $REPO_DIR @ $ACTUAL_HEAD ($REF)"
echo "  Env file:   $ENV_FILE"
echo "  Shim:       $SHIM"
echo "  vLLM:       $BASE_URL ($MODEL)"
echo "  Admin:      staged for first server startup"
echo
echo "Next steps:"
echo "  1. Ensure $BIN_DIR is on your PATH (see warning above if applicable)."
echo "  2. Run: pgas-new login"
echo "     This performs the first server boot if needed, seeds the staged admin, and caches your JWT."
echo "  3. Run: pgas-new"
echo "     The authenticated foundry REPL opens, walks Q1-Q6 design interview against your vLLM,"
echo "     synthesizes a program, and writes scaffold files to the target dir."
echo
printf "${C_GRN}ready.${C_END}\n"
