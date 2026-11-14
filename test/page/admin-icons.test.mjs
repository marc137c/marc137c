// The Home Screen icons for /admin (scripts/make-admin-icons.mjs). Invariants:
//   1. each committed icon is a valid PNG (signature, chunk CRCs, IHDR) of its stated size, and its pixels are
//      exactly what the script draws today (so the files never drift from the script);
//   2. it uses only the site's own colours (the favicon's dark green and gold): every pixel is the green, the gold,
//      or a blend of the two, the corners are green, and there is a gold V;
//   3. the V stays inside the centre circle (radius 40 %) that Android keeps when it crops an icon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { renderIcon, crc32, GREEN, GOLD, SIZES, fileFor } from "../../scripts/make-admin-icons.mjs";

const SITE = fileURLToPath(new URL("../../viggos-barbershop/", import.meta.url));
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

// A small PNG reader for what the script writes: 8-bit RGB, no interlace, filter 0 on every row
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  let at = 8, ihdr, idat = [], ended = false;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    assert.equal(buf.readUInt32BE(at + 8 + len), crc32(buf.subarray(at + 4, at + 8 + len)), `CRC of ${type}`);
    if (type === "IHDR") ihdr = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    at += 12 + len;
  }
  assert.ok(ihdr && ended && idat.length, "IHDR, IDAT and IEND");
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], "8-bit RGB, no interlace");
  const rows = inflateSync(Buffer.concat(idat));
  assert.equal(rows.length, height * (width * 3 + 1));
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * (width * 3 + 1)], 0, `row ${y} filter`);
    rows.copy(rgb, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));
  }
  return { width, height, rgb };
}

test("admin icons: the colours are the site's own favicon colours", () => {
  const index = readFileSync(SITE + "index.html", "utf8");
  const favicon = decodeURIComponent(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/.exec(index)[1]);
  assert.match(favicon, new RegExp(`<rect[^>]*fill='${hex(GREEN)}'`), "the dark green background");
  assert.match(favicon, new RegExp(`<text[^>]*fill='${hex(GOLD)}'[^>]*>V<`), "the gold V");
});

for (const size of SIZES) {
  test(`admin icons: ${fileFor(size)} is a valid ${size}×${size} PNG, exactly what the script draws`, () => {
    const png = decodePng(readFileSync(SITE + fileFor(size)));
    assert.deepEqual([png.width, png.height], [size, size]);
    assert.ok(png.rgb.equals(renderIcon(size)), `run «node scripts/make-admin-icons.mjs» to update ${fileFor(size)}`);
  });

  test(`admin icons: ${fileFor(size)} is green with a gold V, only in those colours, inside the safe circle`, () => {
    const { rgb } = decodePng(readFileSync(SITE + fileFor(size)));
    const px = (x, y) => [...rgb.subarray((y * size + x) * 3, (y * size + x) * 3 + 3)];
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [Math.floor(size / 2), size - 2]]) {
      assert.deepEqual(px(x, y), GREEN, `pixel ${x},${y}`);
    }
    assert.deepEqual(px(Math.round(size * 0.35), Math.round(size * 0.4)), GOLD, "the thick left stroke");
    let gold = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = px(x, y);
        const t = (p[0] - GREEN[0]) / (GOLD[0] - GREEN[0]); // how much gold
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - (GREEN[k] + t * (GOLD[k] - GREEN[k]))) <= 1, `pixel ${x},${y} ${p} is a green/gold blend`);
        if (t > 0.01) {
          gold++;
          const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
          assert.ok(r <= 0.4, `pixel ${x},${y} of the V is outside the safe circle (r = ${r.toFixed(3)})`);
        }
      }
    }
    assert.ok(gold > size * size * 0.06 && gold < size * size * 0.3, `the V covers ${(100 * gold / size / size).toFixed(1)} %`);
  });
}
