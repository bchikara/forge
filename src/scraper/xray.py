"""
Google X-ray search for LinkedIn profiles at a target company.

The resolver can only work through candidates it is handed, and
jobright misses on roughly a quarter of profiles. To land 10 usable
contacts at a company we need noticeably more than 10 candidates going
in, ranked so the best-fit people are tried first.

X-ray searching means constraining a general web search to LinkedIn's
profile namespace:

    site:linkedin.com/in "Salesforce" ("engineering manager" OR ...)

Results are public search results. This module reads them, extracts
profile URLs, and scores each candidate against the role being
targeted. It does not log in to LinkedIn or touch anything behind an
auth wall.

Politeness is deliberate: serialized requests, randomized gaps, and a
hard stop on a 429. Scrapers that hammer a search engine get blocked,
and a blocked scraper supplies no candidates at all.
"""

from __future__ import annotations

import json
import random
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass, asdict, field
from typing import Iterable

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print(
        "missing deps — run:  pip3 install requests beautifulsoup4 lxml",
        file=sys.stderr,
    )
    raise


# ---------------------------------------------------------------
# Tier definitions
# ---------------------------------------------------------------
# Title fragments that place a profile in a tier. Ordered most to least
# specific within each tier so the first match wins.

TIER_TITLES: dict[str, list[str]] = {
    "hiring_manager": [
        "engineering manager",
        "senior engineering manager",
        "director of engineering",
        "head of engineering",
        "engineering lead",
        "software engineering manager",
        "manager, software engineering",
    ],
    "recruiter": [
        "technical recruiter",
        "technical sourcer",
        "talent acquisition",
        "recruiting manager",
        "recruiter",
        "sourcer",
        "talent partner",
    ],
    "leader": [
        "vp of engineering",
        "vice president engineering",
        "vp engineering",
        "cto",
        "chief technology officer",
        "head of talent",
        "director of talent",
        "senior director",
    ],
}

# Signals that a profile is a poor target regardless of title: people
# who have left, or accounts that are not individuals.
NEGATIVE_SIGNALS = [
    "former",
    "ex-",
    "retired",
    "seeking",
    "open to work",
    "looking for",
    "student",
]


@dataclass
class Candidate:
    full_name: str | None
    headline: str | None
    linkedin_url: str
    tier: str
    score: float
    company_match: bool = False
    source: str = "xray"
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------
# Query construction
# ---------------------------------------------------------------

def build_queries(company: str, tiers: Iterable[str] | None = None) -> list[tuple[str, str]]:
    """
    One query per tier, rather than a single broad one.

    A combined query returns whatever the engine considers most
    relevant, which skews toward whichever tier has the most profiles.
    Querying per tier guarantees candidates in each, so the tier caps
    downstream have something to draw on.
    """
    tiers = list(tiers) if tiers else list(TIER_TITLES.keys())
    queries: list[tuple[str, str]] = []

    for tier in tiers:
        titles = TIER_TITLES.get(tier, [])
        if not titles:
            continue
        # Keep the title list short — over-long queries return less.
        clause = " OR ".join(f'"{t}"' for t in titles[:5])
        q = f'site:linkedin.com/in "{company}" ({clause})'
        queries.append((tier, q))

    return queries


# ---------------------------------------------------------------
# Search backends
# ---------------------------------------------------------------

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)


class RateLimited(Exception):
    """Search engine asked us to stop. Never retried tightly."""


def _sleep_jitter(lo: float = 2.5, hi: float = 6.0) -> None:
    time.sleep(random.uniform(lo, hi))


def search_duckduckgo(query: str, limit: int = 25) -> list[dict]:
    """
    DuckDuckGo HTML endpoint.

    Preferred over Google as the default: it does not require an API
    key, and it tolerates automated access far better. Google's HTML
    results page blocks non-browser clients aggressively and returns a
    consent interstitial rather than results.
    """
    url = "https://html.duckduckgo.com/html/"
    resp = requests.post(
        url,
        data={"q": query},
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )

    if resp.status_code == 429:
        raise RateLimited("duckduckgo returned 429")
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "lxml")
    out: list[dict] = []

    for res in soup.select(".result")[:limit]:
        a = res.select_one("a.result__a")
        if not a:
            continue
        href = a.get("href", "")
        # DDG wraps outbound links in a redirect.
        if "uddg=" in href:
            parsed = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            href = parsed.get("uddg", [href])[0]
        snippet_el = res.select_one(".result__snippet")
        out.append(
            {
                "url": href,
                "title": a.get_text(" ", strip=True),
                "snippet": snippet_el.get_text(" ", strip=True) if snippet_el else "",
            }
        )

    return out


