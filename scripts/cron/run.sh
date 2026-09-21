#!/bin/bash
#
# Cron runner. Drives one pass of the pipeline through the Claude CLI, which
# is what can speak to both MCP servers — tsenta applies to jobs, Forge does
# the outreach. launchd cannot call MCP tools on its own.
#
# Usage:  run.sh apply | outreach | topup
#
# Exits non-zero on failure so launchd records it, and writes a failure marker
# the next run can notice.

set -uo pipefail

PASS="${1:-}"
FORGE_DIR="/Users/vipul/Desktop/Forge"
PROMPT_FILE="$FORGE_DIR/scripts/cron/prompts/${PASS}.md"
LOG_DIR="$FORGE_DIR/logs"
STAMP="$(date +%Y-%m-%d)"
LOG="$LOG_DIR/${STAMP}-${PASS}.log"

# The pass has to run from here, not from Forge. MCP servers are scoped per
# project directory: tsenta is registered against ~/Desktop/Project, while
# forge is at user scope and therefore visible everywhere. Running from
# ~/Desktop/Forge would load forge and silently lose tsenta, so the pass
# would have no way to apply to anything.
RUN_DIR="/Users/vipul/Desktop/Project"

# launchd starts with a minimal environment: without this, node, claude and
# any version manager shims are all missing.
export PATH="/Users/vipul/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [[ -z "$PASS" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run.sh apply|outreach|topup" >&2
  exit 64
fi

mkdir -p "$LOG_DIR"

{
  echo "==============================================================="
  echo "pass:    $PASS"
  echo "started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "==============================================================="
} >> "$LOG"

cd "$RUN_DIR" || exit 70

# Tools each pass is allowed to call.
#
# --permission-mode acceptEdits is not enough on its own: it covers file
# edits, not MCP calls, so without an explicit allowlist every tool call is
# refused and the pass connects, finds the tools, and does nothing. The
# allowlist is also the real boundary on an unattended run — the apply pass
# cannot send email or invitations because those tools are not listed for it.
READ_TOOLS="mcp__forge__forge_status,mcp__forge__forge_queue,mcp__forge__forge_list_companies,mcp__forge__forge_search_filter,mcp__tsenta__get-application-balance"

APPLY_TOOLS="$READ_TOOLS,mcp__tsenta__get-job-recommendations,mcp__tsenta__apply-to-job,mcp__tsenta__list-applications,mcp__tsenta__fetch-job-description,mcp__forge__forge_import_applications,mcp__forge__forge_roles_needing_jd,mcp__forge__forge_save_jd,mcp__forge__forge_next_companies,mcp__forge__forge_find_invite_target,mcp__forge__forge_find_contacts"

OUTREACH_TOOLS="$READ_TOOLS,mcp__forge__forge_preview,mcp__forge__forge_send_invites,mcp__forge__forge_send_emails,mcp__forge__forge_send_report,mcp__forge__forge_suppress"

case "$PASS" in
  apply)    ALLOWED="$APPLY_TOOLS" ;;
  outreach) ALLOWED="$OUTREACH_TOOLS" ;;
  # The top-up applies and then reaches out for what it added, so it needs
  # both sets.
  topup)    ALLOWED="$APPLY_TOOLS,$OUTREACH_TOOLS" ;;
  *)        echo "unknown pass: $PASS" >&2; exit 64 ;;
esac

# A single long turn: the model drives both MCP servers to completion.
claude \
  --print \
  --permission-mode acceptEdits \
  --allowedTools "$ALLOWED" \
  --append-system-prompt "You are running an unattended scheduled pass. Nobody is watching, so never ask a question — if something is ambiguous, take the conservative option and note it in your report. Respect every cap the tools report rather than working around it. Stop on the first error that prevents the pass from continuing." \
  < "$PROMPT_FILE" \
  >> "$LOG" 2>&1

STATUS=$?

{
  echo "---------------------------------------------------------------"
  echo "finished: $(date '+%Y-%m-%d %H:%M:%S %Z')  exit=$STATUS"
  echo ""
} >> "$LOG"

if [[ $STATUS -ne 0 ]]; then
  # Leave a marker so a later pass — and the operator — can see this failed
  # even if the failure alert itself could not be sent.
  echo "$(date '+%Y-%m-%d %H:%M:%S') $PASS exit=$STATUS" >> "$LOG_DIR/failures.log"
fi

# Keep two weeks of logs; these accumulate quickly at one run per pass per day.
find "$LOG_DIR" -name '*.log' -mtime +14 -delete 2>/dev/null

exit $STATUS
