Run the outreach pass. Invitations first — they cannot bounce and cost no
sender reputation — then email to everyone an invitation could not reach.

1. Call `forge_status`. If `dryRunDefault` is true, that is fine; the calls
   below pass `live: true` explicitly. Note the quotas: if the weekly invite
   cap or the daily email cap is already reached, skip that channel and say so.

2. Call `forge_queue` with `reclaim: true`. This returns tasks stranded by a
   previous run that died mid-task. Note anything in the dead letter.

3. Call `forge_list_companies`. For each company with contacts and no
   invitations sent yet, call `forge_send_invites` with `live: true` and
   `limit: 1`. One invitation per company: the weekly cap is 280, which
   across 50 companies a day is under one each, so it goes to the single
   best contact — the ladder already ordered them with engineering managers
   first.

   Stop inviting when a call reports the weekly or daily cap reached.

4. For each company, call `forge_send_emails` with `live: true`. Contacts who
   already received an invitation are excluded automatically — one channel per
   person.

   Stop emailing when a call reports the daily cap, the send window, or the
   bounce-rate circuit breaker.

5. Call `forge_send_report`. This emails the daily summary.

If any step fails in a way that stops the run, call `forge_send_report` with
`kind: "failure"`, the stage name, and the error message. A crashed run sends
no daily report, and silence looks like a quiet day.

Report at the end: invitations sent, emails sent, what was capped, and what
is in the dead letter.
