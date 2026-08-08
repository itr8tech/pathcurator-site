// src/ui/publish-moodle.js — P10: the one-time "Moodle starter course" export. A hand-built
// course backup (.mbz = a zip with Moodle's documented backup layout) that restores AS A NEW
// COURSE with zero setup: course format `singleactivity` (opening the course IS opening the
// pathway) and the SCORM activity pre-configured the resource-friendly way — skip the "Enter"
// structure page, no attempt-status panel, unlimited attempts with force-new-attempt off (so
// exit=suspend resume just works across weeks), TOC disabled, grade item hidden from learners.
// The embedded package is BYTE-IDENTICAL to the standalone SCORM export: this file is only the
// day-zero bootstrap; afterwards the update loop is still "replace the package file".
//
// Format floor: the manifest claims Moodle 3.11 (2021051700) — Moodle restores older-version
// backups into newer sites, never the reverse, so this restores into every supported Moodle.
// Internal ids are arbitrary but must be mutually consistent; the pool file is addressed by the
// SHA-1 of its bytes (crypto.subtle), exactly like Moodle's own file storage.
import { buildPathwayScorm, scormIdentifier } from './publish-scorm.js';
import { buildZip } from './zip.js';

const today = () => new Date().toISOString().slice(0, 10);
const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XMLH = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NULLV = '$@NULL@$';                       // Moodle's literal encoding of SQL NULL
const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';   // sha1('') — the "." directory record

