"""One scouting pass: registry → Google check → email search → score → report."""
from __future__ import annotations

import logging
import time
from dataclasses import asdict
from datetime import date

import requests

from . import brreg, emails, places
from .config import Config
from .notify import email_report, to_row, write_csv
from .qualify import google_reject, prefilter, score
from .store import Store

log = logging.getLogger("leadscout")


def run_once(cfg: Config, session: requests.Session | None = None) -> list[dict]:
    s = session or requests.Session()
    store = Store(cfg.data_dir / "leadscout.db")
    if not cfg.google_places_api_key:
        log.warning("GOOGLE_PLACES_API_KEY not set: relying on the registry's website field only.")
    if not cfg.brave_search_api_key:
        log.warning("BRAVE_SEARCH_API_KEY not set: only registry emails will be used.")

    new_leads: list[dict] = []
    examined = 0
    for kommunenr, kommune in cfg.kommuner.items():
        log.info("Scanning %s (%s)…", kommune, kommunenr)
        for raw in brreg.fetch_enheter(kommunenr, cfg.min_employees, cfg.org_forms, s):
            if examined >= cfg.max_candidates_per_run:
                break
            if not brreg.is_active(raw):
                continue
            b = brreg.parse_enhet(raw)
            if not store.needs_check(b.orgnr, cfg.recheck_after_days):
                continue
            reason = prefilter(b)
            if reason:
                store.save(b.orgnr, b.name, "rejected", reason)
                continue

            examined += 1
            row = _evaluate(b, cfg, s, store)
            if row:
                new_leads.append(row)
                log.info("LEAD  %s (%s) score %s %s", b.name, b.kommune, row["score"], row["email"])
            time.sleep(cfg.request_delay_seconds)
        if examined >= cfg.max_candidates_per_run:
            log.info("Reached max_candidates_per_run=%s; the rest waits for the next run.",
                     cfg.max_candidates_per_run)
            break

    new_leads.sort(key=lambda r: -r["score"])
    if new_leads:
        dated = cfg.output_dir / f"leads_{date.today().isoformat()}.csv"
        write_csv(dated, new_leads)
        write_csv(cfg.output_dir / "leads_all.csv", new_leads, append=True)
        log.info("Wrote %d new leads to %s", len(new_leads), dated)
        try:
            if email_report(cfg, dated, new_leads):
                log.info("Emailed lead list to %s", cfg.notify_to)
        except Exception as exc:  # report failure must not lose the run's results
            log.error("Could not email report: %s", exc)
    log.info("Done. Examined %d candidates, %d new leads. Totals: %s",
             examined, len(new_leads), store.counts())
    return new_leads


def _evaluate(b: brreg.Business, cfg: Config, s: requests.Session, store: Store) -> dict | None:
    try:
        if cfg.google_places_api_key:
            b.google = places.lookup(b.name, b.poststed, cfg.google_places_api_key, s)
            reason = google_reject(b)
            if reason:
                store.save(b.orgnr, b.name, "rejected", reason)
                return None

        if b.registry_email:
            b.emails.append({"email": b.registry_email.lower(), "confidence": "high", "source": "brreg"})
        if cfg.brave_search_api_key:
            for e in emails.search_emails(b.name, b.poststed, cfg.brave_search_api_key,
                                          cfg.fetch_result_pages, s):
                if e["email"] not in {x["email"] for x in b.emails}:
                    b.emails.append(e)

        if cfg.drop_if_email_domain_has_site:
            for e in b.emails:
                dom = emails.domain_of(e["email"])
                if not emails.is_free_provider(e["email"]) and emails.domain_has_website(dom, s):
                    store.save(b.orgnr, b.name, "rejected", f"email domain {dom} already hosts a website")
                    return None
    except requests.RequestException as exc:
        log.warning("Network error on %s (%s): %s; will retry next run", b.name, b.orgnr, exc)
        return None

    sc = score(b)
    if cfg.require_email and not b.emails:
        store.save(b.orgnr, b.name, "no_email", "no email found", sc, asdict(b))
        return None
    if sc < cfg.min_score:
        store.save(b.orgnr, b.name, "rejected", f"score {sc} < {cfg.min_score}", sc, asdict(b))
        return None
    store.save(b.orgnr, b.name, "lead", "", sc, asdict(b), reported=True)
    return to_row(b)
