#!/usr/bin/env bash
# plugin-manifest.test.sh — structural smoke test for the plugin manifest.
#
# Validates:
#   1. .claude-plugin/plugin.json is valid JSON.
#   2. Every command file referenced exists.
#   3. Every SKILL.md has valid YAML frontmatter with name: + description:.
#   4. hooks/hooks.json is valid JSON and every referenced hook script exists.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== plugin-manifest.test.sh ==="

# 1. plugin.json valid JSON
echo "[1/4] .claude-plugin/plugin.json is valid JSON"
if [[ -f .claude-plugin/plugin.json ]] && \
   node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))" 2>/dev/null; then
  pass ".claude-plugin/plugin.json parses as JSON"
else
  fail ".claude-plugin/plugin.json missing or invalid JSON"
fi

# 2. Every command file exists
echo "[2/4] command files exist"
for cmd in commands/pgas-new-consumer.md commands/pgas-new-program.md; do
  if [[ -f "$cmd" ]]; then
    pass "exists: $cmd"
  else
    fail "missing: $cmd"
  fi
done

# 3. Every SKILL.md has valid YAML frontmatter with name: + description:
echo "[3/4] SKILL.md frontmatter"
for skill_md in skills/*/SKILL.md; do
  if [[ ! -f "$skill_md" ]]; then
    fail "no skills found"
    continue
  fi
  # Frontmatter: starts and ends with ---
  FIRST_LINE=$(head -1 "$skill_md")
  if [[ "$FIRST_LINE" != "---" ]]; then
    fail "$skill_md does not begin with frontmatter ('---')"
    continue
  fi
  # Extract the frontmatter block (everything between first --- and second ---)
  FRONTMATTER=$(awk '/^---$/{n++; next} n==1{print}' "$skill_md")
  if ! echo "$FRONTMATTER" | grep -qE '^name:'; then
    fail "$skill_md frontmatter missing 'name:' field"
    continue
  fi
  if ! echo "$FRONTMATTER" | grep -qE '^description:'; then
    fail "$skill_md frontmatter missing 'description:' field"
    continue
  fi
  pass "$skill_md frontmatter OK"
done

# 4. hooks.json valid + referenced scripts exist + executable
echo "[4/4] hooks.json + referenced scripts"
if [[ -f hooks/hooks.json ]] && \
   node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8'))" 2>/dev/null; then
  pass "hooks/hooks.json is valid JSON"
else
  fail "hooks/hooks.json missing or invalid JSON"
fi

for hook in hooks/pre-tool-use-spec-validate.sh hooks/post-tool-use-arch-doc-nudge.sh; do
  if [[ -f "$hook" ]]; then
    pass "exists: $hook"
    if [[ -x "$hook" ]]; then
      pass "executable: $hook"
    else
      fail "not executable: $hook (run chmod +x)"
    fi
    # First line must be #!/usr/bin/env bash
    if head -1 "$hook" | grep -qE '^#!/usr/bin/env bash$'; then
      pass "shebang OK: $hook"
    else
      fail "bad shebang in $hook"
    fi
  else
    fail "missing: $hook"
  fi
done

echo ""
echo "=== Result: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
