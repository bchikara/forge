"""
Job description fetcher for JavaScript-rendered ATSes.

tsenta's scraper handles static boards — Greenhouse, Ashby, Workable,
Lever — but returns an error for Workday and Oracle Cloud, which render
their postings client side. That is 29 of this account's 32 missing
descriptions, and the fit paragraph in outreach is built from this text,
so those roles fall back to generic copy without it.

Patchright rather than plain Playwright: both ATSes fingerprint
automated browsers, and Patchright is a Playwright fork that patches the
usual tells. It is already present from the LinkedIn MCP install.

The hard part is not rendering, it is knowing when the posting has
arrived. These pages paint a shell immediately and fill the description
several hundred milliseconds later, so a fixed wait is either too slow
for every page or too short for the one that matters. Instead this waits
for a container that actually holds prose.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, asdict

try:
    from patchright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print(
        json.dumps({"status": "error", "error": "patchright not installed: pip3 install patchright"}),
        flush=True,
    )
    raise SystemExit(1)


# Where each ATS puts the description. Ordered most to least specific:
# a page often matches a generic selector with navigation chrome, so the
# precise one has to win.
SELECTORS = {
    "workday": [
        '[data-automation-id="jobPostingDescription"]',
        '[data-automation-id="job-posting-details"]',
        ".jobDescription",
    ],
    "oraclecloud": [
        ".job-details__description-content",
        '[data-bind*="jobDescription"]',
        ".job-details",
        "#job-details",
    ],
    "brassring": [
        ".jobdescription",
        "#JobDescription",
        '[id*="Job_Description"]',
    ],
    "generic": [
        '[class*="job-description" i]',
        '[class*="jobDescription" i]',
        '[id*="job-description" i]',
        "article",
        "main",
    ],
}


def detect_ats(url: str) -> str:
    u = url.lower()
    if "myworkdayjobs.com" in u or "wd1." in u or "wd3." in u or "wd5." in u or "wd12." in u:
        return "workday"
    if "oraclecloud.com" in u or "fa.ocs.oraclecloud" in u:
        return "oraclecloud"
    if "brassring.com" in u or "sjobs.brassring" in u:
        return "brassring"
    return "generic"


@dataclass
class Result:
    status: str          # success | failed | expired
    url: str
    ats: str
    jobDescription: str | None = None
    chars: int = 0
    selector: str | None = None
    error: str | None = None


# Phrases that mean the posting is gone rather than slow to load. Worth
# distinguishing: a closed posting should not be retried, a slow one
# should.
EXPIRED_MARKERS = [
    "no longer accepting",
    "job posting is no longer",
    "position has been filled",
    "this job is no longer available",
    "requisition is closed",
]


def clean(text: str) -> str:
    """Collapse the whitespace a rendered page leaves behind."""
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


# A form's field labels read as plausible prose to a length check but
# describe the application, not the job. Saving one poisons the fit
# paragraph, which is built from this text — a Patronus AI fetch came
# back as "First Name*, Last Name*, Email*" and would have produced
# outreach citing form fields as evidence of a match.
FORM_MARKERS = [
    "indicates a required field",
    "first name*",
    "last name*",
    "resume/cv",
    "attach resume",
    "upload resume",
    "drop files here",
]


def form_starts_at(text: str) -> int | None:
    """
    Where the application form begins, or None if there is no form.

    Position is what distinguishes the two cases, not presence. A
    Greenhouse posting page appends its form to the bottom of a real
    description — Fanatics had 5,500 characters of posting before the
    first field label. A form page starts with those labels: Patronus
    opened with "indicates a required field" 23 characters in.
    """
    low = text.lower()
    hits = [low.find(m) for m in FORM_MARKERS if m in low]
    return min(hits) if hits else None


# A form appearing this early means the page is the form rather than a
# posting with one attached.
FORM_HEAD_FRACTION = 0.25


def split_off_form(text: str) -> tuple[str, bool]:
    """
    Return the posting with any trailing form removed, and whether the
    page was a form rather than a posting.

    Trimming matters as much as rejecting: leaving "First Name*, Email*,
    Attach Resume" on the end of a description feeds those labels to the
    fit matcher as if they were requirements.
    """
    start = form_starts_at(text)
    if start is None:
        return text, False

    # A form at the very start, ormost of a short page, means there is
    # no posting here.
    if start < max(400, len(text) * FORM_HEAD_FRACTION):
        return text, True

    return text[:start].rstrip(), False


def fetch(url: str, timeout_ms: int = 45_000, headless: bool = True) -> Result:
    ats = detect_ats(url)
    candidates = SELECTORS.get(ats, []) + SELECTORS["generic"]

    with sync_playwright() as p:
        # Chrome rather than bundled Chromium: Workday serves a
        # degraded page to browsers it does not recognise, and the
        # installed Chrome is what a real visitor uses.
        browser = p.chromium.launch(
            headless=headless,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

            # These pages paint a shell first and fill the description
            # later, so settle for the network going quiet rather than
            # for load, which fires too early.
            try:
                page.wait_for_load_state("networkidle", timeout=15_000)
            except PWTimeout:
                pass  # analytics beacons can keep a page from ever going idle

            body = page.inner_text("body", timeout=5_000).lower()
            if any(m in body for m in EXPIRED_MARKERS):
                return Result(status="expired", url=url, ats=ats,
                              error="posting reports itself closed")

            for sel in candidates:
                try:
                    el = page.wait_for_selector(sel, timeout=6_000, state="attached")
                    if not el:
                        continue
                    text = clean(el.inner_text())
                    # A container can exist while holding only a
                    # heading. Requiring real length is what separates
                    # "found the description" from "found the shell".
                    posting, is_form = split_off_form(text)
                    if len(posting) >= 400 and not is_form:
                        return Result(
                            status="success", url=url, ats=ats,
                            jobDescription=posting, chars=len(posting), selector=sel,
                        )
                except PWTimeout:
                    continue

            # Nothing matched: fall back to the page body, minus the
            # obvious chrome.
            for junk in ("nav", "header", "footer", "script", "style"):
                page.eval_on_selector_all(
                    junk, "els => els.forEach(e => e.remove())"
                )
            text = clean(page.inner_text("body"))
            posting, is_form = split_off_form(text)
            if len(posting) >= 400 and not is_form:
                return Result(status="success", url=url, ats=ats,
                              jobDescription=posting, chars=len(posting), selector="body-fallback")

            if is_form:
                return Result(status="failed", url=url, ats=ats,
                              error="page is an application form, not a posting — "
                                    "saving it would put form labels in the fit paragraph")

            return Result(status="failed", url=url, ats=ats,
                          error=f"no container held more than 400 characters (body had {len(text)})")

        except PWTimeout as e:
            return Result(status="failed", url=url, ats=ats, error=f"timeout: {e}".split("\n")[0])
        except Exception as e:  # noqa: BLE001 — caller wants the reason, whatever it is
            return Result(status="failed", url=url, ats=ats, error=f"{type(e).__name__}: {e}".split("\n")[0])
        finally:
            ctx.close()
            browser.close()


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Fetch a JD from a JavaScript-rendered ATS")
    ap.add_argument("url")
    ap.add_argument("--timeout", type=int, default=45_000)
    ap.add_argument("--headed", action="store_true", help="show the browser, for debugging")
    ap.add_argument("--text", action="store_true", help="print the description rather than JSON")
    args = ap.parse_args()

    r = fetch(args.url, timeout_ms=args.timeout, headless=not args.headed)

    if args.text:
        print(r.jobDescription or f"[{r.status}] {r.error}")
    else:
        print(json.dumps(asdict(r), ensure_ascii=False))

    raise SystemExit(0 if r.status == "success" else 1)


if __name__ == "__main__":
    main()
