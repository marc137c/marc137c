"""Candidate businesses from Enhetsregisteret (Brønnøysundregistrene open API, no key needed)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Iterator

import requests

API = "https://data.brreg.no/enhetsregisteret/api/enheter"
PAGE_SIZE = 100
MAX_WINDOW = 10_000  # brreg refuses page * size beyond this


@dataclass
class Business:
    orgnr: str
    name: str
    org_form: str
    employees: int
    nace_code: str
    nace_desc: str
    address: str
    postnr: str
    poststed: str
    kommune: str
    registry_website: str | None = None
    registry_email: str | None = None
    registry_phone: str | None = None
    # Filled by later stages.
    google: dict | None = None
    emails: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def phone(self) -> str | None:
        if self.google and self.google.get("phone"):
            return self.google["phone"]
        return self.registry_phone


def parse_enhet(e: dict) -> Business:
    addr = e.get("forretningsadresse") or e.get("postadresse") or {}
    nace = e.get("naeringskode1") or {}
    return Business(
        orgnr=e["organisasjonsnummer"],
        name=e.get("navn", "").strip(),
        org_form=(e.get("organisasjonsform") or {}).get("kode", ""),
        employees=int(e.get("antallAnsatte") or 0),
        nace_code=nace.get("kode", ""),
        nace_desc=nace.get("beskrivelse", ""),
        address=", ".join(addr.get("adresse") or []),
        postnr=addr.get("postnummer", "") or "",
        poststed=addr.get("poststed", "") or "",
        kommune=addr.get("kommune", "") or "",
        registry_website=(e.get("hjemmeside") or "").strip() or None,
        registry_email=(e.get("epostadresse") or "").strip() or None,
        registry_phone=(e.get("mobil") or e.get("telefon") or "").strip() or None,
    )


def is_active(e: dict) -> bool:
    return not (
        e.get("konkurs")
        or e.get("underAvvikling")
        or e.get("underTvangsavviklingEllerTvangsopplosning")
        or e.get("slettedato")
    )


def fetch_enheter(
    kommunenummer: str,
    min_employees: int,
    org_forms: list[str],
    session: requests.Session | None = None,
    delay: float = 0.5,
) -> Iterator[dict]:
    """Yield raw enheter for one municipality, paging through the result set."""
    s = session or requests.Session()
    page = 0
    while True:
        params = {
            "kommunenummer": kommunenummer,
            "fraAntallAnsatte": min_employees,
            "organisasjonsform": ",".join(org_forms),
            "konkurs": "false",
            "size": PAGE_SIZE,
            "page": page,
        }
        r = s.get(API, params=params, headers={"Accept": "application/json"}, timeout=30)
        r.raise_for_status()
        data = r.json()
        yield from (data.get("_embedded") or {}).get("enheter", [])
        info = data.get("page") or {}
        page += 1
        if page >= info.get("totalPages", 0) or (page + 1) * PAGE_SIZE > MAX_WINDOW:
            break
        time.sleep(delay)
