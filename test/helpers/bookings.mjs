// Booking fixtures in the stored shape (netlify/lib/booking-core.mjs createItem), seeded straight into the
// fake server's "bookings" store as month documents m/YYYY-MM.
// Customers get CUSTOMER_PHONE, never the shop's own mobile (SHOP_MOBILE), so a test can tell an SMS to the
// customer from one to the barber in the fake Sveve's ledger.
export const CUSTOMER_PHONE = "912 34 567";
export const CUSTOMER_MOBILE = "91234567";
export const SHOP_MOBILE = "40963911";
let seq = 0;

export function item(over = {}) {
  const date = over.date || "2026-11-13";
  return {
    id: `${date}_seed${String(++seq).padStart(4, "0")}`,
    type: "booking",
    status: "confirmed",
    source: "nettside",
    date,
    start: 600,
    dur: 30,
    service: "Herreklipp",
    addons: [],
    name: "Ola Nordmann",
    phone: CUSTOMER_PHONE,
    note: "",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...over,
  };
}

// Writes the items into their month documents (replacing those documents). Returns the items.
export function seedItems(blobs, items) {
  const months = new Map();
  for (const i of items) {
    const ym = i.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym).push(i);
  }
  for (const [ym, list] of months) blobs.seed("bookings", `m/${ym}`, { items: list });
  return items;
}

// Every stored item across all month documents.
export function storedItems(blobs) {
  return blobs.keys("bookings").filter((k) => k.startsWith("m/")).flatMap((k) => blobs.json("bookings", k).items);
}
