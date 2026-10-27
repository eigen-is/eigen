import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { readChartSpec } from '@workspace/lib/charts';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { XLSX_MIME } from '@workspace/lib/constants/mime';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { isCalendarPart } from '@workspace/lib/types/mail';
import {
    elementsInFrame,
    orderByFractionalIndex,
    parseBackgroundFill,
    parseBinding,
    readVectorFromDoc,
    sceneBounds,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { summarizeCalendarInvite } from '../../lib/calendar/imip';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { loadYjsState } from '../../lib/collab/yjs-loader';
import { openLocalDatabase } from '../../lib/core';
import { readSheetsFromDoc } from '../../lib/document/sheets';
import { parseMail } from '../../lib/mail/mail-parser/parse';
import {
    BRANDING,
    BUDGET,
    KANBAN,
    MAILS,
    PHOTOS,
    personaByRole,
    SHIFTS,
    SITE_PLAN,
    SPONSOR_DECK,
    TEAM_NAME,
    TRYING_EIGEN,
    VCARD_FILES,
} from '../../scripts/demo/content';

// Contract test for the demo-world seeder. The seeder relies on module-level singletons
// (the Elysia app, the auth DB, the Home map), so it cannot run in-process alongside the
// test harness — spawn it as a subprocess against a throwaway data root and inspect the
// produced files directly with a readonly bun:sqlite handle.
// Seeding the whole world takes ~30 s, so the file runs on CI and locally only on request.
const runSlow = Boolean(process.env['CI'] || process.env['EIGEN_SLOW_TESTS']);
const MAIL_DOMAIN = 'tuimel.test';
const API_DIR = join(import.meta.dir, '../../..');
const AVATARS_DIR = join(API_DIR, 'src', 'scripts', 'demo', 'fixtures', 'avatars');

// Read-write open (not readonly): the WAL-mode managed DBs need to (re)create their -shm on open,
// which readonly forbids. The seeder process has exited, so there is no lock contention, and the
// data root is a throwaway temp dir.
function query<T>(dbPath: string, sql: string): T[] {
    const db = new Database(dbPath);
    try {
        return db.query(sql).all() as T[];
    } finally {
        db.close();
    }
}

// Open a container's collab data.db (via a temp copy — openLocalDatabase writes WAL journals)
// and return its Y.Doc, using the same loader the shipped readers use.
async function loadCollabDoc(dataDbPath: string) {
    const tmp = join(mkdtempSync(join(tmpdir(), 'seed-demo-ydoc-')), 'data.db');
    cpSync(dataDbPath, tmp);
    return loadYjsState(await openLocalDatabase(COLLAB_DB_CONFIG, tmp)).doc;
}

// Every node of a doc's JSON, depth first, footnotes' paragraphs and table cells included.
function docNodes(json: JSONContent): JSONContent[] {
    return [json, ...(json.content ?? []).flatMap(docNodes)];
}

// A seeded message's raw bytes: the mail.db row names its file, which sits in a mailbox folder of the store.
function readMessage(personaHome: string, subject: string): Buffer {
    const mailDir = join(personaHome, 'eigen.mail');
    const rows = query<{ filename: string }>(
        join(mailDir, 'mail.db'),
        `SELECT filename FROM emails WHERE subject = '${subject}'`,
    );
    expect(rows.length).toBe(1);
    const file = readdirSync(mailDir, { recursive: true, encoding: 'utf8' }).find((rel) =>
        rel.endsWith(rows[0].filename),
    );
    if (!file) throw new Error(`message file for '${subject}' missing`);
    return readFileSync(join(mailDir, file));
}

function collectCommentMarkIds(json: JSONContent, out: Set<string>): void {
    for (const mark of json.marks ?? []) {
        if (mark.type === 'comment' && typeof mark.attrs?.['cardId'] === 'string') out.add(mark.attrs['cardId']);
    }
    for (const child of json.content ?? []) collectCommentMarkIds(child, out);
}

// Resolve a top-level container's data.db path from metadata.db (used for both the seeded doc
// and the stickies board — each container's data.db is a child path row, not the container itself).
function findContainerDataDb(metadataDb: string, mountsDir: string, mountId: string, containerName: string): string {
    const containerRow = query<{ id: string }>(
        metadataDb,
        `SELECT id FROM paths WHERE name = '${containerName}' AND trashedAt IS NULL`,
    );
    expect(containerRow.length).toBe(1);
    const dataDbRow = query<{ file: string }>(
        metadataDb,
        `SELECT file FROM paths WHERE parentId = '${containerRow[0].id}' AND name = 'data.db'`,
    );
    expect(dataDbRow.length).toBe(1);
    return join(mountsDir, mountId, 'data', dataDbRow[0].file);
}

describe.skipIf(!runSlow)('seed-demo', () => {
    test('produces a coherent Tuimel Festival world', async () => {
        const root = mkdtempSync(join(tmpdir(), 'eigen-demo-seed-'));
        try {
            // Env mirrors the real demo box: production mode, EIGEN_DEMO, and an https API_URL —
            // which makes better-auth __Secure--prefix its cookies, pinning the seeder's handling.
            const env: Record<string, string | undefined> = {
                ...process.env,
                EIGEN_DATA_ROOT: root,
                MAIL_DOMAIN,
                DOMAIN: MAIL_DOMAIN,
                PRODUCTION: '1',
                EIGEN_DEMO: '1',
                API_URL: 'https://localhost',
            };
            const proc = Bun.spawn(['bun', 'src/scripts/seed-demo.ts'], {
                cwd: API_DIR,
                env,
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            if (exitCode !== 0) {
                throw new Error(`seeder exited ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
            }

            // End-of-seed sentinel: the reset script's restart gate, written as the final step.
            expect(existsSync(join(root, 'server', '.demo-seeded'))).toBe(true);

            // Auth DB: the persona pool joined the default org as `member` (admin is `owner`).
            const usersDb = join(root, 'server', 'users3.db');
            expect(existsSync(usersDb)).toBe(true);
            const members = query<{ n: number }>(usersDb, "SELECT count(*) AS n FROM member WHERE role = 'member'");
            expect(members[0].n).toBeGreaterThanOrEqual(20);

            // Avatars: every org member got a portrait through the real avatar path — user.image
            // is set and the served webp exists under data/server/avatars (deterministic, offline).
            const membersMissingImage = query<{ n: number }>(
                usersDb,
                "SELECT count(*) AS n FROM member m JOIN user u ON u.id = m.user_id WHERE m.role = 'member' AND (u.image IS NULL OR u.image = '')",
            );
            expect(membersMissingImage[0].n).toBe(0);
            const avatarFiles = readdirSync(join(root, 'server', 'avatars')).filter((f) => f.endsWith('.webp'));
            expect(avatarFiles.length).toBeGreaterThanOrEqual(20);

            // One team: the default team setup made with the org, renamed to the crew, with every member in it.
            const teams = query<{ id: string; name: string }>(usersDb, 'SELECT id, name FROM team');
            expect(teams).toHaveLength(1);
            const teamId = teams[0].id;
            expect(teams[0].name).toBe(TEAM_NAME);
            const serverConfig = JSON.parse(readFileSync(join(root, 'server', 'config.json'), 'utf8'));
            expect(serverConfig.defaultTeamId).toBe(teamId);
            const outsideTeam = query<{ n: number }>(
                usersDb,
                'SELECT count(*) AS n FROM member m WHERE m.user_id NOT IN (SELECT user_id FROM team_member)',
            );
            expect(outsideTeam[0].n).toBe(0);
            expect(existsSync(join(root, 'team', teamId, 'mounts'))).toBe(true);

            // Team avatar: the festival logo fixture went through the same 512px-cover pipeline
            // as the avatar route — file existence under server/avatars is the source of truth.
            expect(existsSync(join(root, 'server', 'avatars', `team_${teamId}.webp`))).toBe(true);

            // Sample a persona: home dir exists, mail is indexed into mail.db.
            const personas = query<{ id: string }>(
                usersDb,
                "SELECT u.id AS id FROM member m JOIN user u ON u.id = m.user_id WHERE m.role = 'member' LIMIT 1",
            );
            expect(personas.length).toBe(1);
            const personaHome = join(root, 'home', personas[0].id);
            expect(existsSync(personaHome)).toBe(true);

            const mailDb = join(personaHome, 'eigen.mail', 'mail.db');
            expect(existsSync(mailDb)).toBe(true);
            const mail = query<{ n: number }>(mailDb, 'SELECT count(*) AS n FROM emails');
            expect(mail[0].n).toBeGreaterThanOrEqual(1);
            // Seeded attachments are real MIME parts, so the delivery parser flags the row — every
            // persona holds the all-hands mail that carries the logo.
            const withAttachments = query<{ n: number }>(
                mailDb,
                'SELECT count(*) AS n FROM emails WHERE hasAttachments = 1',
            );
            expect(withAttachments[0].n).toBeGreaterThanOrEqual(1);

            // A lead who answered an inbox thread holds the answered message flagged, as a real send leaves it.
            const replier = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${personaByRole('programming').key}@${MAIL_DOMAIN}'`,
            );
            expect(replier.length).toBe(1);
            const replied = query<{ n: number }>(
                join(root, 'home', replier[0].id, 'eigen.mail', 'mail.db'),
                "SELECT count(*) AS n FROM emails WHERE isReplied = 1 AND mailbox = 'INBOX'",
            );
            expect(replied[0].n).toBeGreaterThanOrEqual(1);

            // A reply quotes the message it answers below its own text, in the HTML and the text part alike, as
            // Eigen's composer quotes on reply.
            const askedMail = MAILS.find((mail) => mail.subject === 'Are you doing it again this year');
            const asked = askedMail?.messages[0];
            if (!askedMail || !asked?.fromExternal) throw new Error('the seeded question from outside is missing');
            const askedParagraph = asked.text.split('\n\n')[1];
            const director = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${personaByRole('director').key}@${MAIL_DOMAIN}'`,
            );
            const answer = parseMail(readMessage(join(root, 'home', director[0].id), `Re: ${askedMail.subject}`));
            const quoteHeader = `${asked.fromExternal.name} <${asked.fromExternal.email}> wrote:`;
            expect(answer.text).toContain(`${quoteHeader}\n\n`);
            expect(answer.text?.indexOf(askedParagraph)).toBeGreaterThan(answer.text?.indexOf(quoteHeader) ?? -1);
            const quoteHtml = answer.html?.slice(answer.html.indexOf('wrote:</p><blockquote>')) ?? '';
            expect(quoteHtml).toStartWith('wrote:</p><blockquote>');
            expect(quoteHtml).toContain(askedParagraph);

            // Team drive: file history populated (actors were threaded through every mutation).
            const mountsDir = join(root, 'team', teamId!, 'mounts');
            expect(existsSync(mountsDir)).toBe(true);
            // mounts/ also holds shared.db — pick the mount's own subdirectory.
            const mountId = readdirSync(mountsDir, { withFileTypes: true }).find((d) => d.isDirectory())?.name;
            if (!mountId) throw new Error('team mount directory missing');
            const metadataDb = join(mountsDir, mountId, 'metadata.db');
            expect(existsSync(metadataDb)).toBe(true);
            const events = query<{ n: number }>(metadataDb, 'SELECT count(*) AS n FROM file_events');
            expect(events[0].n).toBeGreaterThanOrEqual(1);

            // Team drive images/: every site photo landed as a real .webp blob on disk (each row's
            // `file` is the storage key under the mount's data dir, non-trivial size = real image data).
            const imagesFolder = query<{ id: string }>(
                metadataDb,
                "SELECT id FROM paths WHERE name = 'images' AND trashedAt IS NULL",
            );
            expect(imagesFolder.length).toBe(1);
            const photoRows = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${imagesFolder[0].id}' AND trashedAt IS NULL`,
            );
            expect(photoRows.length).toBe(PHOTOS.length);
            for (const photo of photoRows) {
                expect(photo.name).toEndWith('.webp');
                const blob = join(mountsDir, mountId, 'data', photo.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(10_000);
            }

            // Team drive branding/: the logo landed as a real blob on disk.
            const brandingFolder = query<{ id: string }>(
                metadataDb,
                "SELECT id FROM paths WHERE name = 'branding' AND trashedAt IS NULL",
            );
            expect(brandingFolder.length).toBe(1);
            const brandingRows = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${brandingFolder[0].id}' AND trashedAt IS NULL`,
            );
            expect(brandingRows.length).toBe(BRANDING.length);
            for (const asset of brandingRows) {
                const blob = join(mountsDir, mountId, 'data', asset.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(0);
            }

            // Team drive contact cards: each spec was serialized and uploaded as a real .vcf blob.
            for (const card of VCARD_FILES) {
                const cardFolder = query<{ id: string }>(
                    metadataDb,
                    `SELECT id FROM paths WHERE name = '${card.folder}' AND trashedAt IS NULL`,
                );
                expect(cardFolder.length).toBe(1);
                const cardRows = query<{ file: string }>(
                    metadataDb,
                    `SELECT file FROM paths WHERE parentId = '${cardFolder[0].id}' AND name = '${card.name}' AND trashedAt IS NULL`,
                );
                expect(cardRows.length).toBe(1);
                const cardBlob = join(mountsDir, mountId, 'data', cardRows[0].file);
                expect(statSync(cardBlob).size).toBeGreaterThan(0);
                // The portrait only rides along once its fixture is committed; the seeder skips a missing one.
                if (card.card.photo && existsSync(join(AVATARS_DIR, card.card.photo))) {
                    expect(readFileSync(cardBlob, 'utf8')).toContain('PHOTO;ENCODING=b');
                }
            }

            // Personal notes: the sampled persona's own drive has a "my notes" eigendoc container.
            const personaMetaDb = join(personaHome, 'mounts', 'default', 'metadata.db');
            expect(existsSync(personaMetaDb)).toBe(true);
            const notesDoc = query<{ n: number }>(
                personaMetaDb,
                "SELECT count(*) AS n FROM paths WHERE name = 'my notes.eigendoc' AND trashedAt IS NULL",
            );
            expect(notesDoc[0].n).toBe(1);

            // ...and a "trying eigen" scratch doc: one displayed equation node holding MathML and the LaTeX, and a
            // figure with no caption whose photo landed in the doc's media/.
            const tryingDoc = await loadCollabDoc(
                findContainerDataDb(
                    personaMetaDb,
                    join(personaHome, 'mounts'),
                    'default',
                    `${TRYING_EIGEN.name}.eigendoc`,
                ),
            );
            const tryingNodes = docNodes(yXmlFragmentToProsemirrorJSON(tryingDoc.getXmlFragment('default')));
            const equations = tryingNodes.filter((node) => node.type === 'equation');
            expect(equations.length).toBe(1);
            expect(equations[0].attrs?.['display']).toBe(true);
            expect(equations[0].attrs?.['mathml']).toContain(
                '<annotation encoding="application/x-tex">\\mathbf{eigen}\\,|\\text{docs}\\rangle</annotation>',
            );
            const tryingFigures = tryingNodes.filter((node) => node.type === 'figure');
            expect(tryingFigures.length).toBe(1);
            expect(tryingFigures[0].attrs?.['caption']).toBeFalsy();
            const tryingId = query<{ id: string }>(
                personaMetaDb,
                `SELECT id FROM paths WHERE name = '${TRYING_EIGEN.name}.eigendoc' AND trashedAt IS NULL`,
            )[0].id;
            const tryingMedia = query<{ name: string }>(
                personaMetaDb,
                `SELECT p.name FROM paths p JOIN paths m ON p.parentId = m.id WHERE m.parentId = '${tryingId}' AND m.name = 'media'`,
            ).map((row) => row.name);
            expect(tryingMedia).toContain(tryingFigures[0].attrs?.['mediaName']);

            // A persona's own calendar holds their shift, beside the team calendar's events.
            const financeKey = personaByRole('finance').key;
            const financeShift = SHIFTS.find((shift) => shift.persona === financeKey);
            if (!financeShift) throw new Error('the finance lead has no shift');
            const finance = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${financeKey}@${MAIL_DOMAIN}'`,
            );
            expect(finance.length).toBe(1);
            const financeHome = join(root, 'home', finance[0].id);
            const financeCalendarDb = join(financeHome, 'eigen.calendar', 'calendar.db');
            const financeEvents = query<{ title: string }>(financeCalendarDb, 'SELECT title FROM events').map(
                (row) => row.title,
            );
            expect(financeEvents).toContain(financeShift.title);

            // Budget sheet: built from BUDGET (demo/sheet-build.ts) and decoded through the shipped reader. The
            // formulas hold their computed values; the amounts carry data bars, the margin a red rule below zero and
            // the status cells a dropdown; and the second tab's charts read the first tab by its id.
            const sheetDataDb = findContainerDataDb(metadataDb, mountsDir, mountId, `${BUDGET.name}.eigensheets`);
            const { sheets } = readSheetsFromDoc(await loadCollabDoc(sheetDataDb), { recalc: false });
            expect(sheets.map((sheet) => sheet.name)).toEqual(BUDGET.sheets.map((sheet) => sheet.name));
            const [budgetSheet, chartsSheet] = sheets;
            const margin = budgetSheet.celldata?.find((cell) => cell.v?.f === '=B8-B17');
            expect(margin?.v?.v).toBe(16000);
            const rules = budgetSheet.conditionalFormatRules ?? [];
            expect(rules.filter((rule) => rule.type === 'dataBar').length).toBe(2);
            expect(
                rules.some(
                    (rule) =>
                        rule.type === 'default' && rule.conditionName === 'lessThan' && rule.conditionValue[0] === 0,
                ),
            ).toBe(true);
            const dropdowns = Object.values(budgetSheet.dataVerification ?? {});
            expect(dropdowns.length).toBe(10);
            for (const rule of dropdowns) expect(rule.type).toBe('dropdown');
            const charts = Object.values(chartsSheet.charts ?? {}).map((chart) => readChartSpec(chart).spec);
            expect(charts.map((spec) => spec?.chart.type).sort()).toEqual(['column', 'pie']);
            for (const spec of charts) {
                if (spec?.data.source !== 'range') throw new Error('a budget chart holds no range data');
                expect(spec.data.series[0].values?.sheetId).toBe(budgetSheet.id);
            }

            // Sponsor deck: built from code out of SPONSOR_DECK (no fixture bytes; see demo/deck-build.ts).
            // Its images are uploaded into the container's media/ folder, which the deck references by name.
            const deck = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE name = '${SPONSOR_DECK.name}.eigenslides' AND trashedAt IS NULL`,
            );
            expect(deck.length).toBe(1);
            const deckMedia = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE parentId = '${deck[0].id}' AND name = 'media' AND trashedAt IS NULL`,
            );
            expect(deckMedia.length).toBe(1);
            const deckImages = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${deckMedia[0].id}' AND trashedAt IS NULL`,
            );
            const deckImageSpecs = SPONSOR_DECK.slides.flatMap((slide) => slide.images ?? []);
            expect(deckImages.length).toBe(deckImageSpecs.length);
            for (const img of deckImages) {
                const blob = join(mountsDir, mountId, 'data', img.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(0);
            }

            // ...and the deck reads back through the shipped canvas reader: one frame per slide, every
            // element homed to a frame that exists (a dangling frameId re-homes on read and would
            // silently move a slide's content) and canonical geometry on every one of them.
            const deckDoc = await loadCollabDoc(
                findContainerDataDb(metadataDb, mountsDir, mountId, `${SPONSOR_DECK.name}.eigenslides`),
            );
            const deckScene = readVectorFromDoc(deckDoc);
            expect(deckScene.frames.length).toBe(SPONSOR_DECK.slides.length);
            expect(deckScene.elements.length).toBe(
                SPONSOR_DECK.slides.reduce((n, slide) => n + slide.texts.length + (slide.images?.length ?? 0), 0),
            );
            const deckFrameIds = new Set(deckScene.frames.map((frame) => frame.id));
            for (const element of deckScene.elements) {
                for (const field of ['x', 'y', 'width', 'height', 'angle'] as const) {
                    expect(Number.isFinite(element[field])).toBe(true);
                }
                // A horizontal arrow's box is zero-height by construction, so it is the larger side
                // that must be real — a collapsed element would render as nothing.
                expect(Math.max(element.width, element.height)).toBeGreaterThan(0);
                expect(deckFrameIds.has(element.frameId)).toBe(true);
            }

            // Slide order is the authored order, and the title slide carries the gradient background.
            const deckFrames = orderByFractionalIndex(deckScene.frames);
            expect(deckFrames.map((frame) => frame.name)).toEqual(SPONSOR_DECK.slides.map((slide) => slide.name));
            expect(parseBackgroundFill(deckFrames[0].background)?.type).toBe('gradient');
            for (const frame of deckFrames) expect(parseBackgroundFill(frame.background)).not.toBeNull();

            // Every slide holds text, every text box holds a body, and each image names a media file
            // that landed.
            const deckMediaNames = new Set(deckImages.map((img) => img.name));
            for (const frame of deckFrames) {
                const onFrame = elementsInFrame(deckScene.elements, frame.id);
                expect(onFrame.filter((el) => el.type === 'richtext').length).toBeGreaterThanOrEqual(1);
            }
            for (const element of deckScene.elements) {
                if (element.type === 'richtext') expect(element.html.length).toBeGreaterThan(0);
                if (element.type === 'image') expect(deckMediaNames.has(element.mediaName)).toBe(true);
            }
            expect(deckScene.elements.filter((el) => el.type === 'image').length).toBe(deckImageSpecs.length);

            // Team calendar: seeded events exist on the enabled team calendar.
            const calendarDb = join(root, 'team', teamId!, 'eigen.calendar', 'calendar.db');
            expect(existsSync(calendarDb)).toBe(true);
            const calEvents = query<{ n: number }>(calendarDb, 'SELECT count(*) AS n FROM events');
            expect(calEvents[0].n).toBeGreaterThanOrEqual(1);

            // The festival is all-day and MUST be stored as UTC midnight with an exclusive end (the
            // frontend buckets all-day events by their UTC date — local midnight would shift the
            // festival a day early in a UTC+ timezone). It always lands on a Saturday and spans Sat+Sun.
            const allDay = query<{ startTime: number; endTime: number }>(
                calendarDb,
                'SELECT startTime, endTime FROM events WHERE allDay = 1',
            );
            expect(allDay.length).toBeGreaterThanOrEqual(1);
            for (const ev of allDay) {
                const start = new Date(ev.startTime * 1000);
                const end = new Date(ev.endTime * 1000);
                expect(start.getUTCHours()).toBe(0);
                expect(start.getUTCMinutes()).toBe(0);
                expect(start.getUTCDay()).toBe(6); // Saturday, in UTC
                expect(end.getTime() - start.getTime()).toBe(2 * 86_400_000); // spans Sat + Sun
            }

            // Doc comments: the panel renders exclusively from the doc's `comments` Y.Map, and
            // only cards anchored by a comment mark in the text. Assert both for the seeded doc.
            const docDataDb = findContainerDataDb(metadataDb, mountsDir, mountId, 'production plan.eigendoc');
            const ydoc = await loadCollabDoc(docDataDb);

            // The production plan holds a table, a footnote, and a figure whose photo landed in the doc's media/.
            const planNodes = docNodes(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default')));
            expect(planNodes.some((node) => node.type === 'table')).toBe(true);
            expect(planNodes.some((node) => node.type === 'footnote')).toBe(true);
            const figures = planNodes.filter((node) => node.type === 'figure');
            expect(figures.length).toBe(1);
            const planId = query<{ id: string }>(
                metadataDb,
                "SELECT id FROM paths WHERE name = 'production plan.eigendoc' AND trashedAt IS NULL",
            )[0].id;
            const planMedia = query<{ name: string }>(
                metadataDb,
                `SELECT p.name FROM paths p JOIN paths m ON p.parentId = m.id WHERE m.parentId = '${planId}' AND m.name = 'media'`,
            ).map((row) => row.name);
            expect(planMedia).toContain(figures[0].attrs?.['mediaName']);
            const cards = [...ydoc.getMap<Y.Map<unknown>>('comments').values()].map((card) => ({
                id: card.get('id') as string,
                color: card.get('color') as string,
                chatName: card.get('chatName') as string,
                creator: card.get('creator') as string,
                attachments: (card.get('attachments') as AttachmentReference[] | undefined) ?? [],
            }));
            expect(cards.length).toBeGreaterThanOrEqual(3);
            const defaultCardColor = EIGEN_STICKIES_COLORS[0][1].value;
            for (const card of cards) {
                expect(card.color).toBe(defaultCardColor);
                expect(card.chatName).toEndWith('.eigenchat');
                expect(card.creator).toContain('@');
            }
            const anchored = new Set<string>();
            collectCommentMarkIds(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default')), anchored);
            for (const card of cards) {
                expect(anchored.has(card.id)).toBe(true);
            }

            // Stickies board: every card gets the same default color plus a real linked chat
            // (same pattern as doc comments), so no card ever renders uncolored or unlinked.
            const boardDataDb = findContainerDataDb(metadataDb, mountsDir, mountId, `${KANBAN.name}.eigenstickies`);
            const board = await loadCollabDoc(boardDataDb);
            const tasks = [...board.getMap<Y.Map<unknown>>('tasks').values()].map((task) => ({
                color: task.get('color') as string,
                chatName: task.get('chatName') as string,
                creator: task.get('creator') as string,
            }));
            expect(tasks.length).toBeGreaterThanOrEqual(8);
            for (const task of tasks) {
                expect(task.color).toBe(defaultCardColor);
                expect(task.chatName).toEndWith('.eigenchat');
                expect(task.creator).toContain('@');
            }

            // A card chat reply's attachVCards uploads the card into that chat's own media/ folder, the
            // folder the thread resolves attachment names in, and the message names the file.
            const vcardReplyCard = KANBAN.cards.find((card) => card.chatReplies?.some((r) => r.attachVCards));
            if (!vcardReplyCard) throw new Error('no kanban card chat reply attaches a vCard');
            const cardChat = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE name = '${vcardReplyCard.chat}.eigenchat' AND trashedAt IS NULL`,
            );
            expect(cardChat.length).toBe(1);
            const cardChatMedia = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE parentId = '${cardChat[0].id}' AND name = 'media' AND trashedAt IS NULL`,
            );
            expect(cardChatMedia.length).toBe(1);
            const cardChatFiles = query<{ name: string }>(
                metadataDb,
                `SELECT name FROM paths WHERE parentId = '${cardChatMedia[0].id}' AND trashedAt IS NULL`,
            ).map((row) => row.name);
            expect(cardChatFiles).toContain('dekzeil & zo.vcf');
            const cardChatAttachments = query<{ attachments: string }>(
                findContainerDataDb(metadataDb, mountsDir, mountId, `${vcardReplyCard.chat}.eigenchat`),
                'SELECT attachments FROM messages WHERE attachments IS NOT NULL',
            ).flatMap((row) => JSON.parse(row.attachments) as unknown[]);
            expect(cardChatAttachments).toContain('dekzeil & zo.vcf');

            // Site plan: a vector drawing built straight into the container's Y.Doc from SITE_PLAN
            // (no fixture). It reads back through the shipped reader with surviving shape bindings,
            // elbow arrows, measured rich text, and every image pointing at a media file that landed.
            const vectorName = `${SITE_PLAN.name}.eigenvector`;
            const vectorDataDb = findContainerDataDb(metadataDb, mountsDir, mountId, vectorName);
            const scene = readVectorFromDoc(await loadCollabDoc(vectorDataDb));
            expect(scene.elements.length).toBeGreaterThanOrEqual(60);
            expect(scene.meta.background).toBe(SITE_PLAN.background);

            // Chat lines with `attach` post the seeded document as a drive-reference attachment
            // that points at the real container (the site plan, in #production).
            const sitePlanId = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE name = '${vectorName}' AND trashedAt IS NULL`,
            )[0].id;
            const productionChatDb = findContainerDataDb(metadataDb, mountsDir, mountId, 'production.eigenchat');
            const attached = query<{ attachments: string }>(
                productionChatDb,
                'SELECT attachments FROM messages WHERE attachments IS NOT NULL',
            ).flatMap((row) => JSON.parse(row.attachments) as AttachmentReference[]);
            expect(attached.some((a) => a.type === 'reference' && a.id === sitePlanId)).toBe(true);
            // ...and a kanban card / doc comment with `attach` carries the same reference on the card.
            const pinned = [...board.getMap<Y.Map<unknown>>('tasks').values()]
                .flatMap((task) => (task.get('attachments') as AttachmentReference[] | undefined) ?? [])
                .concat(cards.flatMap((card) => card.attachments));
            expect(pinned.some((a) => a.type === 'reference' && a.id === sitePlanId)).toBe(true);
            expect(pinned.some((a) => a.type === 'reference' && a.name === 'crew roster.eigendoc')).toBe(true);

            // The editor opens on the scene origin, so the drawing is stored centered on it.
            const byId = new Map(scene.elements.map((el) => [el.id, el]));
            const bounds = sceneBounds(scene.elements, byId);
            expect(bounds.minX + bounds.maxX).toBeCloseTo(0, 6);
            expect(bounds.minY + bounds.maxY).toBeCloseTo(0, 6);

            // The crowd-flow arrow is the drawing's axis: it runs up the gate's center to the main
            // stage's center, and the west margin is sized so that axis lands on the scene origin.
            const crowdFlow = scene.elements.filter((el) => el.type === 'arrow' && el.text === 'crowd flow');
            expect(crowdFlow.length).toBe(1);
            const crowdBounds = sceneBounds(crowdFlow, byId);
            expect(crowdBounds.minX + crowdBounds.maxX).toBeCloseTo(0, 6);

            // Z-order: the fence outline sits under everything (a click inside it lands on what it
            // encloses), and the wind-cover ring sits just under the stage it rings.
            const zOrder = orderByFractionalIndex(scene.elements).map((el) => el.id);
            expect(zOrder[0]).toBe('el-fence');
            expect(zOrder.indexOf('el-wind-cover')).toBe(zOrder.indexOf('el-second-stage') - 1);

            // The reader clears dangling bindings, so a surviving endBinding proves its target is present.
            const elementIds = new Set(scene.elements.map((el) => el.id));
            const boundArrows = scene.elements.filter((el) => {
                if (el.type !== 'arrow') return false;
                const binding = parseBinding(el.endBinding);
                return binding !== null && elementIds.has(binding.elementId);
            });
            expect(boundArrows.length).toBeGreaterThanOrEqual(6);
            expect(scene.elements.filter((el) => el.type === 'arrow' && el.elbow).length).toBeGreaterThanOrEqual(3);
            // Every label is a measured rich-text box. The count floor keeps the size loop honest —
            // a builder that stopped emitting text would otherwise iterate nothing and pass.
            const richText = scene.elements.filter((el) => el.type === 'richtext');
            expect(richText.length).toBeGreaterThanOrEqual(40);
            for (const text of richText) {
                expect(text.width).toBeGreaterThan(0);
                expect(text.height).toBeGreaterThan(0);
            }

            // Each image element names a real file under the container's media/ folder.
            const vectorContainer = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE name = '${vectorName}' AND trashedAt IS NULL`,
            );
            const vectorMedia = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE parentId = '${vectorContainer[0].id}' AND name = 'media' AND trashedAt IS NULL`,
            );
            const vectorMediaNames = new Set(
                query<{ name: string }>(
                    metadataDb,
                    `SELECT name FROM paths WHERE parentId = '${vectorMedia[0].id}' AND trashedAt IS NULL`,
                ).map((row) => row.name),
            );
            let imageCount = 0;
            for (const el of scene.elements) {
                if (el.type !== 'image') continue;
                imageCount++;
                expect(vectorMediaNames.has(el.mediaName)).toBe(true);
            }
            expect(imageCount).toBeGreaterThanOrEqual(1);

            // An outside sender's iMIP invitation reaches the finance lead's inbox as a card, while their calendar is
            // left alone: seeded mail carries no DKIM verdict, the path an unverified sender takes.
            const inviteMail = MAILS.find((mail) => mail.messages.some((message) => message.invite));
            const invite = inviteMail?.messages.find((message) => message.invite)?.invite;
            if (!inviteMail || !invite) throw new Error('no seeded mail carries an invitation');
            const inviteParts = parseMail(readMessage(financeHome, inviteMail.subject)).attachments.filter(
                isCalendarPart,
            );
            expect(inviteParts.length).toBe(1);
            const card = summarizeCalendarInvite(inviteParts[0]);
            expect(card?.method).toBe('REQUEST');
            expect(card?.summary).toBe(invite.title);
            expect(financeEvents).not.toContain(invite.title);

            // The generator quote arrives as a real xlsx attachment.
            const quoteMail = MAILS.find((mail) =>
                mail.messages.some((message) => message.attachments?.some((a) => 'workbook' in a)),
            );
            if (!quoteMail) throw new Error('no seeded mail attaches a workbook');
            const production = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${personaByRole('production').key}@${MAIL_DOMAIN}'`,
            );
            const quoteParts = parseMail(
                readMessage(join(root, 'home', production[0].id), quoteMail.subject),
            ).attachments;
            expect(quoteParts.some((part) => part.contentType === XLSX_MIME && part.size > 1000)).toBe(true);

            // Assignment: the volunteer coordinator got the bell notification the assign route persists.
            const assignees = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${personaByRole('volunteers').key}@${MAIL_DOMAIN}'`,
            );
            expect(assignees.length).toBe(1);
            const notifications = query<{ n: number }>(
                join(root, 'home', assignees[0].id, 'eigen.notifications', 'notifications.db'),
                "SELECT count(*) AS n FROM notifications WHERE type = 'assigned'",
            );
            expect(notifications[0].n).toBeGreaterThanOrEqual(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120_000);
});
