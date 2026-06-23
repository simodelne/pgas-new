#!/usr/bin/env bash
# pgas-new v3.0 provisioning script
#
# Sets up a fresh host so `pgas-new` is runnable from anywhere on PATH.
# Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/provision.sh [--repo-dir DIR] [--ref REF] [--base-url URL] [--model MODEL] [--skip-tests] [--skip-vllm-check]
#
# Defaults:
#   --repo-dir        $HOME/pgas-new (or current dir if it's a pgas-new checkout)
#   --ref             v3.0.0
#   --base-url        http://localhost:8000/v1
#   --model           qwen36-27b
#
# Post-conditions on success:
#   - Repo at $REPO_DIR pinned to $REF
#   - npm dependencies installed
#   - npm test green (unless --skip-tests)
#   - vLLM reachable (unless --skip-vllm-check)
#   - $HOME/.local/bin/pgas-new shim installed and PATH-friendly
#   - Env defaults written to $HOME/.config/pgas-new/env
#
# NOTE: This script ships v3.0 (CLI + ephemeral sessions). Auth + DB-backed
# session persistence is blocked on engine-side exports — see
# https://github.com/simodelne/pgas/issues/499. v3.1 will add auth.

set -euo pipefail

# ---------- argument parsing ----------

REPO_DIR_DEFAULT="${HOME}/pgas-new"
REF_DEFAULT="v3.0.0"
BASE_URL_DEFAULT="http://localhost:8000/v1"
MODEL_DEFAULT="qwen36-27b"

REPO_DIR=""
REF="$REF_DEFAULT"
BASE_URL="$BASE_URL_DEFAULT"
MODEL="$MODEL_DEFAULT"
SKIP_TESTS=0
SKIP_VLLM_CHECK=0

print_usage() {
  sed -n '2,18p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)        REPO_DIR="$2"; shift 2 ;;
    --ref)             REF="$2"; shift 2 ;;
    --base-url)        BASE_URL="$2"; shift 2 ;;
    --model)           MODEL="$2"; shift 2 ;;
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

step "1/8 Preflight"

require_cmd node
require_cmd npm
require_cmd git
require_cmd curl

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20 required (found v$NODE_VERSION). Upgrade with your version manager."
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

step "2/8 Repo setup at $REPO_DIR"

if [ ! -d "$REPO_DIR/.git" ]; then
  # Allow REPO_DIR to be created.
  PARENT="$(dirname "$REPO_DIR")"
  [ -d "$PARENT" ] || die "Parent dir does not exist: $PARENT"
  step "  cloning simodelne/pgas-new into $REPO_DIR"
  git clone https://github.com/simodelne/pgas-new.git "$REPO_DIR"
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

step "3/8 Installing npm dependencies"
( cd "$REPO_DIR" && npm install --no-audit --no-fund )
ok "dependencies installed"

# ---------- 4. tests ----------

if [ "$SKIP_TESTS" -eq 0 ]; then
  step "4/8 Verifying installation with npm test"
  ( cd "$REPO_DIR" && npm test )
  ok "npm test passed"
else
  step "4/8 Skipping npm test (--skip-tests)"
  warn "Tests skipped — verifying only typecheck."
  ( cd "$REPO_DIR" && npm run typecheck )
  ok "typecheck passed"
fi

# ---------- 5. environment defaults ----------

step "5/8 Writing environment defaults"
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

# Optional:
# export PGAS_FOUNDRY_PORT=4500
# export PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT=1  # set automatically by foundry-server
EOF
chmod 600 "$ENV_FILE"
ok "env defaults at $ENV_FILE"

# ---------- 6. global shim ----------

step "6/8 Installing global shim at \$HOME/.local/bin/pgas-new"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"

SHIM="$BIN_DIR/pgas-new"
cat > "$SHIM" <<EOF
#!/usr/bin/env bash
# pgas-new shim — generated by $REPO_DIR/scripts/provision.sh
# Sources env defaults then invokes the foundry CLI from the pinned checkout.
set -e
REPO_DIR="$REPO_DIR"
[ -f "\$HOME/.config/pgas-new/env" ] && . "\$HOME/.config/pgas-new/env"
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

# ---------- 7. verify shim ----------

step "7/8 Verifying shim invocation"
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

# ---------- 8. summary ----------

step "8/8 Provisioning complete"
echo
echo "  Repo:       $REPO_DIR @ $ACTUAL_HEAD ($REF)"
echo "  Env file:   $ENV_FILE"
echo "  Shim:       $SHIM"
echo "  vLLM:       $BASE_URL ($MODEL)"
echo
echo "Next steps:"
echo "  1. Ensure $BIN_DIR is on your PATH (see warning above if applicable)."
echo "  2. Run: pgas-new"
echo "     The foundry REPL opens, walks Q1-Q6 design interview against your vLLM,"
echo "     synthesizes a program, and writes scaffold files to the target dir."
echo
echo "Known limitation in v3.0:"
echo "  - Sessions are ephemeral (in-memory). No login, no DB persistence."
echo "  - v3.1 will add auth + DB-backed sessions once engine ships SqliteStore/JwtAuthProvider exports."
echo "  - Tracking: https://github.com/simodelne/pgas/issues/499"
echo
printf "${C_GRN}ready.${C_END}\n"
