"""SQLite memory of processed businesses, so each run only reports new leads."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS businesses (
    orgnr TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,          -- 'lead', 'rejected', 'no_email'
    reason TEXT,
    score INTEGER,
    data TEXT,
    checked_at TEXT,
    reported_at TEXT
);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def needs_check(self, orgnr: str, recheck_after_days: int) -> bool:
        row = self.db.execute(
            "SELECT status, checked_at FROM businesses WHERE orgnr = ?", (orgnr,)
        ).fetchone()
        if row is None:
            return True
        if row[0] == "lead":
            return False  # already found and reported; never report twice
        checked = datetime.fromisoformat(row[1])
        return datetime.now(timezone.utc) - checked > timedelta(days=recheck_after_days)

    def save(self, orgnr: str, name: str, status: str, reason: str = "", score: int = 0,
             data: dict | None = None, reported: bool = False) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute(
            """INSERT INTO businesses (orgnr, name, status, reason, score, data, checked_at, reported_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(orgnr) DO UPDATE SET name=excluded.name, status=excluded.status,
                 reason=excluded.reason, score=excluded.score, data=excluded.data,
                 checked_at=excluded.checked_at,
                 reported_at=COALESCE(excluded.reported_at, businesses.reported_at)""",
            (orgnr, name, status, reason, score, json.dumps(data or {}, ensure_ascii=False), now,
             now if reported else None),
        )
        self.db.commit()

    def counts(self) -> dict[str, int]:
        return dict(self.db.execute("SELECT status, COUNT(*) FROM businesses GROUP BY status").fetchall())
