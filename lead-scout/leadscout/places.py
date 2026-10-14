"""Google Places (New) lookup: is there a website linked on the business's Google listing?"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

import requests

API = "https://places.googleapis.com/v1/places:searchText"
FIELDS = ",".join(
    "places." + f
    for f in (
        "id displayName formattedAddress websiteUri nationalPhoneNumber "
        "userRatingCount rating businessStatus googleMapsUri types"
    ).split()
)
_SUFFIX = re.compile(r"\b(as|asa|ans|da|sa|nuf|ab|ltd)\b", re.I)


def normalize_name(name: str) -> str:
    name = _SUFFIX.sub(" ", name.lower())
    return re.sub(r"[^a-z0-9æøå]+", " ", name).strip()


def name_similarity(a: str, b: str) -> float:
    a, b = normalize_name(a), normalize_name(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def lookup(name: str, poststed: str, api_key: str, session: requests.Session | None = None) -> dict | None:
    """Return the best-matching Google listing, or None if nothing plausibly matches."""
    s = session or requests.Session()
    r = s.post(
        API,
        json={"textQuery": f"{name} {poststed}", "regionCode": "NO", "languageCode": "no", "maxResultCount": 5},
        headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELDS},
        timeout=30,
    )
    r.raise_for_status()
    return best_match(name, poststed, r.json().get("places", []))


def best_match(name: str, poststed: str, places: list[dict]) -> dict | None:
    best, best_score = None, 0.0
    for p in places:
        score = name_similarity(name, (p.get("displayName") or {}).get("text", ""))
        if poststed and poststed.lower() in (p.get("formattedAddress") or "").lower():
            score += 0.15
        if score > best_score:
            best, best_score = p, score
    if best is None or best_score < 0.75:
        return None
    return {
        "place_id": best.get("id"),
        "name": (best.get("displayName") or {}).get("text"),
        "address": best.get("formattedAddress"),
        "website": best.get("websiteUri"),
        "phone": best.get("nationalPhoneNumber"),
        "reviews": int(best.get("userRatingCount") or 0),
        "rating": best.get("rating"),
        "status": best.get("businessStatus"),
        "maps_url": best.get("googleMapsUri"),
        "types": best.get("types", []),
        "match": round(best_score, 2),
    }
