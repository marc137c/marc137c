// SMS-påminnelser: går gjennom avtalene i dag og de neste to dagene og sender påminnelse til dem
// reminderDue() sier ja til. Hver avtale merkes med remindedAt FØR SMS-en sendes (konfliktsikker
// skriving), så to kjøringer samtidig aldri gir dobbel SMS. Feiler sendingen, lagres feilen på avtalen.
import { osloNow, addDays, readMonths, mutateMonth, monthOf } from "./booking-core.mjs";
import { reminderDue, reminderText, sendSms, smsConfigured } from "./sms.mjs";

export async function runReminders(store, env, { now = new Date(), due = reminderDue, fetchFn = fetch } = {}) {
  if (!smsConfigured(env)) return { sent: 0, failed: 0, skipped: "not_configured" };
  const oslo = osloNow(now);
  const nowMs = now.getTime();
  const items = await readMonths(store, oslo.date, addDays(oslo.date, 2));
  let sent = 0, failed = 0;
  for (const it of items) {
    if (!due(it, oslo, nowMs)) continue;
    const claim = await mutateMonth(store, monthOf(it.date), (doc) => {
      const cur = doc.items.find((i) => i.id === it.id);
      if (!cur || !due(cur, oslo, nowMs)) return { error: "skip", status: 409 }; // endret/sendt i mellomtiden
      cur.remindedAt = now.toISOString();
      return { ok: true, item: { ...cur } };
    });
    if (claim.error) continue;
    const r = await sendSms(env, claim.item.phone, reminderText(claim.item, oslo.date), fetchFn);
    if (r.ok) { sent++; continue; }
    failed++;
    console.error("SMS-påminnelse feilet:", it.id, r.error);
    await mutateMonth(store, monthOf(it.date), (doc) => {
      const cur = doc.items.find((i) => i.id === it.id);
      if (!cur) return { error: "gone", status: 404 };
      cur.reminderError = r.error;
    });
  }
  return { sent, failed };
}
