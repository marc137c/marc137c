// A virtual clock shared by the fake Blobs store and the handler deps (deps.now / deps.sleep).
// Nothing in a test waits in real time: sleep(ms) moves the clock forward and yields one macrotask,
// so concurrent work still interleaves. Concurrent sleeps add up (time is serial), which is the
// pessimistic choice for time-budget assertions.
export class FakeClock {
  constructor(start = "2026-11-12T09:00:00Z") {
    this.ms = typeof start === "number" ? start : Date.parse(start);
    if (!Number.isFinite(this.ms)) throw new Error(`FakeClock: bad start time ${start}`);
  }
  now() { return this.ms; }
  date() { return new Date(this.ms); }
  set(time) { this.ms = typeof time === "number" ? time : Date.parse(time); return this; }
  advance(ms) { this.ms += Math.max(0, ms); return this; }
  async sleep(ms) {
    this.advance(ms);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Oslo wall-clock time as a Date: oslo("2026-11-19", 10, 15). November is CET (UTC+1), summer CEST (UTC+2).
export function oslo(date, hh = 0, mm = 0) {
  const pad = (n) => String(n).padStart(2, "0");
  for (const offset of ["+01:00", "+02:00"]) {
    const d = new Date(`${date}T${pad(hh)}:${pad(mm)}:00${offset}`);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    if (parts === `${pad(hh)}:${pad(mm)}`) return d;
  }
  throw new Error(`oslo(): ${date} ${hh}:${mm} does not exist in Europe/Oslo`);
}
