# Scheduled passes

Three launchd agents, at 07:00, 10:30 and 13:30.

## Why these files run from Application Support, not from here

macOS TCC denies launchd-spawned processes access to Desktop, Documents and
Downloads. This was not theoretical: the first installed run exited 126 with

    shell-init: error retrieving current directory: getcwd: Operation not permitted
    /bin/bash: .../scripts/cron/run.sh: Operation not permitted

A probe agent confirmed the boundary precisely — it could `cd` into
`~/Desktop/Project`, but could not list `~/Desktop/Forge/data`, and could read
`~/Library/Application Support/Forge/cron` fine.

So the installed copy lives at `~/Library/Application Support/Forge/cron`, and
the database and logs at `~/Library/Application Support/Forge/{data,logs}`.
The copies here are the versioned source; `install.sh` runs from the installed
location.

To re-sync after editing here:

    cp -R scripts/cron/ ~/Library/Application\ Support/Forge/cron/
    ~/Library/Application\ Support/Forge/cron/install.sh install

## Why outreach checks whether apply ran

launchd fires each pass independently with no notion of the others. Without a
check, an apply pass that failed — a blocked agent, a closed laptop, an expired
credential — is followed by an outreach pass that finds no new companies, sends
nothing, and mails a report full of zeros. That report reads like a quiet day
rather than a broken one, which hides the failure behind a successful-looking
run.

So `apply` and `topup` write `logs/state/apply-YYYY-MM-DD.done` on success, and
`outreach` exits early without it — logging why and emailing a failure alert.

## Why each pass carries an explicit --allowedTools list

`--permission-mode acceptEdits` covers file edits, not MCP calls. Verified:
both servers connected and both tool schemas loaded, then every call was
refused at the permission layer. An installed cron would have connected, found
its tools, and done nothing.

The allowlist is also the real boundary on an unattended run. The apply pass
has no send tools listed, so it cannot email or invite even if instructed to.

## Managing

    ./install.sh install      load all three
    ./install.sh status        what is loaded, last log, recent failures
    ./install.sh test apply    run one pass now, in the foreground — sends for real
    ./install.sh uninstall     stop everything
