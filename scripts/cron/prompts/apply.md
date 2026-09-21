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
   - Skip `employmentType: "PART_TIME"` and hourly listings.
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

Do not send anything in this run. Invitations and email happen in the
outreach pass.

Report at the end: applications submitted, how many were skipped and why,
companies whose contacts were found, and anything that needs a human.
