"""Write lead CSVs and optionally email them to the team."""
from __future__ import annotations

import csv
import smtplib
from email.message import EmailMessage
from pathlib import Path

from .brreg import Business
from .qualify import pitch_reason, score

COLUMNS = [
    "score", "company", "email", "email_confidence", "email_source", "phone", "employees",
    "industry", "address", "kommune", "google_reviews", "google_rating", "google_maps",
    "why_a_fit", "orgnr", "registry_link",
]


def to_row(b: Business) -> dict:
    g = b.google or {}
    best = b.emails[0] if b.emails else {}
    return {
        "score": score(b),
        "company": b.name,
        "email": best.get("email", ""),
        "email_confidence": best.get("confidence", ""),
        "email_source": best.get("source", ""),
        "phone": b.phone or "",
        "employees": b.employees,
        "industry": f"{b.nace_code} {b.nace_desc}",
        "address": f"{b.address}, {b.postnr} {b.poststed}".strip(", "),
        "kommune": b.kommune,
        "google_reviews": g.get("reviews", ""),
        "google_rating": g.get("rating", ""),
        "google_maps": g.get("maps_url", ""),
        "why_a_fit": pitch_reason(b),
        "orgnr": b.orgnr,
        "registry_link": f"https://virksomhet.brreg.no/oppslag/enheter/{b.orgnr}",
    }


def write_csv(path: Path, rows: list[dict], append: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists() or not append
    # BOM only at the start of a file, so Excel reads æøå correctly.
    encoding = "utf-8-sig" if new_file else "utf-8"
    with open(path, "a" if append else "w", newline="", encoding=encoding) as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        if new_file:
            w.writeheader()
        w.writerows(rows)


def email_report(cfg, csv_path: Path, rows: list[dict]) -> bool:
    if not (cfg.smtp_host and cfg.notify_to and rows):
        return False
    msg = EmailMessage()
    msg["Subject"] = f"Lead Scout: {len(rows)} new Østfold businesses without a website"
    msg["From"] = cfg.smtp_user or cfg.notify_to
    msg["To"] = cfg.notify_to
    top = "\n".join(f"- {r['company']} ({r['kommune']}), score {r['score']}: {r['email']}" for r in rows[:15])
    msg.set_content(f"{len(rows)} new leads found. Top of the list:\n\n{top}\n\nFull list attached.")
    msg.add_attachment(csv_path.read_bytes(), maintype="text", subtype="csv", filename=csv_path.name)
    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as smtp:
        smtp.starttls()
        if cfg.smtp_user:
            smtp.login(cfg.smtp_user, cfg.smtp_password or "")
        smtp.send_message(msg)
    return True
