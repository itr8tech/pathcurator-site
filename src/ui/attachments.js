// src/ui/attachments.js — header-image DISPLAY path (upload is stubbed in P2). BLOB → object URL,
// revoked on view unmount. No images exist in the real data yet, so this is built but not exercised.
import { db } from '/src/data/db.js';

export function makeObjectUrlScope() {
  const urls = new Set();
  return {
    async url(attachmentId) {
      const rec = await db.getAttachment(attachmentId);
      if (!rec || !rec.bytes) return null;
      const u = URL.createObjectURL(new Blob([rec.bytes], { type: rec.mime || 'application/octet-stream' }));
      urls.add(u);
      return u;                                   // set programmatically on img.src, never via the sanitizer
    },
    dispose() { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); },
  };
}
