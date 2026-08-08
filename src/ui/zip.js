// src/ui/zip.js — P10: a zero-dependency STORED zip writer (no compression). Enough for LMS
// packages (SCORM / Common Cartridge): local file headers with sizes up-front (general-purpose
// bit 3 clear — no data descriptors), CRC-32, central directory, EOCD. Deterministic by design:
// FIXED DOS timestamp (1980-01-01) so identical inputs → identical bytes. Names are ASCII
// forward-slash paths; entries land at the archive root exactly as given. PHP ZipArchive/libzip
// (Moodle's unpacker) accepts stored entries without ceremony. Returns a Uint8Array — callers
// must hand BYTES to downloadFile (a binary string would be UTF-8-mangled by Blob).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;                                  // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1;            // 1980-01-01

// entries: [{ name: 'imsmanifest.xml', data: Uint8Array | string }]
export function buildZip(entries) {
  const enc = new TextEncoder();
  const files = entries.map((e) => {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name: enc.encode(e.name), data, crc: crc32(typeof e.data === 'string' ? enc.encode(e.data) : e.data) };
  });

  const chunks = [];
  let offset = 0;
  const push = (b) => { chunks.push(b); offset += b.length; };
  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const central = [];
  for (const f of files) {
    const localOffset = offset;
    push(u32(0x04034b50));                           // local file header signature
    push(u16(20)); push(u16(0)); push(u16(0));       // version 2.0, flags 0 (no descriptors), method 0 (stored)
    push(u16(DOS_TIME)); push(u16(DOS_DATE));
    push(u32(f.crc)); push(u32(f.data.length)); push(u32(f.data.length));
    push(u16(f.name.length)); push(u16(0));          // no extra field
    push(f.name); push(f.data);

    const h = [];
    h.push(u32(0x02014b50));                         // central directory header signature
    h.push(u16(20)); h.push(u16(20)); h.push(u16(0)); h.push(u16(0));
    h.push(u16(DOS_TIME)); h.push(u16(DOS_DATE));
    h.push(u32(f.crc)); h.push(u32(f.data.length)); h.push(u32(f.data.length));
    h.push(u16(f.name.length)); h.push(u16(0)); h.push(u16(0));
    h.push(u16(0)); h.push(u16(0)); h.push(u32(0));  // disk, internal attrs, external attrs
    h.push(u32(localOffset));
    h.push(f.name);
    central.push(h);
  }

  const cdStart = offset;
  for (const h of central) for (const b of h) push(b);
  const cdSize = offset - cdStart;

  push(u32(0x06054b50));                             // end of central directory
  push(u16(0)); push(u16(0));
  push(u16(files.length)); push(u16(files.length));
  push(u32(cdSize)); push(u32(cdStart));
  push(u16(0));                                      // no comment

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
