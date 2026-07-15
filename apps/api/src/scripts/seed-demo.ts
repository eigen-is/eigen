/**
 * seed-demo.ts — builds the "Tuimel Festival" demo world for an EIGEN_DEMO instance.
 *
 * Offline, in-process seeder. Boots the API in the same process (as the test harness does),
 * runs first-run setup, creates a ~20-persona crew in one org + team, and fills a lived-in
 * workspace — team drive, docs, a budget sheet, a slides deck and a stickies board, mail,
 * calendar, chat and contacts — driving the REAL product surfaces as the personas so activity
 * panels, file history and notifications populate for free. Docs and sheets dogfood the shipped
 * .docx/.xlsx importers; slides and stickies are byte-copied fixture containers.
 *
 * A host-level reset script wipes the data root hourly and re-runs this, so every timestamp
 * stays < 1h old. It MUST run against an empty data root (it refuses a completed setup).
 *
 * Required env: EIGEN_DATA_ROOT (absolute). Optional: DOMAIN, MAIL_DOMAIN (persona emails =
 * <local-part>@MAIL_DOMAIN), EIGEN_DEMO_ADMIN_PASSWORD (else a random one is printed).
 *
 * Run locally:
 *   cd apps/api && EIGEN_DATA_ROOT=/abs/data MAIL_DOMAIN=tuimel.example bun run src/scripts/seed-demo.ts
 * Run on the demo box (throwaway container, WORKDIR /app/apps/api, compose env applies):
 *   docker compose run --rm --no-deps eigen-api bun run /app/apps/api/src/scripts/seed-demo.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { Attendee, EventData } from '@workspace/lib/types/calendar';
import type { CommentCard } from '@workspace/lib/types/comments';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import ExcelJS from 'exceljs';
import * as Y from 'yjs';
import type { User } from '../lib/user';
import {
    ADMIN_AVATAR,
    ADMIN_LOCALPART,
    ADMIN_NAME,
    BUDGET,
    CHATS,
    CONTACTS,
    DOCS,
    EVENTS,
    KANBAN,
    type LeadRole,
    MAILS,
    ORG_NAME,
    PERSONAL_SHARES,
    PERSONAS,
    PHOTOS,
    personaByKey,
    personaByRole,
    SPONSOR_DECK,
    TEAM_FOLDERS,
    TEAM_MOUNT_NAME,
    TEAM_NAME,
} from './demo/content';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SQLITE_MIME = 'application/x-sqlite3';
const FIXTURES_DIR = join(import.meta.dir, 'demo', 'fixtures');
const AVATARS_DIR = join(FIXTURES_DIR, 'avatars');
// Same fallback the card dialog uses when a card has no color (card-dialog.tsx initialColor) —
// every seeded card gets it explicitly so none render uncolored.
const DEFAULT_CARD_COLOR = EIGEN_STICKIES_COLORS[0][1].value;

const DATA_ROOT = process.env['EIGEN_DATA_ROOT'];
if (!DATA_ROOT) {
    console.error('EIGEN_DATA_ROOT is required (absolute path to the data root). Aborting.');
    process.exit(1);
}
process.env['API_URL'] ||= 'http://localhost';

const MAIL_DOMAIN = process.env['MAIL_DOMAIN'] || 'tuimel.example';
const DOMAIN = process.env['DOMAIN'] || MAIL_DOMAIN;
const ADMIN_PASSWORD = process.env['EIGEN_DEMO_ADMIN_PASSWORD'] || randomBytes(12).toString('base64url');
// Throwaway — the demo entry route resets each persona's password on every visit.
const PERSONA_PASSWORD = randomBytes(18).toString('base64url');

const emailFor = (localPart: string) => `${localPart}@${MAIL_DOMAIN}`;
const ADMIN_EMAIL = emailFor(ADMIN_LOCALPART);

if (existsSync(join(DATA_ROOT, 'server', 'config.json'))) {
    console.error(`Setup already completed at ${DATA_ROOT} (server/config.json exists). The reset script wipes first.`);
    process.exit(1);
}
mkdirSync(join(DATA_ROOT, 'server'), { recursive: true });
mkdirSync(join(DATA_ROOT, 'home'), { recursive: true });

function buildRfc822(o: {
    from: string;
    to: string;
    subject: string;
    date: Date;
    text: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
}): Buffer {
    let headers =
        `From: ${o.from}\r\nTo: ${o.to}\r\nSubject: ${o.subject}\r\n` +
        `Date: ${o.date.toUTCString()}\r\nMessage-ID: <${o.messageId}>\r\n`;
    if (o.inReplyTo) headers += `In-Reply-To: <${o.inReplyTo}>\r\n`;
    if (o.references?.length) headers += `References: ${o.references.map((r) => `<${r}>`).join(' ')}\r\n`;
    headers += 'Content-Type: text/plain; charset=utf-8\r\n\r\n';
    return Buffer.from(`${headers}${o.text.replace(/\n/g, '\r\n')}\r\n`, 'utf8');
}

// exceljs's writeBuffer returns a view over a larger ArrayBuffer; copy into a standalone one.
async function workbookBytes(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const view = new Uint8Array(await workbook.xlsx.writeBuffer());
    return Buffer.from(view);
}

// Anchor a card the way the editor's setComment command does: wrap the first occurrence of the
// anchor phrase in a `comment` mark carrying the card id. Mutates the PM JSON in place.
function injectCommentMark(json: JSONContent, anchor: string, cardId: string): boolean {
    if (!json.content) return false;
    for (let i = 0; i < json.content.length; i++) {
        const node = json.content[i];
        if (node.type === 'text' && typeof node.text === 'string') {
            const idx = node.text.indexOf(anchor);
            if (idx === -1) continue;
            const marked: JSONContent = {
                type: 'text',
                text: anchor,
                marks: [...(node.marks ?? []), { type: 'comment', attrs: { cardId } }],
            };
            const parts: JSONContent[] = [];
            if (idx > 0) parts.push({ ...node, text: node.text.slice(0, idx) });
            parts.push(marked);
            if (idx + anchor.length < node.text.length)
                parts.push({ ...node, text: node.text.slice(idx + anchor.length) });
            json.content.splice(i, 1, ...parts);
            return true;
        }
        if (injectCommentMark(node, anchor, cardId)) return true;
    }
    return false;
}

// The comments panel renders from the doc's `comments` Y.Map. Mirrors the FE's writeCardToDoc
// (packages/lib .../use-create-comment-card.ts), which lives in a React hooks module the API
// must not pull into its module graph.
function writeCommentCard(doc: Y.Doc, card: CommentCard): void {
    const y = new Y.Map<unknown>();
    y.set('id', card.id);
    y.set('title', card.title);
    y.set('description', card.description);
    if (card.color) y.set('color', card.color);
    if (card.chatName) y.set('chatName', card.chatName);
    if (card.creator) y.set('creator', card.creator);
    if (card.createdAt !== undefined) y.set('createdAt', card.createdAt);
    doc.getMap<Y.Map<unknown>>('comments').set(card.id, y);
}

function buildBudgetWorkbook(): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget');
    ws.getCell('A1').value = 'Item';
    ws.getCell('B1').value = 'Amount (EUR)';
    let row = 2;
    ws.getCell(`A${row}`).value = 'Income';
    row++;
    const incomeStart = row;
    for (const [label, amount] of BUDGET.income) {
        ws.getCell(`A${row}`).value = label;
        ws.getCell(`B${row}`).value = amount;
        row++;
    }
    const incomeTotalRow = row;
    ws.getCell(`A${row}`).value = 'Total income';
    ws.getCell(`B${row}`).value = { formula: `SUM(B${incomeStart}:B${row - 1})` };
    row += 2;
    ws.getCell(`A${row}`).value = 'Costs';
    row++;
    const costStart = row;
    for (const [label, amount] of BUDGET.costs) {
        ws.getCell(`A${row}`).value = label;
        ws.getCell(`B${row}`).value = amount;
        row++;
    }
    const costTotalRow = row;
    ws.getCell(`A${row}`).value = 'Total costs';
    ws.getCell(`B${row}`).value = { formula: `SUM(B${costStart}:B${row - 1})` };
    row += 1;
    ws.getCell(`A${row}`).value = 'Margin';
    ws.getCell(`B${row}`).value = { formula: `B${incomeTotalRow}-B${costTotalRow}` };
    ws.getColumn(1).width = 22;
    ws.getColumn(2).width = 16;
    return wb;
}

async function main(): Promise<void> {
    const { app } = await import('../app');

    const setupRes = await app.handle(
        new Request('http://localhost/setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                domain: DOMAIN,
                orgName: ORG_NAME,
                storageType: 'local-id',
                adminEmail: ADMIN_EMAIL,
                adminPassword: ADMIN_PASSWORD,
                adminName: ADMIN_NAME,
            }),
        }),
    );
    if (!setupRes.ok) throw new Error(`Setup failed (${setupRes.status}): ${await setupRes.text()}`);

    const { auth } = await import('../lib/auth/auth');
    const { getServerConfig } = await import('../lib/config/server-config');
    const { updateServerSettings } = await import('../lib/config/server-settings');
    const { getHome, getTeamHome, shutdownAllHomes } = await import('../lib/home');
    const { getUserByEmail } = await import('../lib/user');
    const { getContacts } = await import('../lib/contacts/contacts');
    const { drainACLFanOuts } = await import('../lib/drive/acl-propagation');
    const { convertToDocument } = await import('../lib/import/import-document');
    const { writeEigendocToYjs } = await import('../lib/document/doc');
    const { docSchema } = await import('../lib/import/doc/from-docx');
    const { sendToHome } = await import('../lib/home/home-relay');
    const { default: htmlToDocx } = await import('@turbodocx/html-to-docx');

    // Tiny quotas + no signups; local-id storage came from the setup call. Apply before any home
    // is created — a user home fixes its mount type on first init. No welcome mail: every persona's
    // first mail-store touch would otherwise drop a "Welcome to Tuimel Festival!" system email as
    // message #1 in their inbox, breaking the lived-in-world illusion.
    await updateServerSettings({
        guests: { openSignup: false },
        quotas: { defaultMountMaxSizeMB: 50, maxUploadSizeMB: 5 },
        onboarding: { welcomeMail: { enabled: false } },
    });

    // --- Personas: the user.create hook auto-joins each to the default org as `member`. ---
    for (const persona of PERSONAS) {
        await auth.api.createUser({
            body: { email: emailFor(persona.key), password: PERSONA_PASSWORD, name: persona.name, role: 'user' },
        });
    }
    const userByKey = new Map<string, User>();
    for (const persona of PERSONAS) {
        const user = await getUserByEmail(emailFor(persona.key));
        if (!user) throw new Error(`Persona ${persona.key} not found after creation`);
        userByKey.set(persona.key, user);
    }
    const userForRole = (role: LeadRole): User => userByKey.get(personaByRole(role).key)!;
    const emailForRole = (role: LeadRole): string => emailFor(personaByRole(role).key);

    // --- Avatars: upload each persona's portrait through the real avatar path so it lands in
    // data/server/avatars and sets user.image, exactly like a user-uploaded avatar. Resilient:
    // a missing/unreadable fixture is logged and skipped, never fatal. ---
    const seedAvatar = async (user: User, fixtureFile: string): Promise<void> => {
        const filePath = join(AVATARS_DIR, fixtureFile);
        if (!existsSync(filePath)) {
            console.warn(`avatar fixture missing, skipping: ${fixtureFile}`);
            return;
        }
        const contacts = await getContacts(user);
        const me = await contacts.getMe();
        if (!me) return;
        const uploadedPath = await contacts.uploadAvatar(
            new File([readFileSync(filePath)], fixtureFile, { type: 'image/jpeg' }),
        );
        const { id, ...fields } = me;
        // Self-update threads through pushUserProfile: writes server/avatars/<id>.webp + user.image.
        await contacts.updateContact(id, { ...fields, avatar: uploadedPath });
    };
    for (const persona of PERSONAS) {
        try {
            await seedAvatar(userByKey.get(persona.key)!, persona.avatar);
        } catch (err) {
            console.warn(`avatar seed failed for ${persona.key}:`, err instanceof Error ? err.message : err);
        }
    }
    const adminUser = await getUserByEmail(ADMIN_EMAIL);
    if (adminUser) {
        try {
            await seedAvatar(adminUser, ADMIN_AVATAR);
        } catch (err) {
            console.warn('avatar seed failed for admin:', err instanceof Error ? err.message : err);
        }
    }

    const orgId = getServerConfig()?.orgId;
    if (!orgId) throw new Error('orgId missing after setup');

    // Admin session — addTeamMember requires request headers with a valid session.
    const signIn = await auth.api.signInEmail({
        returnHeaders: true,
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    // An https API_URL (or NODE_ENV=production) makes better-auth __Secure--prefix its cookie
    // names — keep the full name=value pair so the session lookup finds it.
    const setCookie = signIn.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(/(?:__Secure-|__Host-)?better-auth\.session_token=[^;,]+/);
    if (!cookieMatch) throw new Error('Could not obtain an admin session token');
    const adminHeaders = new Headers({ cookie: cookieMatch[0] });

    // --- Team + membership (the whole crew shares one workspace). ---
    const team = await auth.api.createTeam({ body: { name: TEAM_NAME, organizationId: orgId } });
    const teamId = team.id;
    for (const persona of PERSONAS) {
        await auth.api.addTeamMember({
            body: { teamId, userId: userByKey.get(persona.key)!.id, organizationId: orgId },
            headers: adminHeaders,
        });
    }

    // --- Team home: enable the calendar (starts disabled) and add the shared mount. ---
    const teamHome = await getTeamHome(`team_${teamId}`);
    await teamHome.settings.set({ calendar: { enabled: true } });
    const mount = await teamHome.addMount({ name: TEAM_MOUNT_NAME });
    const teamMountId = mount.id;
    const teamDrive = teamHome.drive;
    const teamRoot = await teamDrive.getRootFolder(teamMountId);
    if (!teamRoot) throw new Error('Team mount root not found');

    // Folder tree (lowercase; chat channels live under chats/). Production lead sets it up.
    const folderId = new Map<string, string>();
    for (const name of TEAM_FOLDERS) {
        const folder = await teamDrive.createFolder(teamMountId, teamRoot.id, name, userForRole('production'));
        folderId.set(name, folder.id);
    }

    const postTo = async (chatId: string, author: User, text: string): Promise<void> => {
        const room = await teamDrive.getChat(teamMountId, chatId);
        await room.postMessage(author, text);
    };

    // --- Site photos: committed .webp fixtures uploaded into images/ through the real drive path. ---
    const imagesFolderId = folderId.get('images')!;
    for (const photo of PHOTOS) {
        const bytes = readFileSync(join(FIXTURES_DIR, 'images', photo.file));
        await teamDrive.createFileFromData(
            teamMountId,
            imagesFolderId,
            photo.file,
            'image/webp',
            bytes,
            userByKey.get(photo.uploader)!,
        );
    }

    // --- Docs: HTML -> .docx -> shipped converter -> eigendoc; comment threads as nested chats. ---
    for (const doc of DOCS) {
        const author = userForRole(doc.author);
        const parentId = folderId.get(doc.folder)!;
        const docxBytes = Buffer.from(await htmlToDocx(doc.html));
        const upload = await teamDrive.createFileFromData(
            teamMountId,
            parentId,
            `${doc.name}.docx`,
            DOCX_MIME,
            docxBytes,
            author,
        );
        const { mount: docMount, path: docSource } = await teamDrive.resolveFile(teamMountId, upload.id);
        const docPath = await convertToDocument(teamDrive, docMount, docSource, 'eigendoc', author);
        await teamDrive.deletePath(teamMountId, upload.id, author); // trash the raw upload

        // Comment threads are chats inside the container's chat/ subfolder (see assertCommentChatExists).
        const chatFolder = await teamDrive.getChildByName(teamMountId, docPath.id, 'chat');
        if (!chatFolder) throw new Error(`chat/ subfolder missing for ${docPath.name}`);
        const collab = await teamDrive.getCollabDocument(teamMountId, docPath.id);
        const docJson = yXmlFragmentToProsemirrorJSON(collab.doc.getXmlFragment('default')) as JSONContent;
        const cards: { spec: (typeof doc.comments)[number]; card: CommentCard }[] = [];
        for (const comment of doc.comments) {
            const commentAuthor = userByKey.get(comment.author)!;
            const chat = await teamDrive.create(teamMountId, chatFolder.id, comment.card, 'chat', commentAuthor);
            await postTo(chat.id, commentAuthor, comment.text);
            for (const reply of comment.replies ?? []) {
                await postTo(chat.id, userByKey.get(reply.author)!, reply.text);
            }
            // Title = anchored text, matching the editor's create flow.
            const card: CommentCard = {
                id: randomUUID(),
                title: comment.anchor.slice(0, 100),
                description: '',
                color: DEFAULT_CARD_COLOR,
                chatName: chat.name,
                creator: commentAuthor.email,
                createdAt: Date.now(),
            };
            if (!injectCommentMark(docJson, comment.anchor, card.id)) {
                throw new Error(`Anchor "${comment.anchor}" not found in "${doc.name}"`);
            }
            cards.push({ spec: comment, card });
        }
        // One fragment rebuild with the anchored marks; cards land in the comments Y.Map the
        // panel renders from. Both persist through the live collab doc.
        writeEigendocToYjs(collab.doc, docJson, docSchema);
        collab.doc.transact(() => {
            for (const { card } of cards) writeCommentCard(collab.doc, card);
        });
        for (const { spec, card } of cards) {
            if (!spec.assignTo) continue;
            const commentAuthor = userByKey.get(spec.author)!;
            const assignee = userForRole(spec.assignTo);
            await teamDrive.assignComment(
                teamMountId,
                docPath.id,
                card.chatName!,
                assignee.email,
                commentAuthor,
                card.title,
            );
            // The bell notification is the assign ROUTE's job (routes/collab.ts), not Drive's — mirror it.
            await sendToHome(assignee.id, {
                type: 'notification',
                notification: {
                    type: 'assigned',
                    actorEmail: commentAuthor.email,
                    title: `${commentAuthor.name} assigned you a comment on "${stripEigenExtension(docPath.name)}"`,
                    tag: `assigned:team_${teamId}:${teamMountId}:${docPath.id}:${card.chatName}`,
                    details: { pathType: docPath.type },
                },
            });
        }
        await teamDrive.flushContainerDb(teamMountId, docPath.id);
    }

    // --- Budget sheet: .xlsx -> shipped converter -> eigensheets. ---
    {
        const author = userForRole(BUDGET.author);
        const parentId = folderId.get(BUDGET.folder)!;
        const xlsxBytes = await workbookBytes(buildBudgetWorkbook());
        const upload = await teamDrive.createFileFromData(
            teamMountId,
            parentId,
            `${BUDGET.name}.xlsx`,
            XLSX_MIME,
            xlsxBytes,
            author,
        );
        const { mount: sheetMount, path: sheetSource } = await teamDrive.resolveFile(teamMountId, upload.id);
        await convertToDocument(teamDrive, sheetMount, sheetSource, 'eigensheets', author);
        await teamDrive.deletePath(teamMountId, upload.id, author);
    }

    // --- Slides + stickies: byte-copy the committed fixture containers, then domainise creators. ---
    const placeFixture = async (
        driveName: string,
        type: 'slides' | 'stickies',
        fixtureDir: string,
        actor: User,
    ): Promise<string> => {
        const parentIdForType = type === 'slides' ? folderId.get(SPONSOR_DECK.folder)! : folderId.get(KANBAN.folder)!;
        const container = await teamDrive.createFolder(teamMountId, parentIdForType, driveName, actor, type);
        for (const dbName of ['data.db', 'comments.db']) {
            const bytes = readFileSync(join(FIXTURES_DIR, fixtureDir, dbName));
            await teamDrive.createFileFromData(teamMountId, container.id, dbName, SQLITE_MIME, bytes, actor);
        }
        await teamDrive.createFolder(teamMountId, container.id, 'media', actor);
        await teamDrive.createFolder(teamMountId, container.id, 'chat', actor);
        return container.id;
    };

    await placeFixture(
        `${SPONSOR_DECK.name}.eigenslides`,
        'slides',
        'sponsor-pitch.eigenslides',
        userForRole(SPONSOR_DECK.author),
    );

    const boardId = await placeFixture(
        `${KANBAN.name}.eigenstickies`,
        'stickies',
        'festival-kanban.eigenstickies',
        userForRole('production'),
    );
    const board = await teamDrive.getCollabDocument(teamMountId, boardId);

    // Card chat threads: same pattern as doc comments — a real chat inside the container's chat/
    // subfolder, seeded by the card's creator persona and linked back onto the card by name.
    const boardChatFolder = await teamDrive.getChildByName(teamMountId, boardId, 'chat');
    if (!boardChatFolder) throw new Error(`chat/ subfolder missing for ${KANBAN.name}`);
    const cardChatNames = new Map<string, string>();
    for (const [i, card] of KANBAN.cards.entries()) {
        const cardAuthor = userByKey.get(card.creator)!;
        const chat = await teamDrive.create(teamMountId, boardChatFolder.id, card.chat, 'chat', cardAuthor);
        await postTo(chat.id, cardAuthor, card.chatText);
        for (const reply of card.chatReplies ?? []) {
            await postTo(chat.id, userByKey.get(reply.author)!, reply.text);
        }
        cardChatNames.set(`card-${i + 1}`, chat.name);
    }

    // The fixture bakes card/column creators as bare persona keys; rewrite them to runtime emails
    // so the board resolves author names under any MAIL_DOMAIN. Every card also gets the shared
    // default card color and its chat link.
    board.doc.transact(() => {
        for (const rootName of ['tasks', 'columns']) {
            for (const [, value] of board.doc.getMap(rootName)) {
                const entry = value as Y.Map<unknown>;
                const creator = entry.get('creator');
                if (typeof creator === 'string' && !creator.includes('@')) entry.set('creator', emailFor(creator));
            }
        }
        for (const [cardId, chatName] of cardChatNames) {
            const task = board.doc.getMap<Y.Map<unknown>>('tasks').get(cardId)!;
            task.set('color', DEFAULT_CARD_COLOR);
            task.set('chatName', chatName);
        }
    });
    await teamDrive.flushContainerDb(teamMountId, boardId);

    // --- Chat channels in chats/ (alternating personas; #production carries the weather worry). ---
    for (const channel of CHATS) {
        const first = userByKey.get(channel.messages[0].author)!;
        const chat = await teamDrive.create(teamMountId, folderId.get('chats')!, channel.name, 'chat', first);
        const room = await teamDrive.getChat(teamMountId, chat.id);
        for (const line of channel.messages) {
            await room.postMessage(userByKey.get(line.author)!, line.text);
        }
    }

    // --- Calendar: team events (createByUserId, no invite fan-out — the team calendar is shared). ---
    const defaultCalendar = teamHome.calendar.getCalendars().find((c) => c.isDefault);
    if (!defaultCalendar) throw new Error('Team default calendar missing');
    const now = new Date();
    const resolvePersona = (ref: string) =>
        PERSONAS.some((p) => p.role === ref) ? personaByRole(ref as LeadRole) : personaByKey(ref);
    for (const event of EVENTS) {
        const start = new Date(now);
        start.setDate(start.getDate() + event.inDays);
        start.setHours(event.startHour, 0, 0, 0);
        const end = new Date(start);
        if (event.allDay) end.setDate(end.getDate() + 2);
        else end.setHours(end.getHours() + event.durationHours);
        const organizer = userForRole(event.organizer);
        const attendees: Attendee[] = event.attendees.map((ref) => {
            const persona = resolvePersona(ref);
            return { email: emailFor(persona.key), name: persona.name, status: 'accepted', role: 'required' };
        });
        const data: EventData = {
            attendees,
            organizer: { userId: organizer.id, email: organizer.email, name: organizer.name },
        };
        teamHome.calendar.createEvent(defaultCalendar.id, {
            title: event.title,
            startTime: start,
            endTime: end,
            allDay: !!event.allDay,
            description: event.description ?? null,
            location: event.location ?? null,
            rrule: event.rrule ?? null,
            data,
            createByUserId: organizer.id,
        });
    }

    // --- Mail: raw RFC822 delivered into persona inboxes (indexed into mail.db on delivery). ---
    for (const flow of MAILS) {
        if (flow.kind === 'inbox-thread') {
            const recipient = userByKey.get(resolvePersona(flow.to!).key)!;
            const recipientHome = await getHome(recipient.id);
            // The thread's external party (booker) — the other end of every message.
            const externalParty = flow.messages.find((m) => m.fromExternal)?.fromExternal;
            const references: string[] = [];
            let previousId: string | undefined;
            for (const message of flow.messages) {
                const external = message.fromExternal;
                const sender = external ? undefined : userByKey.get(message.from!)!;
                const from = external ? `${external.name} <${external.email}>` : `${sender!.name} <${sender!.email}>`;
                const to = external
                    ? recipient.email
                    : externalParty
                      ? `${externalParty.name} <${externalParty.email}>`
                      : recipient.email;
                const date = new Date(now.getTime() - message.daysAgo * 86_400_000);
                date.setHours(message.hour, 0, 0, 0);
                const messageId = `${randomUUID()}@${MAIL_DOMAIN}`;
                const buffer = buildRfc822({
                    from,
                    to,
                    subject: previousId ? `Re: ${flow.subject}` : flow.subject,
                    date,
                    text: message.text,
                    messageId,
                    inReplyTo: previousId,
                    references: references.length ? references : undefined,
                });
                await recipientHome.mail.mailboxDeliver(buffer);
                references.push(messageId);
                previousId = messageId;
            }
        } else {
            const sender = userForRole(flow.from!);
            const message = flow.messages[0];
            const date = new Date(now.getTime() - message.daysAgo * 86_400_000);
            date.setHours(message.hour, 0, 0, 0);
            const from = `${sender.name} <${sender.email}>`;
            const to = `${TEAM_NAME} <crew@${MAIL_DOMAIN}>`;
            for (const persona of PERSONAS) {
                const home = await getHome(userByKey.get(persona.key)!.id);
                const buffer = buildRfc822({
                    from,
                    to,
                    subject: flow.subject,
                    date,
                    text: message.text,
                    messageId: `${randomUUID()}@${MAIL_DOMAIN}`,
                });
                await home.mail.mailboxDeliver(buffer);
            }
        }
    }

    // --- Contacts: the external ecosystem in a few leads' address books. ---
    for (const contact of CONTACTS) {
        const owner = userForRole(contact.owner);
        const contacts = await getContacts(owner);
        await contacts.addContact({
            eigenId: '',
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: [contact.email],
            phone: contact.phone ? [contact.phone] : [],
            company: contact.company ?? '',
            jobTitle: contact.jobTitle ?? '',
            address: [],
            birthday: '',
            notes: contact.notes ?? '',
            avatar: '',
            labels: [],
        });
    }

    // --- Personal-drive files shared person-to-person (shared-with-me variety). ---
    for (const share of PERSONAL_SHARES) {
        const owner = userForRole(share.owner);
        const ownerHome = await getHome(owner.id);
        const ownerRoot = await ownerHome.drive.getRootFolder('default');
        if (!ownerRoot) throw new Error(`Root missing for ${owner.email}`);
        const file = await ownerHome.drive.createFileFromData(
            'default',
            ownerRoot.id,
            share.name,
            'text/plain',
            Buffer.from(share.body, 'utf8'),
            owner,
        );
        await ownerHome.drive.updateACLDelta(
            'default',
            file.id,
            { add: [{ id: emailForRole(share.shareWith), read: true, write: false }] },
            undefined,
            undefined,
            owner,
        );
    }

    // Clean exit: drain fire-and-forget fan-outs, checkpoint + close every home, then exit.
    await drainACLFanOuts();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await drainACLFanOuts();
    await shutdownAllHomes();

    console.log(`Seeded "Tuimel Festival" for ${PERSONAS.length} personas at ${DATA_ROOT}`);
    console.log(`  org:   ${ORG_NAME}  team: ${TEAM_NAME}`);
    console.log(`  admin: ${ADMIN_EMAIL}  password: ${ADMIN_PASSWORD}`);
    process.exit(0);
}

main().catch((error) => {
    console.error('seed-demo failed:', error);
    process.exit(1);
});
