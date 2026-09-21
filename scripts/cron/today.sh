#!/bin/bash
#
# One-off schedule for today only.
#
# The permanent agents fire at 07:00 / 10:30 / 13:30. When those windows have
# already passed — a first install late in the morning, a laptop that was
# asleep, a run that failed and needs redoing — this schedules the three
# passes at times that still fit into the day, then removes itself. The
# permanent agents are left alone and resume tomorrow.
#
#   today.sh plan                  show the times it would use
#   today.sh start                 schedule from the next sensible slot
#   today.sh start 10:45 12:30 17:30   explicit times
#   today.sh cancel                remove anything still pending
#   today.sh status                what is pending and what has run
#
# Passes are spaced deliberately rather than evenly. Discovery is the slow
# part: Unipile search plus jobright resolution runs roughly two minutes per
# company, so fifty companies is about an hour and a half. Outreach scheduled
# too soon after apply would start sending before contacts exist.

set -uo pipefail

CRON_HOME="$HOME/Library/Application Support/Forge/cron"
LOG_DIR="$HOME/Library/Application Support/Forge/logs"
STATE_DIR="$LOG_DIR/state"
PENDING="$STATE_DIR/today-pending"
ORANGE=$'\033[38;2;255;102;0m'
DIM=$'\033[2m'
RESET=$'\033[0m'

mkdir -p "$STATE_DIR"

# Minutes to allow between apply finishing and outreach starting. Discovery
# for a full day's companies takes most of this.
GAP_APPLY_OUTREACH=105
# Outreach itself runs for a couple of hours at the configured pacing, so the
# top-up sits well clear of it.
GAP_OUTREACH_TOPUP=300

now_epoch() { date '+%s'; }

# "HH:MM" today, as an epoch. Returns empty if the time has already passed.
to_epoch_today() {
  local hhmm="$1"
  local e
  e=$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date '+%Y-%m-%d') ${hhmm}:00" '+%s' 2>/dev/null) || return 1
  echo "$e"
}

fmt() { date -r "$1" '+%H:%M'; }

# Default times: start a few minutes out so there is room to cancel, then
# space the rest by the gaps above.
default_times() {
  local start=$(( $(now_epoch) + 20 * 60 ))
  # Round up to the next five minutes so the schedule reads cleanly.
  start=$(( (start / 300 + 1) * 300 ))
  echo "$start $(( start + GAP_APPLY_OUTREACH * 60 )) $(( start + (GAP_APPLY_OUTREACH + GAP_OUTREACH_TOPUP) * 60 ))"
}

resolve_times() {
  if [[ $# -ge 3 ]]; then
    local out=()
    for t in "$1" "$2" "$3"; do
      local e
      e=$(to_epoch_today "$t") || { echo "bad time: $t (use HH:MM)" >&2; exit 64; }
      out+=("$e")
    done
    echo "${out[@]}"
  else
    default_times
  fi
}

schedule_one() {
  local pass="$1" when="$2"
  local secs=$(( when - $(now_epoch) ))

  if (( secs <= 0 )); then
    echo "  ${DIM}skipping $pass — $(fmt "$when") has passed${RESET}"
    return
  fi

  # `at` is disabled by default on macOS, and a second launchd agent for a
  # one-off is more moving parts than this needs. A detached sleep-then-run
  # is enough: it survives the terminal closing, and its pid is recorded so
  # cancel can find it.
  nohup bash -c "sleep $secs; '$CRON_HOME/run.sh' '$pass'" \
    >> "$LOG_DIR/today-$pass.out" 2>&1 &
  local pid=$!
  disown

  echo "$pid $pass $when" >> "$PENDING"
  printf "  %s▍%s %-9s %s  %s(in %dm)%s\n" \
    "$ORANGE" "$RESET" "$pass" "$(fmt "$when")" "$DIM" $(( secs / 60 )) "$RESET"
}

case "${1:-status}" in
  plan)
    read -r a o t <<< "$(resolve_times "${2:-}" "${3:-}" "${4:-}")"
    echo "would schedule today:"
    printf "  apply     %s\n  outreach  %s\n  topup     %s\n" "$(fmt "$a")" "$(fmt "$o")" "$(fmt "$t")"
    echo
    echo "${DIM}  outreach waits ${GAP_APPLY_OUTREACH}m after apply — contact discovery"
    echo "  runs about two minutes per company${RESET}"
    ;;

  start)
    if [[ -s "$PENDING" ]]; then
      echo "already scheduled for today. Run 'today.sh cancel' first, or 'today.sh status'." >&2
      exit 65
    fi
    read -r a o t <<< "$(resolve_times "${2:-}" "${3:-}" "${4:-}")"
    : > "$PENDING"
    echo "scheduling today only — the 07:00/10:30/13:30 agents are untouched:"
    schedule_one apply    "$a"
    schedule_one outreach "$o"
    schedule_one topup    "$t"
    echo
    echo "${DIM}  cancel: $0 cancel${RESET}"
    echo "${DIM}  logs:   $LOG_DIR/${RESET}"
    ;;

  cancel)
    if [[ ! -s "$PENDING" ]]; then echo "nothing pending today."; exit 0; fi
    while read -r pid pass when; do
      if kill -0 "$pid" 2>/dev/null; then
        # The sleep runs in a subshell; kill the whole process group so the
        # pending run.sh goes with it.
        kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
        echo "cancelled $pass ($(fmt "$when"))"
      else
        echo "${DIM}$pass ($(fmt "$when")) already finished or gone${RESET}"
      fi
    done < "$PENDING"
    rm -f "$PENDING"
    ;;

  status)
    if [[ -s "$PENDING" ]]; then
      echo "pending today:"
      while read -r pid pass when; do
        if kill -0 "$pid" 2>/dev/null; then
          local_secs=$(( when - $(now_epoch) ))
          printf "  %-9s %s  %s\n" "$pass" "$(fmt "$when")" \
            "$( (( local_secs > 0 )) && echo "in $(( local_secs / 60 ))m" || echo "running" )"
        else
          printf "  %-9s %s  done or cancelled\n" "$pass" "$(fmt "$when")"
        fi
      done < "$PENDING"
    else
      echo "nothing scheduled for today."
    fi
    echo
    STAMP="$(date +%Y-%m-%d)"
    for p in apply outreach topup; do
      if [[ -f "$LOG_DIR/$STAMP-$p.log" ]]; then
        printf "  %-9s log exists  %s\n" "$p" "$(grep -c . "$LOG_DIR/$STAMP-$p.log" 2>/dev/null) lines"
      fi
    done
    [[ -f "$STATE_DIR/apply-$STAMP.done" ]] \
      && echo "  apply completed today — outreach will proceed" \
      || echo "  apply not yet completed — outreach would skip"
    ;;

  *)
    echo "usage: today.sh plan|start [HH:MM HH:MM HH:MM]|cancel|status" >&2
    exit 64
    ;;
esac
