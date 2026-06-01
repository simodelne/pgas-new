#!/usr/bin/env bash
# post-tool-use-arch-doc-nudge.sh
#
# Claude Code PostToolUse hook for the claude-pgas-plugin.
#
# Triggers on Bash tool calls. When the command is `npm publish*`,
# reads the package version from `package.json`. If the version is a
# `.0` (a minor or major bump), checks for the matching
# `audit/ARCHITECTURE-<consumer>-v<MAJOR>.<MINOR>.0.md` file. If absent,
# prints a SOFT NUDGE (not a block — per pgas#254 v1.0.0 § 5 the
# enforcement tier is soft + medium, NOT hard CI gate).
#
# This is the medium-tier reminder described in
# CONSUMER-VERSIONING-CONTRACT § 5.

set -euo pipefail

INPUT="$(cat 2>/dev/null || true)"
COMMAND="$(printf '%s' "$INPUT" | grep -oE '"command"\s*:\s*"[^"]*"' | head -1 | sed -E 's/.*"command"\s*:\s*"([^"]*)"/\1/' || true)"

# Only act on npm publish invocations
if [[ "$COMMAND" != npm\ publish* ]]; then
  exit 0
fi

# Only act if we're in a pgas consumer
if ! grep -q '"@simodelne/pgas-' package.json 2>/dev/null; then
  exit 0
fi

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
[[ -z "$VERSION" ]] && exit 0

# Is this a .0 bump (minor or major)?
PATCH="$(echo "$VERSION" | awk -F. '{print $3}')"
if [[ "$PATCH" != "0" ]]; then
  # Patch release — per CONSUMER-VERSIONING-CONTRACT § 4, no new doc needed
  exit 0
fi

CONSUMER="$(node -p "require('./package.json').name.replace(/^@[^/]+\//, '')" 2>/dev/null || echo "consumer")"
MAJOR_MINOR="$(echo "$VERSION" | awk -F. '{print $1"."$2".0"}')"
EXPECTED="audit/ARCHITECTURE-${CONSUMER}-v${MAJOR_MINOR}.md"

if [[ -f "$EXPECTED" ]]; then
  # Doc exists — silent OK
  exit 0
fi

# Soft nudge
cat >&2 <<EOF

[pgas-plugin] WARNING: published v${VERSION} without a matching architecture doc.

  Expected file: ${EXPECTED}

  Per simodelne/pgas CONSUMER-VERSIONING-CONTRACT.md § 1:
    Every consumer major or minor version cut ships a corresponding
    audit/ARCHITECTURE-<consumer>-v<MAJOR>.<MINOR>.0.md document in the
    consumer's own repo.

  Enforcement is currently soft + medium (not a CI gate) per § 5 of the
  contract. This is a reminder, not a block — but the pgas curator MAY
  flag the missing doc during PR review (Channel 3) and a future
  contract revision MAY escalate to a hard CI gate.

  Recommended next step:
    1. Generate the doc with the /pgas:architecture-doc skill.
    2. Open a follow-up PR titled "docs: add architecture doc for v${VERSION}".
    3. Link the doc from the v${VERSION} release notes.

EOF

# Exit 0 — soft nudge does not block
exit 0
