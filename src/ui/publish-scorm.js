// src/ui/publish-scorm.js — P10 slice 1: SCORM 1.2 package. Two files: imsmanifest.xml + the P7
// artifact as index.html (one artifact, dual-mode — the SCO shim inside the P7 tracker activates
// only when an LMS API is discoverable). The manifest is the VERSION-CONTROL CONTRACT: identifiers
// derive deterministically from the pathway id, identical across every export of the same pathway,
// so replacing the package in an LMS is always an *update* (grades/attempts/completion preserved),
// never a "new SCO". No adlcp:masteryscore — deliberate: it makes LMSs recompute passed/failed
// over the status the SCO reports. Lean metadata (schema + schemaversion + title; no imsmd block —
// less surface for strict validators, and Moodle shows only the title anyway).
import { buildPathwayHtml } from './publish-html.js';
import { buildZip } from './zip.js';

const today = () => new Date().toISOString().slice(0, 10);
const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// FNV-1a 32-bit → base36 (same algorithm as the tracker's suspend keys).
function fnv36(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// xs:ID-safe deterministic identifier stem. Pathway ids can be bare numbers ("103") or carry any
// charset — the PC- prefix guarantees the leading letter; sanitization guarantees the charset.
// When sanitization ALTERS the id, a short hash of the raw id is appended so two distinct
// pathways can never collapse onto the same LMS identity ("a b" and "a-b" must differ).
export function scormIdentifier(rawId) {
  const raw = String(rawId);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  return safe === raw ? `PC-${safe}` : `PC-${safe}-${fnv36(raw)}`;
}

// Pure + exported so determinism is directly testable: same meta in → byte-identical XML out.
export function scormManifest({ id, name, version }) {
  const sid = scormIdentifier(id);
  const title = xmlEsc(name || 'Pathway');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${sid}-MAN" version="${xmlEsc(version || '1')}"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${sid}-ORG">
    <organization identifier="${sid}-ORG">
      <title>${title}</title>
      <item identifier="${sid}-ITEM" identifierref="${sid}-RES">
        <title>${title}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${sid}-RES" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>
`;
}

export async function buildPathwayScorm(db, { id, attribution = false }) {
  const page = await buildPathwayHtml(db, { id, attribution });
  const manifest = scormManifest(page.meta);
  return {
    content: buildZip([
      { name: 'imsmanifest.xml', data: manifest },
      { name: 'index.html', data: page.content },
    ]),
    filename: `${page.meta.slug}--scorm--${today()}.zip`,
    meta: page.meta,                              // for wrappers (the Moodle starter course)
    parts: { manifest, html: page.content },      // the Moodle backup must ALSO carry these extracted
  };
}
