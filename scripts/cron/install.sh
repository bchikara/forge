#!/bin/bash
#
# Install, remove, or inspect the scheduled passes.
#
#   install.sh install    load all three into launchd
#   install.sh uninstall  unload and remove
#   install.sh status     show what is loaded and when each last ran
#   install.sh test PASS  run one pass now, in the foreground
#
# The schedule:
#   07:00  apply     — up to the daily target, then find contacts
#   10:30  outreach  — invitations, then email, then the daily report
#   13:30  topup     — fill whatever the morning left owed
#
# 10:30 is deliberate: mid-morning is when people have cleared their inbox
# but the day has not buried them, and 10:30 ET is 07:30 PT so it reaches
# both coasts at a reasonable hour.
#
# These agents send real email and real LinkedIn invitations with no human
# in the loop. What bounds them is the pipeline's own limits — the weekly
# invite cap, the daily send cap, per-company caps, the bounce circuit
# breaker and the suppression list — not the absence of mistakes. Run
# `install.sh test apply` and read the log before trusting the schedule.

set -uo pipefail

CRON_DIR="$HOME/Library/Application Support/Forge/cron"
LOG_DIR="$HOME/Library/Application Support/Forge/logs"
AGENT_DIR="$HOME/Library/LaunchAgents"
PASSES=(apply outreach topup)
ORANGE=$'\033[38;2;255;102;0m'
RESET=$'\033[0m'

case "${1:-status}" in
  install)
    mkdir -p "$AGENT_DIR" "$LOG_DIR"
    for p in "${PASSES[@]}"; do
      cp "$CRON_DIR/dev.forge.$p.plist" "$AGENT_DIR/"
      # bootout first so a re-install replaces rather than conflicts.
      launchctl bootout "gui/$(id -u)/dev.forge.$p" 2>/dev/null
      launchctl bootstrap "gui/$(id -u)" "$AGENT_DIR/dev.forge.$p.plist"
      echo "${ORANGE}▍${RESET} loaded dev.forge.$p"
    done
    echo
    echo "  07:00  apply     up to the daily target, then find contacts"
    echo "  10:30  outreach  invitations, email, daily report"
    echo "  13:30  topup     fill the morning's shortfall"
    echo
    echo "  logs: $LOG_DIR/"
    echo "  stop: $0 uninstall"
    ;;

  uninstall)
    for p in "${PASSES[@]}"; do
      launchctl bootout "gui/$(id -u)/dev.forge.$p" 2>/dev/null
      rm -f "$AGENT_DIR/dev.forge.$p.plist"
      echo "removed dev.forge.$p"
    done
    ;;

  status)
    for p in "${PASSES[@]}"; do
      if launchctl print "gui/$(id -u)/dev.forge.$p" >/dev/null 2>&1; then
        LAST=$(ls -t "$LOG_DIR"/*-"$p".log 2>/dev/null | head -1)
        printf "%-22s loaded      %s\n" "dev.forge.$p" "${LAST:+last: $(basename "$LAST")}"
      else
        printf "%-22s NOT loaded\n" "dev.forge.$p"
      fi
    done
    if [[ -s "$LOG_DIR/failures.log" ]]; then
      echo
      echo "recent failures:"
      tail -5 "$LOG_DIR/failures.log"
    fi
    ;;

  test)
    PASS="${2:-}"
    if [[ -z "$PASS" ]]; then
      echo "usage: install.sh test apply|outreach|topup" >&2
      exit 64
    fi
    echo "${ORANGE}▍${RESET} running $PASS in the foreground — this sends for real"
    exec "$CRON_DIR/run.sh" "$PASS"
    ;;

  *)
    echo "usage: install.sh install|uninstall|status|test PASS" >&2
    exit 64
    ;;
esac
