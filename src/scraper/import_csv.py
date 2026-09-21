"""
Import candidate LinkedIn profiles from a CSV.

Every free search backend blocks X-ray scraping (see xray.py), so this
is the path that works today without a paid SERP key. It accepts the
export format of the tools people already use to build these lists —
LinkedIn Sales Navigator, PhantomBuster, Apollo, Clay, or a hand-made
sheet — and normalizes them into the shape the resolver expects.

Column names are matched loosely because every tool names them
differently. Only a LinkedIn profile URL is strictly required; a name
makes the pattern fallback possible, and a title makes tier
classification possible.
"""

from __future__ import annotations

import csv
import json
import sys
from dataclasses import asdict
from pathlib import Path

from xray import Candidate, classify_tier, normalize_profile_url, score_candidate


# Column aliases, lowercased and stripped of non-alphanumerics.
ALIASES = {
    "linkedin_url": {
        "linkedinurl", "linkedin", "profileurl", "profile", "url", "link",
        "linkedinprofile", "linkedinprofileurl", "personlinkedinurl",
    },
    "full_name": {
        "fullname", "name", "fullnames", "contactname", "person",
        "firstnamelastname", "displayname",
    },
    "first_name": {"firstname", "first", "givenname"},
    "last_name": {"lastname", "last", "surname", "familyname"},
    "title": {
        "title", "jobtitle", "headline", "position", "role", "currenttitle",
        "occupation",
    },
    "company": {"company", "companyname", "organization", "employer", "currentcompany"},
    "email": {"email", "emailaddress", "workemail", "businessemail"},
}


def _norm_key(k: str) -> str:
    return "".join(ch for ch in (k or "").lower() if ch.isalnum())


def _build_map(fieldnames: list[str]) -> dict[str, str]:
    """Map our canonical field names onto this file's actual headers."""
    out: dict[str, str] = {}
    for col in fieldnames or []:
        nk = _norm_key(col)
        for canonical, names in ALIASES.items():
            if nk in names and canonical not in out:
                out[canonical] = col
    return out


def load_candidates(
    path: str | Path,
    company: str,
    min_score: float = 0.0,
) -> list[Candidate]:
    """
    Read a CSV into ranked candidates.

    Rows without a usable LinkedIn URL are skipped — the resolver has
    nothing to look up without one. Everything else is best-effort:
    a missing title just means the tier falls back to "other".
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"no such file: {path}")

    out: list[Candidate] = []
    seen: set[str] = set()
    skipped = 0

    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        colmap = _build_map(reader.fieldnames or [])

        if "linkedin_url" not in colmap:
            raise ValueError(
                f"no LinkedIn URL column found. Headers were: {reader.fieldnames}\n"
                f"Expected one of: {sorted(ALIASES['linkedin_url'])}"
            )

        for row in reader:
            raw_url = (row.get(colmap["linkedin_url"]) or "").strip()
            url = normalize_profile_url(raw_url)
            if not url or url in seen:
                skipped += 1
                continue
            seen.add(url)

            name = (row.get(colmap.get("full_name", ""), "") or "").strip()
            if not name:
                first = (row.get(colmap.get("first_name", ""), "") or "").strip()
                last = (row.get(colmap.get("last_name", ""), "") or "").strip()
                name = f"{first} {last}".strip()

            title = (row.get(colmap.get("title", ""), "") or "").strip()
            row_company = (row.get(colmap.get("company", ""), "") or "").strip()
            email = (row.get(colmap.get("email", ""), "") or "").strip() or None

            tier = classify_tier(title)
            score, company_match, notes = score_candidate(
                company, f"{name} {title} {row_company}", "", tier
            )

            if score < min_score:
                continue

            c = Candidate(
                full_name=name or None,
                headline=title or None,
                linkedin_url=url,
                tier=tier,
                score=round(score, 3),
                company_match=company_match,
                source="csv",
                notes=notes,
            )
            # An address already in the sheet skips the lookup entirely.
            if email:
                c.notes.append(f"email from csv: {email}")
            out.append(c)

    if skipped:
        print(f"  skipped {skipped} rows without a usable LinkedIn URL", file=sys.stderr)

    out.sort(key=lambda c: c.score, reverse=True)
    return out


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Import LinkedIn candidates from a CSV")
    ap.add_argument("csv_path")
    ap.add_argument("company")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    cands = load_candidates(args.csv_path, args.company)

    if args.json:
        print(json.dumps([asdict(c) for c in cands], indent=2))
        return

    print(f"\n{len(cands)} candidates for {args.company}\n")
    by_tier: dict[str, int] = {}
    for c in cands:
        by_tier[c.tier] = by_tier.get(c.tier, 0) + 1
        name = (c.full_name or "(unknown)")[:28]
        print(f"  {c.score:.2f}  {c.tier:<15} {name:<30} {c.linkedin_url}")
    print()
    for tier, n in sorted(by_tier.items()):
        print(f"  {tier:<15} {n}")


if __name__ == "__main__":
    main()