async function sha1hex(bytes) {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Arbitrary-but-consistent internal ids (restore remaps everything anyway).
const ID = { course: 101, courseCtx: 1000, sysCtx: 1, category: 1, module: 200, section: 300,
  moduleCtx: 401, scorm: 500, scoOrg: 600, scoItem: 601, gradeItem: 700,
  filePkg: 1, filePkgDir: 2, fileManifest: 3, fileIndex: 4, fileContentDir: 5 };

const MOODLE_VERSION = '2021051700';            // 3.11 — the compatibility floor
const MOODLE_RELEASE = '3.11';

// packageUrl (optional): the auto-updating variant — the activity points at a published package
// URL (scormtype "localsync") and re-checks it DAILY (updatefreq 2), so replacing content means
// committing in PathCurator, never touching Moodle. The extracted content still ships in the
// backup as the day-zero copy until the first cron fetch.
export async function buildPathwayMoodleCourse(db, { id, attribution = false, packageUrl = null }) {
  const pkg = await buildPathwayScorm(db, { id, attribution });
  const { name, slug } = pkg.meta;
  const sid = scormIdentifier(pkg.meta.id);
  const title = xmlEsc(name || 'Pathway');
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  // The player serves from mod_scorm's EXTRACTED copy (filearea "content"), not from the zip —
  // and our pre-registered sha1hash tells Moodle "already extracted", so it never unpacks the
  // package itself. A real backup carries both; so must we (learned from a live 404).
  const manifestBytes = enc.encode(pkg.parts.manifest);
  const indexBytes = enc.encode(pkg.parts.html);
  const pkgHash = await sha1hex(pkg.content);
  const manifestHash = await sha1hex(manifestBytes);
  const indexHash = await sha1hex(indexBytes);
  const siteHash = await sha1hex(enc.encode('pathcurator'));
  const backupId = pkgHash.slice(0, 32);
  const pkgName = xmlEsc(pkg.filename);
  const mbzName = `backup-pathcurator-${slug}.mbz`;

  const rootSetting = (n, v) => `    <setting><level>root</level><name>${n}</name><value>${v}</value></setting>`;
  const moodleBackupXml = XMLH + `<moodle_backup>
  <information>
    <name>${mbzName}</name>
    <moodle_version>${MOODLE_VERSION}</moodle_version>
    <moodle_release>${MOODLE_RELEASE}</moodle_release>
    <backup_version>${MOODLE_VERSION}</backup_version>
    <backup_release>${MOODLE_RELEASE}</backup_release>
    <backup_date>${now}</backup_date>
    <mnet_remoteusers>0</mnet_remoteusers>
    <include_files>1</include_files>
    <include_file_references_to_external_content>0</include_file_references_to_external_content>
    <original_wwwroot>https://pathcurator.invalid</original_wwwroot>
    <original_site_identifier_hash>${siteHash}</original_site_identifier_hash>
    <original_course_id>${ID.course}</original_course_id>
    <original_course_format>singleactivity</original_course_format>
    <original_course_fullname>${title}</original_course_fullname>
    <original_course_shortname>${xmlEsc(slug)}</original_course_shortname>
    <original_course_startdate>${now}</original_course_startdate>
    <original_course_enddate>0</original_course_enddate>
    <original_course_contextid>${ID.courseCtx}</original_course_contextid>
    <original_system_contextid>${ID.sysCtx}</original_system_contextid>
    <details>
      <detail backup_id="${backupId}">
        <type>course</type>
        <format>moodle2</format>
        <interactive>1</interactive>
        <mode>10</mode>
        <execution>1</execution>
        <executiontime>0</executiontime>
      </detail>
    </details>
    <contents>
      <activities>
        <activity>
          <moduleid>${ID.module}</moduleid>
          <sectionid>${ID.section}</sectionid>
          <modulename>scorm</modulename>
          <title>${title}</title>
          <directory>activities/scorm_${ID.module}</directory>
        </activity>
      </activities>
      <sections>
        <section>
          <sectionid>${ID.section}</sectionid>
          <title>0</title>
          <directory>sections/section_${ID.section}</directory>
        </section>
      </sections>
      <course>
        <courseid>${ID.course}</courseid>
        <title>${xmlEsc(slug)}</title>
        <directory>course</directory>
      </course>
    </contents>
    <settings>
${[['filename', mbzName], ['imscc11', 0], ['users', 0], ['anonymize', 0], ['role_assignments', 0],
    ['activities', 1], ['blocks', 0], ['files', 1], ['filters', 0], ['comments', 0], ['badges', 0],
    ['calendarevents', 0], ['userscompletion', 0], ['logs', 0], ['grade_histories', 0],
    ['questionbank', 0], ['groups', 0], ['competencies', 0], ['customfield', 0],
    ['contentbankcontent', 0]].map(([n, v]) => rootSetting(n, v)).join('\n')}
    <setting><level>section</level><section>section_${ID.section}</section><name>section_${ID.section}_included</name><value>1</value></setting>
    <setting><level>section</level><section>section_${ID.section}</section><name>section_${ID.section}_userinfo</name><value>0</value></setting>
    <setting><level>activity</level><activity>scorm_${ID.module}</activity><name>scorm_${ID.module}_included</name><value>1</value></setting>
    <setting><level>activity</level><activity>scorm_${ID.module}</activity><name>scorm_${ID.module}_userinfo</name><value>0</value></setting>
    </settings>
  </information>
</moodle_backup>
`;

  // File pool records: the package zip (filearea "package") AND its extracted contents (filearea
  // "content" — what the player actually serves), each filearea with its "." directory record.
  // Restore only copies files that an inforef references — every id appears in the activity's
  // inforef.xml below.
  const fileRec = (fid, area, hash, filename, size, mime) => `  <file id="${fid}">
    <contenthash>${hash}</contenthash>
    <contextid>${ID.moduleCtx}</contextid>
    <component>mod_scorm</component>
    <filearea>${area}</filearea>
    <itemid>0</itemid>
    <filepath>/</filepath>
    <filename>${filename}</filename>
    <userid>${NULLV}</userid>
    <filesize>${size}</filesize>
    <mimetype>${mime}</mimetype>
    <status>0</status>
    <timecreated>${now}</timecreated>
    <timemodified>${now}</timemodified>
    <source>${filename === '.' ? NULLV : filename}</source>
    <author>${NULLV}</author>
    <license>${NULLV}</license>
    <sortorder>0</sortorder>
    <repositorytype>${NULLV}</repositorytype>
    <repositoryid>${NULLV}</repositoryid>
    <reference>${NULLV}</reference>
  </file>`;
  const filesXml = XMLH + `<files>
${fileRec(ID.filePkg, 'package', pkgHash, pkgName, pkg.content.length, 'application/zip')}
${fileRec(ID.filePkgDir, 'package', EMPTY_SHA1, '.', 0, NULLV)}
${fileRec(ID.fileManifest, 'content', manifestHash, 'imsmanifest.xml', manifestBytes.length, 'application/xml')}
${fileRec(ID.fileIndex, 'content', indexHash, 'index.html', indexBytes.length, 'text/html')}
${fileRec(ID.fileContentDir, 'content', EMPTY_SHA1, '.', 0, NULLV)}
</files>
`;

  const courseXml = XMLH + `<course id="${ID.course}" contextid="${ID.courseCtx}">
  <shortname>${xmlEsc(slug)}</shortname>
  <fullname>${title}</fullname>
  <idnumber></idnumber>
  <summary>${xmlEsc(`Learning pathway published by PathCurator. Version: ${pkg.meta.version || 'n/a'}.`)}</summary>
  <summaryformat>1</summaryformat>
  <format>singleactivity</format>
  <showgrades>0</showgrades>
  <newsitems>0</newsitems>
  <startdate>${now}</startdate>
  <enddate>0</enddate>
  <marker>0</marker>
  <maxbytes>0</maxbytes>
  <legacyfiles>0</legacyfiles>
  <showreports>0</showreports>
  <visible>1</visible>
  <groupmode>0</groupmode>
  <groupmodeforce>0</groupmodeforce>
  <defaultgroupingid>0</defaultgroupingid>
  <lang></lang>
  <theme></theme>
  <timecreated>${now}</timecreated>
  <timemodified>${now}</timemodified>
  <requested>0</requested>
  <showactivitydates>0</showactivitydates>
  <showcompletionconditions>0</showcompletionconditions>
  <enablecompletion>1</enablecompletion>
  <completionnotify>0</completionnotify>
  <hiddensections>0</hiddensections>
  <coursedisplay>0</coursedisplay>
  <courseformatoptions>
    <courseformatoption>
      <format>singleactivity</format>
      <sectionid>0</sectionid>
      <name>activitytype</name>
      <value>scorm</value>
    </courseformatoption>
  </courseformatoptions>
  <category id="${ID.category}">
    <name>PathCurator</name>
    <description>${NULLV}</description>
  </category>
  <tags></tags>
</course>
`;

  const sectionXml = XMLH + `<section id="${ID.section}">
  <number>0</number>
  <name>${NULLV}</name>
  <summary></summary>
  <summaryformat>1</summaryformat>
  <sequence>${ID.module}</sequence>
  <visible>1</visible>
  <availabilityjson>${NULLV}</availabilityjson>
  <timemodified>${now}</timemodified>
</section>
`;

  const moduleXml = XMLH + `<module id="${ID.module}" version="${MOODLE_VERSION}">
  <modulename>scorm</modulename>
  <sectionid>${ID.section}</sectionid>
  <sectionnumber>0</sectionnumber>
  <idnumber></idnumber>
  <added>${now}</added>
  <score>0</score>
  <indent>0</indent>
  <visible>1</visible>
  <visibleoncoursepage>1</visibleoncoursepage>
  <visibleold>1</visibleold>
  <groupmode>0</groupmode>
  <groupingid>0</groupingid>
  <completion>2</completion>
  <completiongradeitemnumber>${NULLV}</completiongradeitemnumber>
  <completionview>0</completionview>
  <completionexpected>0</completionexpected>
  <availability>${NULLV}</availability>
  <showdescription>0</showdescription>
  <tags></tags>
</module>
`;

  // The resource-mode settings, baked in: skipview=2 (skip the structure/"Enter" page, always),
  // hidebrowse=1 (no preview mode), displayattemptstatus=0, displaycoursestructure=0, hidetoc=3
  // (TOC disabled — one SCO), maxattempt=0 (unlimited) + forcenewattempt=0 (resume forever, via
  // the SCO's exit=suspend), popup=0 (current window). completion=2 + completionstatusrequired=4:
  // Moodle marks the activity complete when the SCO reports "completed".
  const scormXml = XMLH + `<activity id="${ID.scorm}" moduleid="${ID.module}" modulename="scorm" contextid="${ID.moduleCtx}">
  <scorm id="${ID.scorm}">
    <name>${title}</name>
    <intro></intro>
    <introformat>1</introformat>
    <scormtype>${packageUrl ? 'localsync' : 'local'}</scormtype>
    <reference>${packageUrl ? xmlEsc(packageUrl) : pkgName}</reference>
    <sha1hash>${pkgHash}</sha1hash>
    <md5hash></md5hash>
    <revision>1</revision>
    <version>SCORM_1.2</version>
    <maxgrade>100</maxgrade>
    <grademethod>1</grademethod>
    <whatgrade>0</whatgrade>
    <maxattempt>0</maxattempt>
    <forcecompleted>0</forcecompleted>
    <forcenewattempt>0</forcenewattempt>
    <lastattemptlock>0</lastattemptlock>
    <masteryoverride>1</masteryoverride>
    <displayattemptstatus>0</displayattemptstatus>
    <displaycoursestructure>0</displaycoursestructure>
    <updatefreq>${packageUrl ? 2 : 0}</updatefreq>
    <skipview>2</skipview>
    <hidebrowse>1</hidebrowse>
    <hidetoc>3</hidetoc>
    <nav>0</nav>
    <navpositionleft>-100</navpositionleft>
    <navpositiontop>-100</navpositiontop>
    <auto>0</auto>
    <popup>0</popup>
    <options></options>
    <width>100</width>
    <height>800</height>
    <timeopen>0</timeopen>
    <timeclose>0</timeclose>
    <displayactivityname>0</displayactivityname>
    <autocommit>0</autocommit>
    <completionstatusrequired>4</completionstatusrequired>
    <completionscorerequired>${NULLV}</completionscorerequired>
    <completionstatusallscos>0</completionstatusallscos>
    <timemodified>${now}</timemodified>
    <scoes>
      <sco id="${ID.scoOrg}">
        <manifest>${sid}-MAN</manifest>
        <organization></organization>
        <parent>/</parent>
        <identifier>${sid}-ORG</identifier>
        <launch></launch>
        <scormtype></scormtype>
        <title>${title}</title>
        <sortorder>0</sortorder>
        <sco_datas></sco_datas>
      </sco>
      <sco id="${ID.scoItem}">
        <manifest>${sid}-MAN</manifest>
        <organization>${sid}-ORG</organization>
        <parent>${sid}-ORG</parent>
        <identifier>${sid}-ITEM</identifier>
        <launch>index.html</launch>
        <scormtype>sco</scormtype>
        <title>${title}</title>
        <sortorder>1</sortorder>
        <sco_datas></sco_datas>
      </sco>
    </scoes>
  </scorm>
</activity>
`;

  // Grade item present (mod_scorm always creates one) but HIDDEN from learners — resource mode.
  const gradesXml = XMLH + `<activity_gradebook>
  <grade_items>
    <grade_item id="${ID.gradeItem}">
      <categoryid>${NULLV}</categoryid>
      <itemname>${title}</itemname>
      <itemtype>mod</itemtype>
      <itemmodule>scorm</itemmodule>
      <iteminstance>${ID.scorm}</iteminstance>
      <itemnumber>0</itemnumber>
      <iteminfo>${NULLV}</iteminfo>
      <idnumber></idnumber>
      <calculation>${NULLV}</calculation>
      <gradetype>1</gradetype>
      <grademax>100.00000</grademax>
      <grademin>0.00000</grademin>
      <scaleid>${NULLV}</scaleid>
      <outcomeid>${NULLV}</outcomeid>
      <gradepass>0.00000</gradepass>
      <multfactor>1.00000</multfactor>
      <plusfactor>0.00000</plusfactor>
      <aggregationcoef>0.00000</aggregationcoef>
      <aggregationcoef2>0.00000</aggregationcoef2>
      <weightoverride>0</weightoverride>
      <sortorder>1</sortorder>
      <display>0</display>
      <decimals>${NULLV}</decimals>
      <hidden>1</hidden>
      <locked>0</locked>
      <locktime>0</locktime>
      <needsupdate>0</needsupdate>
      <timecreated>${now}</timecreated>
      <timemodified>${now}</timemodified>
      <grade_grades></grade_grades>
    </grade_item>
  </grade_items>
  <grade_letters></grade_letters>
</activity_gradebook>
`;

  const emptyRoles = XMLH + '<roles>\n  <role_overrides></role_overrides>\n  <role_assignments></role_assignments>\n</roles>\n';
  const emptyInforef = XMLH + '<inforef></inforef>\n';
  const activityInforef = XMLH + `<inforef>
  <fileref>
    <file><id>${ID.filePkg}</id></file>
    <file><id>${ID.filePkgDir}</id></file>
    <file><id>${ID.fileManifest}</id></file>
    <file><id>${ID.fileIndex}</id></file>
    <file><id>${ID.fileContentDir}</id></file>
  </fileref>
</inforef>
`;

  const A = `activities/scorm_${ID.module}`;
  const S = `sections/section_${ID.section}`;
  const entries = [
    { name: 'moodle_backup.xml', data: moodleBackupXml },
    { name: 'files.xml', data: filesXml },
    { name: 'gradebook.xml', data: XMLH + '<gradebook>\n  <grade_categories></grade_categories>\n  <grade_items></grade_items>\n  <grade_letters></grade_letters>\n  <grade_settings></grade_settings>\n</gradebook>\n' },
    { name: 'grade_history.xml', data: XMLH + '<grade_history>\n  <grade_grades></grade_grades>\n</grade_history>\n' },
    { name: 'groups.xml', data: XMLH + '<groups>\n  <groupings></groupings>\n</groups>\n' },
    { name: 'outcomes.xml', data: XMLH + '<outcomes_definition></outcomes_definition>\n' },
    { name: 'questions.xml', data: XMLH + '<question_categories></question_categories>\n' },
    { name: 'scales.xml', data: XMLH + '<scales_definition></scales_definition>\n' },
    { name: 'roles.xml', data: XMLH + '<roles_definition></roles_definition>\n' },
    { name: 'completion.xml', data: XMLH + '<course_completion></course_completion>\n' },
    { name: 'badges.xml', data: XMLH + '<badges></badges>\n' },
    { name: 'course/course.xml', data: courseXml },
    { name: 'course/enrolments.xml', data: XMLH + '<enrolments>\n  <enrols></enrols>\n</enrolments>\n' },
    { name: 'course/completiondefaults.xml', data: XMLH + '<course_completion_defaults></course_completion_defaults>\n' },
    { name: 'course/inforef.xml', data: emptyInforef },
    { name: 'course/roles.xml', data: emptyRoles },
    { name: `${S}/section.xml`, data: sectionXml },
    { name: `${S}/inforef.xml`, data: emptyInforef },
    { name: `${A}/module.xml`, data: moduleXml },
    { name: `${A}/scorm.xml`, data: scormXml },
    { name: `${A}/grades.xml`, data: gradesXml },
    { name: `${A}/roles.xml`, data: emptyRoles },
    { name: `${A}/inforef.xml`, data: activityInforef },
    { name: `files/${pkgHash.slice(0, 2)}/${pkgHash}`, data: pkg.content },
    { name: `files/${manifestHash.slice(0, 2)}/${manifestHash}`, data: manifestBytes },
    { name: `files/${indexHash.slice(0, 2)}/${indexHash}`, data: indexBytes },
    { name: `files/${EMPTY_SHA1.slice(0, 2)}/${EMPTY_SHA1}`, data: new Uint8Array(0) },
  ];

  return { content: buildZip(entries), filename: `${slug}--moodle-course${packageUrl ? '-auto' : ''}--${today()}.mbz` };
}