def _extract_profiles_generic(html: str, limit: int) -> list[dict]:
    """
    Pull LinkedIn profile results out of a search page without relying
    on engine-specific CSS classes.

    Result-page markup changes constantly and class names are obfuscated,
    so selector-based parsing breaks silently. Anchoring on the profile
    URL itself is stable: whatever the surrounding markup, the link and
    its nearby text are what we need.
    """
    soup = BeautifulSoup(html, "lxml")
    out: list[dict] = []
    seen: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]

        # Engines wrap outbound links; recover the real target.
        if "/url?q=" in href:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            href = qs.get("q", [href])[0]
        elif href.startswith("/") and "linkedin.com" not in href:
            continue

        if "linkedin.com/in/" not in href:
            continue

        norm = normalize_profile_url(href)
        if not norm or norm in seen:
            continue
        seen.add(norm)

        title = a.get_text(" ", strip=True)

        # The snippet is usually in a nearby block; walk up a couple of
        # levels and take the surrounding text.
        snippet = ""
        node = a
        for _ in range(4):
            node = node.parent
            if node is None:
                break
            text = node.get_text(" ", strip=True)
            if len(text) > len(title) + 40:
                snippet = text[:400]
                break

        if not title:
            continue

        out.append({"url": norm, "title": title, "snippet": snippet})
        if len(out) >= limit:
            break

    return out


