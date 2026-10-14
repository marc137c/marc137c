# Lead Scout: Østfold businesses without a website

Lead Scout finds established businesses in Østfold that have **no website on their Google listing** but do have a phone number or email. It keeps only the ones that look like real website customers and writes them to a CSV you can email from. It runs on a schedule and reports each business once.

## How it decides

1. **Candidates** come from [Enhetsregisteret](https://data.brreg.no/enhetsregisteret/api/docs/index.html), Norway's free, official company register. It covers every company in the 12 Østfold municipalities. A candidate must be active (not bankrupt or in liquidation), have **5+ employees**, and be an AS/ANS/DA/SA/NUF company.
2. **Pre-filter (free):** drop a company if the register lists a website, or if its industry code isn't a fit. Holding companies, finance, public bodies and associations are excluded. Industries that lose customers without a website are scored higher: tradespeople, restaurants, salons, car repair, clinics, real estate, accounting and law, hotels, gyms, cleaning and landscaping.
3. **Google check:** look the company up on Google Places. If the listing has a website, it's dropped. Lead Scout also takes the phone number and review count from the listing; review count is a good sign of an active, customer-facing business.
4. **Email search:** search the web for `"Company name" town e-post` and pull emails from the results and the pages they link to (gulesider, proff, 1881 and similar). An email only counts if it plausibly belongs to that company. If the email is on the company's own domain (e.g. `post@firma.no`) and that domain serves a real site, the company already has a website and is dropped.
5. **Score 0–100** based on size, industry fit, Google reviews, email confidence and phone. Only leads scoring **50 or higher with an email** go on the list.

## Output

* `output/leads_YYYY-MM-DD.csv`: new leads from that run, best first.
* `output/leads_all.csv`: every lead found so far.
* Optional: the day's list is emailed to you as an attachment.

Columns: score, company, email, email_confidence, email_source, phone, employees, industry, address, kommune, google_reviews, google_rating, google_maps, why_a_fit, orgnr, registry_link.

Always open `email_source` and check a lead before you contact it. Matching is heuristic.

## Setup

```bash
cd lead-scout
pip install -r requirements.txt
cp config.example.toml config.toml        # optional; defaults cover all of Østfold

export GOOGLE_PLACES_API_KEY=...          # Google Cloud → enable "Places API (New)"
export BRAVE_SEARCH_API_KEY=...           # https://brave.com/search/api/ (free tier available)

# optional: email the daily list to yourselves (Gmail: use an App Password)
export SMTP_HOST=smtp.gmail.com SMTP_PORT=587
export SMTP_USER=you@gmail.com SMTP_PASSWORD=app-password NOTIFY_TO=you@gmail.com
```

Without the Google key, it relies on the register's website field only, which is less accurate. Without the Brave key, it only uses emails stored in the register.

## Running

```bash
python -m leadscout run                       # one pass
python -m leadscout run --loop --every 24h    # keep running, once a day
```

Or run it from cron on any always-on machine:

```
0 7 * * *  cd /path/to/lead-scout && /usr/bin/python3 -m leadscout run >> scout.log 2>&1
```

A SQLite database (`data/leadscout.db`) remembers every business it has checked. Each lead is reported only once. Rejected businesses and ones with no email are re-checked after 30 days. Each run checks at most 400 businesses (`max_candidates_per_run`) to keep API costs predictable. The rest are picked up on later runs.

**Cost:** each checked business uses about one Google Places Text Search call and one Brave search. Paid tiers are billed per call.

## Before you send emails (Norway)

* **Markedsføringsloven § 15:** you may send cold marketing email to *businesses* without consent, but sole proprietorships (ENK) count as private persons. That's why ENK is excluded by default. Don't add it back unless you have consent.
* Each email must say who it's from and include an easy opt-out. Honour opt-outs right away.
* Use the company's role address (post@, firmapost@, the listed Gmail). Avoid employees' personal addresses (GDPR).

## Tests

```bash
pip install pytest && python -m pytest
```
