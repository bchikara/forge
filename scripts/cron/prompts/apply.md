Run the morning application pass. Work through these steps in order and stop
at the first one that cannot proceed.

1. Call `forge_search_filter`. It returns the arguments to pass to tsenta and
   `remainingToday` — how many applications are still owed today. If
   `remainingToday` is 0, stop and report that the target is already met.

2. Call `mcp__tsenta__get-application-balance`. If the remaining balance is
   below `remainingToday`, apply only up to the balance and say so in the
   report. Never exceed it.

3. Call `mcp__tsenta__get-job-recommendations` with exactly the
   `recommendationArgs` from step 1.

4. Select postings to apply to:
   - Keep only those at or above `minMatchScore`.
   - Prefer `sponsorship: "SPONSORS"` over `"CASE_BY_CASE"` over `"UNKNOWN"`.
     This profile needs H-1B sponsorship, so a sponsoring employer is worth
     more than a marginally better match score.
   - Skip anything whose `yearsOfExperienceMin` exceeds 10 — those are
     director and principal roles above this profile's 7 years.

   - Skip titles above engineering-manager level. Today's first run spent
     credits on a Mastercard VP, a Capital One Senior Director, a Healthie
     Director, a Reducto Head of Platform, a QTS Manager and a GardaWorld
     Senior Manager — six roles that will not convert for a candidate with
     seven years. Skip a title containing:

       Vice President, VP,  President,  Chief,  CTO,  CIO,
       Director,  Senior Director,  Head of,  Partner

     Engineering Manager and Senior Engineering Manager are fine — those are
     a deliberate target. So is Lead, Staff, Principal Engineer and
     Architect, which are senior IC titles rather than executive ones.
     "AVP" and "Assistant Vice President" at a bank are also fine: in
     finance those are individual-contributor grades, not executives.

   - Skip roles outside this profile's area even when the level fits:
     mobile-only (iOS, Android, Swift, Kotlin), pure frontend, embedded or
     firmware, C++-only, data-warehouse or BI, and Salesforce or ServiceNow
     platform work. This is a backend and platform engineer working in
     Node.js, TypeScript and Python.

   - Skip a role that requires sponsorship in a country other than the US.
     A posting can be listed as US-remote while the form asks about
     relocating to and needing sponsorship for another country — the
     Tailscale UK role in today's run is the example. If the title or
     description names a non-US country, skip it.

   - Skip `employmentType: "PART_TIME"`, `"CONTRACT"` and hourly listings
     (a `salaryMax` under 1000 is an hourly rate, not a salary).
   - If the first page runs short, request page 2. Do not lower the score
     floor to fill the target; a short day is the correct outcome.

5. Apply with `mcp__tsenta__apply-to-job`, passing `jobIds` in batches of 10.
   Between batches, check the result for errors. Stop applying if you see
   "out of applications" — that is terminal for the day.

6. Call `mcp__tsenta__list-applications` and pass the result to
   `forge_import_applications`. This records the roles and queues them for
   job-description fetching.

7. Call `forge_roles_needing_jd`. For each role returned, call
   `mcp__tsenta__fetch-job-description` with its url, then `forge_save_jd`
   with the roleId and the text. The fit paragraph in outreach depends on
   this, so do not skip it.

8. Call `forge_next_companies`. For each company, call
   `forge_find_invite_target` — it walks a ladder from engineering manager
   outward and stores whoever it finds. Then call `forge_find_contacts` for
   the same company to resolve email addresses.

9. Clear anything left at `PENDING_SUBMIT_REVIEW`. Call
   `mcp__tsenta__list-applications` with `status: "needs_action"`, and for
   each one call `mcp__tsenta__submit-application-review` with
   `decision: "approve"`.

   Most submit as-filled. A 422 "Answer all required fields" means one or
   two fields were left blank — call `get-application-review` with
   `onlyMissing: true` and `groups: ["questions", "questionnaire"]` to find
   them, then resubmit with `edits` (the parameter is `edits`, not
   `fieldValues`). Answers that recur:

   - Export-control citizenship questions, which list countries such as
     Iran, Cuba, North Korea, Syria, Russia, China: the answer is **No**.
     This candidate is an Indian citizen and India appears on none of those
     lists. This single blank field is what held up most of today's queue.
   - "Describe circumstances of any termination or resignation": **N/A**.
   - "Employed by a government or regulatory entity": **No**.
   - Conflict-of-interest and non-compete questions: **No**.

   Do not invent an answer to anything not covered above. If a blank field
   asks something you cannot determine from the profile, leave that
   application pending and name it in the report — a wrong answer on a form
   the candidate attests is accurate is worse than an unsent application.

Do not send anything in this run. Invitations and email happen in the
outreach pass.

Report at the end: applications submitted, how many were skipped and why,
companies whose contacts were found, and anything that needs a human.
