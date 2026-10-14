"""Find a business's contact email via web search, and check whether an email's domain hosts a site."""
from __future__ import annotations

import html
import re
from urllib.parse import urlparse

import requests

from .places import normalize_name

BRAVE_API = "https://api.search.brave.com/res/v1/web/search"
USER_AGENT = "leadscout/1.0 (+business-contact lookup)"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
FREE_PROVIDERS = {
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.no", "outlook.com", "outlook.no",
    "live.com", "live.no", "msn.com", "yahoo.com", "yahoo.no", "icloud.com", "me.com",
    "online.no", "frisurf.no", "start.no", "c2i.net", "broadpark.no", "getmail.no", "epost.no",
}
# Directory / platform domains: their own addresses are never the business's.
IGNORED_DOMAINS = {
    "gulesider.no", "proff.no", "1881.no", "purehelp.no", "brreg.no", "facebook.com", "instagram.com",
    "finn.no", "regnskapstall.no", "firmasok.no", "example.com", "sentry.io", "wixpress.com",
    "linkedin.com", "google.com", "bing.com", "kununu.com", "eniro.no", "180.no",
}
SKIP_FETCH_HOSTS = ("facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "x.com", "twitter.com")
JUNK_LOCAL = re.compile(r"^(no-?reply|donotreply|postmaster|abuse|privacy|personvern|gdpr|webmaster)$", re.I)
OBFUSCATED_AT = re.compile(r"\s*[\[\(]\s*(?:at|krøllalfa)\s*[\]\)]\s*", re.I)
OBFUSCATED_DOT = re.compile(r"\s*[\[\(]\s*(?:dot|punktum)\s*[\]\)]\s*", re.I)
ASSET_SUFFIX =re.compile(r"\.(png|jpe?g|gif|svg|webp|css|js)$", re.I)


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].lower()


def is_free_provider(email: str) -> bool:
    return domain_of(email) in FREE_PROVIDERS


def extract_emails(text: str) -> list[str]:
    text = html.unescape(text)
    text = OBFUSCATED_AT.sub("@", text)
    text = OBFUSCATED_DOT.sub(".", text)
    out: list[str] = []
    for m in EMAIL_RE.findall(text):
        e = m.strip(".").lower()
        local, dom = e.rsplit("@", 1)
        if ASSET_SUFFIX.search(e) or JUNK_LOCAL.match(local):
            continue
        if any(dom == d or dom.endswith("." + d) for d in IGNORED_DOMAINS):
            continue
        if e not in out:
            out.append(e)
    return out


def _tokens(name: str) -> set[str]:
    return {t for t in normalize_name(name).split() if len(t) >= 3}


def rate_email(email: str, business_name: str, context: str) -> str | None:
    """Confidence that `email` belongs to the business: 'high', 'medium' or None (reject)."""
    local, dom = email.rsplit("@", 1)
    flat = re.sub(r"[^a-z0-9æøå]", "", (local + " " + dom.split(".")[0]).lower())
    toks = _tokens(business_name)
    name_in_email = any(t in flat for t in toks)
    name_in_context = bool(toks) and normalize_name(business_name) in normalize_name(context)
    if name_in_email and (name_in_context or not is_free_provider(email)):
        return "high"
    if name_in_email or name_in_context:
        return "medium"
    return None


def search_emails(
    name: str,
    poststed: str,
    api_key: str,
    fetch_pages: bool = True,
    session: requests.Session | None = None,
) -> list[dict]:
    """Search the web for the business and pull plausible contact emails from results."""
    s = session or requests.Session()
    r = s.get(
        BRAVE_API,
        params={"q": f'"{name}" {poststed} e-post', "country": "NO", "count": 10},
        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    results = (r.json().get("web") or {}).get("results", [])

    found: dict[str, dict] = {}

    def consider(text: str, source: str) -> None:
        for e in extract_emails(text):
            conf = rate_email(e, name, text)
            if conf and (e not in found or (conf == "high" and found[e]["confidence"] != "high")):
                found[e] = {"email": e, "confidence": conf, "source": source}

    for res in results:
        url = res.get("url", "")
        snippet = " ".join([res.get("title", ""), res.get("description", "")] + res.get("extra_snippets", []))
        consider(snippet, url)
        host = urlparse(url).netloc.lower()
        if fetch_pages and url and not any(h in host for h in SKIP_FETCH_HOSTS):
            try:
                page = s.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
                if page.ok and "html" in page.headers.get("Content-Type", ""):
                    consider(page.text[:500_000], url)
            except requests.RequestException:
                pass

    order = {"high": 0, "medium": 1}
    return sorted(found.values(), key=lambda x: (order[x["confidence"]], is_free_provider(x["email"])))


def domain_has_website(domain: str, session: requests.Session | None = None) -> bool:
    """True if the email's domain serves an actual HTML page (i.e. they likely already have a site)."""
    s = session or requests.Session()
    for url in (f"https://{domain}", f"https://www.{domain}", f"http://{domain}"):
        try:
            r = s.get(url, headers={"User-Agent": USER_AGENT}, timeout=10, allow_redirects=True)
        except requests.RequestException:
            continue
        if r.ok and "html" in r.headers.get("Content-Type", "") and len(r.text) > 2000:
            body = r.text.lower()
            parked = any(p in body for p in ("domain is parked", "domenet er parkert", "this domain is for sale",
                                              "kjøp domenet", "under construction", "kommer snart"))
            return not parked
    return False
