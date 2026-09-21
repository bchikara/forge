Run the afternoon top-up. The morning pass often falls short of the daily
target — the feed runs dry, an ATS refuses, a screening question holds one
back — so this fills the remainder.

1. Call `forge_search_filter`. If `remainingToday` is 0, stop here and report
   that the target was met this morning. Do not apply anything.

2. Otherwise follow the same steps as the morning application pass, applying
   only up to `remainingToday`.

3. Then run the outreach steps for the companies added in this pass only:
   `forge_find_invite_target`, `forge_find_contacts`, then
   `forge_send_invites` and `forge_send_emails` with `live: true`.

   Quotas are shared with the morning run, so expect invitations to be capped
   already. That is normal, not a failure.

4. Do not call `forge_send_report` — the morning outreach pass already sent
   today's report. Only send a failure alert if this run dies.

Report at the end: how many applications the morning left owed, how many this
pass filled, and whether the target was met.
