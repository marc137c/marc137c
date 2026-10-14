import csv
from unittest.mock import MagicMock

import pytest

from leadscout import brreg, emails, places, qualify
from leadscout.__main__ import parse_interval
from leadscout.config import Config, load_config
from leadscout.pipeline import run_once


def enhet(orgnr, navn, nace, ansatte=12, form="AS", hjemmeside=None, **extra):
    e = {
        "organisasjonsnummer": orgnr,
        "navn": navn,
        "organisasjonsform": {"kode": form},
        "antallAnsatte": ansatte,
        "naeringskode1": {"kode": nace, "beskrivelse": "test"},
        "forretningsadresse": {"adresse": ["Storgata 1"], "postnummer": "1606",
                               "poststed": "FREDRIKSTAD", "kommune": "FREDRIKSTAD",
                               "kommunenummer": "3107"},
    }
    if hjemmeside:
        e["hjemmeside"] = hjemmeside
    e.update(extra)
    return e


# --- registry -------------------------------------------------------------

def test_parse_enhet_and_active():
    b = brreg.parse_enhet(enhet("1", "Rørlegger Hansen AS", "43.221", epostadresse="Post@Hansen.no"))
    assert (b.name, b.employees, b.poststed, b.registry_email) == ("Rørlegger Hansen AS", 12, "FREDRIKSTAD", "Post@Hansen.no")
    assert brreg.is_active(enhet("1", "x", "56.1"))
    assert not brreg.is_active(enhet("1", "x", "56.1", konkurs=True))


def test_fetch_enheter_pages():
    s = MagicMock()
    pages = [
        {"_embedded": {"enheter": [enhet("1", "A", "56")]}, "page": {"totalPages": 2}},
        {"_embedded": {"enheter": [enhet("2", "B", "56")]}, "page": {"totalPages": 2}},
    ]
    s.get.side_effect = [MagicMock(json=MagicMock(return_value=p)) for p in pages]
    got = list(brreg.fetch_enheter("3107", 5, ["AS"], s, delay=0))
    assert [e["organisasjonsnummer"] for e in got] == ["1", "2"]
    assert s.get.call_args_list[0].kwargs["params"]["kommunenummer"] == "3107"


# --- qualification --------------------------------------------------------

@pytest.mark.parametrize("nace,tier", [
    ("56.101", "high"), ("43.221", "high"), ("96.021", "high"), ("86.230", "high"),
    ("49.410", "medium"), ("64.202", None), ("84.110", None), ("01.110", None),
])
def test_industry_tier(nace, tier):
    assert qualify.industry_tier(nace)[0] == tier


def test_prefilter_and_score():
    b = brreg.parse_enhet(enhet("1", "Kafé Sol AS", "56.101", ansatte=25))
    assert qualify.prefilter(b) is None
    assert "website" in qualify.prefilter(brreg.parse_enhet(enhet("1", "x", "56.1", hjemmeside="x.no")))
    b.google = {"reviews": 120, "website": None, "status": "OPERATIONAL", "phone": "69 00 00 00"}
    b.emails = [{"email": "kafesol@gmail.com", "confidence": "high", "source": "x"}]
    assert qualify.score(b) == 35 + 30 + 15 + 15 + 5
    b.google["website"] = "https://kafesol.no"
    assert "website" in qualify.google_reject(b)


# --- Google Places matching ----------------------------------------------

def test_places_best_match():
    results = [
        {"displayName": {"text": "Sol Kafé og Bakeri"}, "formattedAddress": "Oslo"},
        {"displayName": {"text": "Kafé Sol"}, "formattedAddress": "Storgata 1, 1606 Fredrikstad",
         "userRatingCount": 88, "businessStatus": "OPERATIONAL"},
    ]
    m = places.best_match("KAFÉ SOL AS", "FREDRIKSTAD", results)
    assert m["name"] == "Kafé Sol" and m["reviews"] == 88 and m["website"] is None
    assert places.best_match("Helt Annet Firma AS", "HALDEN", results) is None


# --- email extraction -----------------------------------------------------

def test_extract_emails_filters_junk():
    text = ("Kontakt: post@hansen-ror.no, hansenror@gmail.com, noreply@x.no, "
            "kundeservice@gulesider.no, logo@2x.png, hansen [at] online.no")
    assert emails.extract_emails(text) == ["post@hansen-ror.no", "hansenror@gmail.com", "hansen@online.no"]


def test_rate_email():
    ctx = "Rørlegger Hansen AS i Fredrikstad. E-post: hansenror@gmail.com"
    assert emails.rate_email("hansenror@gmail.com", "Rørlegger Hansen AS", ctx) == "high"
    assert emails.rate_email("ola.n@gmail.com", "Rørlegger Hansen AS", ctx) == "medium"
    assert emails.rate_email("ola.n@gmail.com", "Rørlegger Hansen AS", "unrelated page") is None


