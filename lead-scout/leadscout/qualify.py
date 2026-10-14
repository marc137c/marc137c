"""Decide whether a business looks like a customer that needs a website, and score it."""
from __future__ import annotations

from .brreg import Business

# NACE (SN2007) prefixes. Customer-facing businesses that lose work without a website.
HIGH_NEED = {
    "41": "Building construction", "43": "Specialised construction (electricians, plumbers, roofers…)",
    "45": "Car sales & repair", "47": "Retail", "55": "Hotels & accommodation", "56": "Restaurants & cafés",
    "68": "Real estate", "69.1": "Lawyers", "69.2": "Accountants", "71.1": "Architects & engineers",
    "74.2": "Photographers", "75": "Veterinary", "77.1": "Car rental", "77.2": "Equipment rental",
    "79": "Travel agencies", "81.2": "Cleaning", "81.3": "Landscaping", "85.5": "Courses & driving schools",
    "86.2": "Doctors & dentists", "86.9": "Physio & other health", "93.1": "Gyms & sports",
    "93.2": "Leisure & entertainment", "95": "Repair services", "96.0": "Hair, beauty, funeral & personal services",
}
MEDIUM_NEED = {
    "10": "Food production", "11": "Beverages", "16": "Wood products", "25": "Metal products",
    "31": "Furniture", "33": "Machinery repair & installation", "42": "Civil engineering",
    "46": "Wholesale", "49.3": "Taxi & passenger transport", "49.4": "Freight & moving",
    "52": "Storage", "62": "IT services", "73": "Advertising & market research", "74.1": "Design",
    "80": "Security services", "82": "Office services", "88.9": "Social services (private)",
}
# Never leads: holding companies, public bodies, associations, finance.
EXCLUDE = ("64", "65", "66", "70.1", "84", "94", "99")


def industry_tier(nace: str) -> tuple[str | None, str]:
    if not nace or nace.startswith(EXCLUDE):
        return None, ""
    for table, tier in ((HIGH_NEED, "high"), (MEDIUM_NEED, "medium")):
        best = max((p for p in table if nace.startswith(p)), key=len, default=None)
        if best:
            return tier, table[best]
    return None, ""


def prefilter(b: Business) -> str | None:
    """Cheap checks on registry data before any paid API call. Returns a rejection reason or None."""
    if b.registry_website:
        return "registry lists a website"
    tier, _ = industry_tier(b.nace_code)
    if tier is None:
        return f"industry not a fit ({b.nace_code} {b.nace_desc})"
    return None


def google_reject(b: Business) -> str | None:
    g = b.google
    if not g:
        return None
    if g.get("website"):
        return f"Google listing links a website ({g['website']})"
    if g.get("status") and g["status"] != "OPERATIONAL":
        return f"Google status {g['status']}"
    return None


def score(b: Business) -> int:
    s = 0
    e = b.employees
    s += 40 if e >= 50 else 35 if e >= 20 else 25 if e >= 10 else 15 if e >= 5 else 5
    tier, _ = industry_tier(b.nace_code)
    s += {"high": 30, "medium": 15}.get(tier, 0)
    reviews = (b.google or {}).get("reviews", 0)
    s += 15 if reviews >= 50 else 10 if reviews >= 15 else 5 if reviews >= 1 else 0
    if b.emails:
        s += 15 if b.emails[0]["confidence"] == "high" else 8
    if b.phone:
        s += 5
    return min(s, 100)


def pitch_reason(b: Business) -> str:
    _, label = industry_tier(b.nace_code)
    parts = [f"{label or b.nace_desc}", f"{b.employees} employees"]
    g = b.google
    if g:
        parts.append(f"{g['reviews']} Google reviews, no website on listing" if g.get("reviews")
                     else "on Google Maps without a website")
    else:
        parts.append("no website in registry (Google not checked)")
    return "; ".join(parts)
