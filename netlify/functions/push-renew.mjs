// POST /api/push/renew { oldEndpoint, oldAuth, subscription } – fra service workeren til timeboken (admin-sw.js) når
// nettleseren har byttet ut abonnementet (pushsubscriptionchange, f.eks. i Firefox). Service workeren har ingen
// innlogging, så serveren godtar det nye abonnementet bare i stedet for en lagret enhet der både den gamle adressen
// og dens auth-hemmelighet stemmer (renewSubscription i netlify/lib/push.mjs). Uten dette ville serveren sendt til
// den gamle adressen, fått 410 og slettet enheten, og Viggo hadde ikke fått varsel om nye bestillinger før han åpnet
// timeboken igjen. Svaret sier aldri noe om enhetene: 200 { ok: true } eller en feil.
import { liveDeps, bookingStore } from "../lib/runtime.mjs";
import { parseSubscription, renewSubscription, pushGen } from "../lib/push.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// deps: se netlify/lib/runtime.mjs (testene sender inn falsk lagring, miljø og klokke)
export async function handle(req, context, deps) {
  if (req.method !== "POST") return json({ error: "Bruk POST." }, 405);
  // Bare JSON fra vår egen side (service workeren er på samme nettsted)
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json({ error: "Bruk JSON.", code: "bad_content_type" }, 415);
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "Ikke tillatt.", code: "cross_site" }, 403);
  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "For stor forespørsel." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Ugyldig JSON." }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Ugyldig forespørsel." }, 400);
  const gen = pushGen(deps.env.ADMIN_PASSWORD);
  if (!gen) return json({ error: "Varsler er ikke satt opp.", code: "not_configured" }, 503);
  const v = parseSubscription(body.subscription);
  if (v.error) return json({ error: v.error, code: v.code }, 400);
  try {
    const store = bookingStore(deps, context); // forhåndsvisninger har sin egen lagring (F10)
    const r = await renewSubscription(store, { endpoint: body.oldEndpoint, auth: body.oldAuth }, v.value, { now: deps.now(), gen });
    if (r.error) return json({ error: r.error, code: r.code }, r.status);
    return json({ ok: true });
  } catch (err) {
    console.error("Push: kunne ikke fornye et abonnement:", err && err.name); // aldri adresser eller nøkler
    return json({ error: "Noe gikk galt på serveren." }, 500);
  }
}

export default (req, context) => handle(req, context, liveDeps());

export const config = { path: "/api/push/renew" };