def test_search_emails_uses_snippets():
    s = MagicMock()
    s.get.return_value.json.return_value = {"web": {"results": [{
        "url": "https://www.gulesider.no/x", "title": "Rørlegger Hansen AS - Fredrikstad",
        "description": "Rørlegger Hansen AS. E-post: hansenror@gmail.com Tlf 69 12 34 56"}]}}
    got = emails.search_emails("Rørlegger Hansen AS", "FREDRIKSTAD", "key", fetch_pages=False, session=s)
    assert got == [{"email": "hansenror@gmail.com", "confidence": "high", "source": "https://www.gulesider.no/x"}]


# --- misc -----------------------------------------------------------------

def test_parse_interval():
    assert parse_interval("6h") == 21600 and parse_interval("1d") == 86400


def test_load_config(tmp_path, monkeypatch):
    p = tmp_path / "c.toml"
    p.write_text('kommuner = ["3107", "3105"]\nmin_employees = 10\n')
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "k")
    cfg = load_config(p)
    assert cfg.kommuner == {"3107": "Fredrikstad", "3105": "Sarpsborg"}
    assert cfg.min_employees == 10 and cfg.google_places_api_key == "k"
    p.write_text("bogus = 1\n")
    with pytest.raises(ValueError):
        load_config(p)


# --- full pipeline with mocked network -----------------------------------

def test_run_once_end_to_end(tmp_path, monkeypatch):
    registry = {"_embedded": {"enheter": [
        enhet("100", "Rørlegger Hansen AS", "43.221", ansatte=15),   # lead
        enhet("200", "Kafé Sol AS", "56.101", ansatte=20),           # Google has website -> reject
        enhet("300", "Holding Invest AS", "64.202", ansatte=8),      # wrong industry
        enhet("400", "Frisør Berg AS", "96.021", ansatte=6, hjemmeside="berg.no"),  # registry website
        enhet("500", "Bygg Nord AS", "41.200", ansatte=30),          # email domain hosts site -> reject
    ]}, "page": {"totalPages": 1}}

    google = {
        "Rørlegger Hansen AS": {"displayName": {"text": "Rørlegger Hansen"}, "formattedAddress": "1606 Fredrikstad",
                                "userRatingCount": 40, "businessStatus": "OPERATIONAL",
                                "nationalPhoneNumber": "69 12 34 56"},
        "Kafé Sol AS": {"displayName": {"text": "Kafé Sol"}, "formattedAddress": "1606 Fredrikstad",
                        "websiteUri": "https://kafesol.no", "businessStatus": "OPERATIONAL"},
        "Bygg Nord AS": {"displayName": {"text": "Bygg Nord"}, "formattedAddress": "1606 Fredrikstad",
                         "businessStatus": "OPERATIONAL"},
    }
    search = {
        "Rørlegger Hansen AS": "Rørlegger Hansen AS Fredrikstad. E-post: hansenror@gmail.com",
        "Bygg Nord AS": "Bygg Nord AS — kontakt post@byggnord.no",
    }

    def resp(payload=None, text="", ctype="application/json", ok=True):
        r = MagicMock(ok=ok, text=text, headers={"Content-Type": ctype})
        r.json.return_value = payload
        return r

    def fake_get(url, params=None, headers=None, **kw):
        if "brreg" in url:
            return resp(registry)
        if "brave" in url:
            name = params["q"].split('"')[1]
            return resp({"web": {"results": [{"url": "https://www.facebook.com/x", "title": "",
                                              "description": search.get(name, "")}]}})
        if "byggnord.no" in url:
            return resp(text="<html>" + "x" * 3000, ctype="text/html")
        return resp(ok=False)

    def fake_post(url, json=None, **kw):
        name = json["textQuery"].rsplit(" ", 1)[0]
        return resp({"places": [google[name]] if name in google else []})

    s = MagicMock()
    s.get.side_effect = fake_get
    s.post.side_effect = fake_post
    monkeypatch.setattr("leadscout.pipeline.requests.Session", lambda: s)

    cfg = Config(kommuner={"3107": "Fredrikstad"}, data_dir=tmp_path / "data", output_dir=tmp_path / "out",
                 google_places_api_key="g", brave_search_api_key="b", request_delay_seconds=0)
    leads = run_once(cfg)
    assert [l["company"] for l in leads] == ["Rørlegger Hansen AS"]
    assert leads[0]["email"] == "hansenror@gmail.com" and leads[0]["phone"] == "69 12 34 56"

    rows = list(csv.DictReader(open(next((tmp_path / "out").glob("leads_2*.csv")), encoding="utf-8-sig")))
    assert rows[0]["company"] == "Rørlegger Hansen AS"

    # Second run must not report the same lead again.
    assert run_once(cfg) == []