def search_google(query: str, limit: int = 25) -> list[dict]:
    """
    Google results page.

    Unauthenticated scraping works intermittently — Google may serve a
    consent page or a CAPTCHA instead, especially from a datacenter IP
    or under repeated queries. Treated as best-effort with Bing behind
    it; SerpAPI is the option that actually holds up under volume.
    """
    resp = requests.get(
        "https://www.google.com/search",
        params={"q": query, "num": min(limit * 2, 30)},
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    if resp.status_code == 429:
        raise RateLimited("google returned 429")
    resp.raise_for_status()

    if "captcha" in resp.text.lower() or "unusual traffic" in resp.text.lower():
        raise RateLimited("google served a CAPTCHA")

    return _extract_profiles_generic(resp.text, limit)


def search_bing(query: str, limit: int = 25) -> list[dict]:
    """Bing results. Tolerates automated access better than Google."""
    resp = requests.get(
        "https://www.bing.com/search",
        params={"q": query, "count": min(limit * 2, 30)},
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    if resp.status_code == 429:
        raise RateLimited("bing returned 429")
    resp.raise_for_status()
    return _extract_profiles_generic(resp.text, limit)


def search_with_fallback(query: str, limit: int, serpapi_key: str | None = None) -> tuple[list[dict], str]:
    """
    Try backends in order of result quality, falling through on failure.

    No single free backend is dependable.

    Measured behaviour as of build time, all from a residential IP:

        duckduckgo  HTTP 202 + "anomaly" interstitial, no results
        bing        HTTP 200, zero profile links in the body
        google      HTTP 200 + "enablejs" shim, zero profile links

    None of the free backends return usable results for an X-ray query.
    They are kept because they cost nothing to attempt and may work
    from a different network, but SerpAPI (or another paid SERP API) is
    what makes this stage dependable. Without a key, expect zero
    candidates and supply them another way.
    """
    backends: list[tuple[str, callable]] = []
    if serpapi_key:
        backends.append(("serpapi", lambda: search_serpapi(query, serpapi_key, limit)))
    backends += [
        ("bing", lambda: search_bing(query, limit)),
        ("google", lambda: search_google(query, limit)),
        ("duckduckgo", lambda: search_duckduckgo(query, limit)),
    ]

    last_err: Exception | None = None
    for name, fn in backends:
        try:
            results = fn()
            if results:
                return results, name
            last_err = RuntimeError(f"{name} returned no results")
        except Exception as e:  # noqa: BLE001 - fall through to next backend
            last_err = e
        _sleep_jitter(1.5, 3.5)

    if not serpapi_key:
        print(
            "  no SERPAPI key set and every free backend was blocked — "
            "set SERPAPI_KEY in .env, or import candidates from a CSV",
            file=sys.stderr,
        )
    elif last_err:
        print(f"  all backends failed: {last_err}", file=sys.stderr)
    return [], "none"


def search_serpapi(query: str, api_key: str, limit: int = 25) -> list[dict]:
    """
    SerpAPI — real Google results, paid, and the reliable option.

    Worth it if X-ray becomes the primary candidate source: it returns
    Google's actual index rather than a secondary engine's, and it does
    not get blocked.
    """
    resp = requests.get(
        "https://serpapi.com/search",
        params={"q": query, "api_key": api_key, "num": min(limit, 100), "engine": "google"},
        timeout=25,
    )
    if resp.status_code == 429:
        raise RateLimited("serpapi quota exceeded")
    resp.raise_for_status()

    data = resp.json()
    return [
        {"url": r.get("link", ""), "title": r.get("title", ""), "snippet": r.get("snippet", "")}
        for r in data.get("organic_results", [])[:limit]
    ]


# ---------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------

PROFILE_RE = re.compile(r"linkedin\.com/in/([A-Za-z0-9\-_%]+)", re.I)


def normalize_profile_url(url: str) -> str | None:
    m = PROFILE_RE.search(url or "")
    if not m:
        return None
    slug = m.group(1).rstrip("/").lower()
    # Country subdomains and tracking params all collapse to one form.
    return f"https://www.linkedin.com/in/{slug}/"


def parse_title(title: str) -> tuple[str | None, str | None]:
    """
    Split a LinkedIn search result title into name and headline.

    The usual shape is "Jane Doe - Engineering Manager - Acme | LinkedIn".
    Falls back to returning the whole string as the name when the
    separator is missing.
    """
    if not title:
        return None, None

    cleaned = re.sub(r"\s*[|\-–]\s*LinkedIn\s*$", "", title, flags=re.I).strip()
    parts = re.split(r"\s+[-–|]\s+", cleaned, maxsplit=1)

    name = parts[0].strip() if parts else None
    headline = parts[1].strip() if len(parts) > 1 else None

    # A "name" with too many words is usually a headline that lost its
    # separator; treat it as unknown rather than mailing "Dear Senior
    # Staff Engineer At Acme".
    if name and len(name.split()) > 4:
        return None, cleaned

    return name, headline


def classify_tier(text: str) -> str:
    low = (text or "").lower()
    for tier, titles in TIER_TITLES.items():
        for t in titles:
            if t in low:
                return tier
    return "other"


def score_candidate(company: str, title: str, snippet: str, tier: str) -> tuple[float, bool, list[str]]:
    """
    Rank a candidate so the resolver spends its lookups on the best
    people first.

    Score is advisory — it decides ordering, not eligibility. The
    company match matters most: a profile that does not mention the
    target company is probably a search artifact.
    """
    blob = f"{title} {snippet}".lower()
    notes: list[str] = []
    score = 0.5

    company_low = company.lower()
    company_match = company_low in blob
    if company_match:
        score += 0.25
    else:
        score -= 0.2
        notes.append("company not mentioned in result")

    if tier != "other":
        score += 0.15
    else:
        notes.append("title did not match a known tier")

    for neg in NEGATIVE_SIGNALS:
        if neg in blob:
            score -= 0.3
            notes.append(f"negative signal: {neg}")
            break

    return max(0.0, min(1.0, score)), company_match, notes


# ---------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------

def find_candidates(
    company: str,
    per_tier: int = 8,
    tiers: Iterable[str] | None = None,
    serpapi_key: str | None = None,
    min_score: float = 0.4,
) -> list[Candidate]:
    """
    Collect ranked LinkedIn candidates for one company.

    Over-fetches on purpose. jobright misses on a meaningful share of
    profiles, so the candidate pool has to be larger than the number of
    contacts wanted or the resolver runs dry.
    """
    seen: set[str] = set()
    out: list[Candidate] = []

    for tier, query in build_queries(company, tiers):
        results, backend = search_with_fallback(query, per_tier * 3, serpapi_key)
        if not results:
            _sleep_jitter()
            continue
        print(f"  tier={tier} via {backend}: {len(results)} raw results", file=sys.stderr)

        kept = 0
        for r in results:
            if kept >= per_tier:
                break

            url = normalize_profile_url(r.get("url", ""))
            if not url or url in seen:
                continue

            name, headline = parse_title(r.get("title", ""))
            snippet = r.get("snippet", "")
            # Prefer the tier the title actually implies over the tier
            # whose query returned it — queries overlap.
            actual_tier = classify_tier(f"{headline or ''} {r.get('title','')} {snippet}")
            if actual_tier == "other":
                actual_tier = tier

            score, company_match, notes = score_candidate(
                company, r.get("title", ""), snippet, actual_tier
            )
            if score < min_score:
                continue

            seen.add(url)
            kept += 1
            out.append(
                Candidate(
                    full_name=name,
                    headline=headline,
                    linkedin_url=url,
                    tier=actual_tier,
                    score=round(score, 3),
                    company_match=company_match,
                    notes=notes,
                )
            )

        _sleep_jitter()

    out.sort(key=lambda c: c.score, reverse=True)
    return out


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="X-ray search for LinkedIn candidates at a company")
    ap.add_argument("company")
    ap.add_argument("--per-tier", type=int, default=8)
    ap.add_argument("--serpapi-key", default=None)
    ap.add_argument("--json", action="store_true", help="emit JSON for the Node pipeline")
    args = ap.parse_args()

    cands = find_candidates(args.company, per_tier=args.per_tier, serpapi_key=args.serpapi_key)

    if args.json:
        print(json.dumps([asdict(c) for c in cands], indent=2))
        return

    print(f"\n{len(cands)} candidates for {args.company}\n")
    for c in cands:
        name = (c.full_name or "(unknown)")[:28]
        print(f"  {c.score:.2f}  {c.tier:<15} {name:<30} {c.linkedin_url}")
        if c.notes:
            print(f"        {'; '.join(c.notes)}")


if __name__ == "__main__":
    main()
