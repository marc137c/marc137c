// Lager ikonene til timeboken (/admin) når den legges til på Hjem-skjermen: en gull «V» på mørk grønn bunn,
// i fargene fra nettsidens eget ikon (favicon i index.html: #0b4d3b og #f2cc1d). Bare Node, ingen nedlastinger.
//   viggos-barbershop/admin-icon-180.png  apple-touch-icon (iPhone/iPad)
//   viggos-barbershop/admin-icon-192.png  manifest og fane-ikon
//   viggos-barbershop/admin-icon-512.png  manifest (Android, oppstartsbilde)
//   viggos-barbershop/apple-touch-icon.png og favicon.ico (32 + 48 px)  nettsidens egne ikoner (index.html)
// Bunnen går helt ut i kantene (iPhone runder hjørnene selv), og V-en holder seg innenfor den midterste sirkelen
// (radius 40 %) som Android beholder når ikonet beskjæres («maskable»).
// Bruk: node scripts/make-admin-icons.mjs   (test/page/admin-icons.test.mjs sjekker at filene er oppdatert)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GREEN = [0x0b, 0x4d, 0x3b];
export const GOLD = [0xf2, 0xcc, 0x1d];
export const SIZES = [180, 192, 512];
export const fileFor = (size) => `admin-icon-${size}.png`;

// V-en i enhetskoordinater (0–1, y nedover): tykk venstre strek, tynn høyre, flate serifer øverst
export const SHAPES = [
  [[0.285, 0.27], [0.415, 0.27], [0.535, 0.75], [0.465, 0.75]], // venstre strek
  [[0.655, 0.27], [0.715, 0.27], [0.535, 0.75], [0.495, 0.75]], // høyre strek
  [[0.235, 0.255], [0.465, 0.255], [0.465, 0.285], [0.235, 0.285]], // venstre serif
  [[0.615, 0.255], [0.755, 0.255], [0.755, 0.285], [0.615, 0.285]], // høyre serif
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Rå RGB-piksler (size × size × 3), kantutjevnet med 4 × 4 prøver per piksel
export function renderIcon(size, samples = 4) {
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size, y = (py + (sy + 0.5) / samples) / size;
          if (x > 0.2 && x < 0.8 && y > 0.24 && y < 0.76 && SHAPES.some((s) => inside(s, x, y))) hits++;
        }
      }
      const c = hits / (samples * samples);
      for (let k = 0; k < 3; k++) rgb[(py * size + px) * 3 + k] = Math.round(GREEN[k] * (1 - c) + GOLD[k] * c);
    }
  }
  return rgb;
}

// ---------- PNG (8-bit RGB, ingen filtrering) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bitdybde
  ihdr[9] = 2;  // RGB
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); // filter 0 foran hver rad
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO (Windows-ikonmappe med PNG-bilder inni; alle målnettleserne leser det) ----------
export const ICO_SIZES = [32, 48];
export function encodeIco(sizes) {
  const pngs = sizes.map((s) => encodePng(s, renderIcon(s)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); // reservert
  head.writeUInt16LE(1, 2); // 1 = ikon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;     // bredde (0 = 256)
    head[e + 1] = s >= 256 ? 0 : s; // høyde
    head.writeUInt16LE(1, e + 4);   // fargeplan
    head.writeUInt16LE(32, e + 6);  // bit per piksel
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

// Nettsidens egne ikoner (F63): samme V, for iPhone-bokmerker og for nettlesere som spør etter /favicon.ico
export const SITE_ICONS = {
  "apple-touch-icon.png": () => encodePng(180, renderIcon(180)),
  "favicon.ico": () => encodeIco(ICO_SIZES),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = fileURLToPath(new URL("../viggos-barbershop/", import.meta.url));
  for (const size of SIZES) {
    writeFileSync(dir + fileFor(size), encodePng(size, renderIcon(size)));
    console.log(`Laget viggos-barbershop/${fileFor(size)}`);
  }
  for (const [name, make] of Object.entries(SITE_ICONS)) {
    writeFileSync(dir + name, make());
    console.log(`Laget viggos-barbershop/${name}`);
  }
}
