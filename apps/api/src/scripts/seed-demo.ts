// seed-demo.ts — builds the "Tuimel Festival" demo world for an EIGEN_DEMO instance.
//
// Offline, in-process seeder. Boots the API in the same process (as the test harness does),
// runs first-run setup, creates a ~20-persona crew in one org + team, and fills a lived-in
// workspace — team drive, docs, a budget sheet, a slides deck, a stickies board and a site-plan
// drawing, mail, calendar, chat and contacts — driving the REAL product surfaces as the personas so
// activity panels, file history and notifications populate for free. Docs and sheets dogfood the
// shipped .docx/.xlsx importers; slides and stickies are byte-copied fixture containers; the site
// plan is built into its Y.Doc from a typed spec (demo/vector-build.ts).
//
// A host-level reset script wipes the data root hourly and re-runs this, so every timestamp
// stays < 1h old. It MUST run against an empty data root (it refuses a completed setup).
//
// Required env: EIGEN_DATA_ROOT (absolute). Optional: DOMAIN, MAIL_DOMAIN (persona emails =
// <local-part>@MAIL_DOMAIN), EIGEN_DEMO_ADMIN_PASSWORD (else a random one is printed).
//
// Run locally:
//   cd apps/api && EIGEN_DATA_ROOT=/abs/data MAIL_DOMAIN=tuimel.example bun run src/scripts/seed-demo.ts
// Run on the demo box (throwaway container, WORKDIR /app/apps/api, compose env applies):
//   docker compose run --rm --no-deps eigen-api bun run /app/apps/api/src/scripts/seed-demo.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { Attendee, EventData } from '@workspace/lib/types/calendar';
import type { CommentCard } from '@workspace/lib/types/comments';
import { DRIVE_MIME_FOLDER, DRIVE_TYPE_FOLDER, stripEigenExtension } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import MailComposer from 'nodemailer/lib/mail-composer';
import * as Y from 'yjs';
import type { User } from '../lib/user';
import {
    ADMIN_AVATAR,
    ADMIN_LOCALPART,
    ADMIN_NAME,
    BRANDING,
    BUDGET,
    CHATS,
    CONTACTS,
    DOCS,
    EVENTS,
    KANBAN,
    type LeadRole,
    MAILS,
    NOTES,
    ORG_NAME,
    PERSONAL_SHARES,
    PERSONAS,
    PHOTOS,
    personaByKey,
    personaByRole,
    SITE_PLAN,
    SPONSOR_DECK,
    TEAM_FOLDERS,
    TEAM_MOUNT_NAME,
    TEAM_NAME,
} from './demo/content';
import { buildVectorDoc } from './demo/vector-build';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SQLITE_MIME = 'application/x-sqlite3';
const FIXTURES_DIR = join(import.meta.dir, 'demo', 'fixtures');
const AVATARS_DIR = join(FIXTURES_DIR, 'avatars');
// Same fallback the card dialog uses when a card has no color (card-dialog.tsx initialColor) —
// every seeded card gets it explicitly so none render uncolored.
const DEFAULT_CARD_COLOR = EIGEN_STICKIES_COLORS[0][1].value;

const DATA_ROOT = process.env['EIGEN_DATA_ROOT'] ?? '';
if (!DATA_ROOT) {
    console.error('EIGEN_DATA_ROOT is required (absolute path to the data root). Aborting.');
    process.exit(1);
}
process.env['API_URL'] ||= 'http://localhost';

const MAIL_DOMAIN = process.env['MAIL_DOMAIN'] || 'tuimel.example';
const DOMAIN = process.env['DOMAIN'] || MAIL_DOMAIN;

// Drive-reference pills in seeded mail ("Open festival →") are built server-side by mail-template's
// appUrl(), which reads the frontend per-app URL vars (VITE_APP_*_URL). The live API gets them from
// `.env.production` via its CMD's --env-file, but the offline seeder runs through `compose run …
// seed-demo.ts`, which replaces that CMD — so without setting them here the links fall back to dev
// localhost URLs and get baked into the stored mail. Point them at the deploy host (same-origin under
// each app name), which is exactly what the live API resolves for a real user's outbound mail.
const WEB_ORIGIN = DOMAIN === 'localhost' ? 'http://localhost' : `https://${DOMAIN}`;
for (const [name, path] of [
    ['VITE_APP_DRIVE_URL', '/drive'],
    ['VITE_APP_DOCS_URL', '/docs'],
    ['VITE_APP_SLIDES_URL', '/slides'],
    ['VITE_APP_SHEETS_URL', '/sheets'],
    ['VITE_APP_STICKIES_URL', '/stickies'],
    ['VITE_APP_CHAT_URL', '/chat'],
] as const) {
    process.env[name] ||= `${WEB_ORIGIN}${path}`;
}
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

// Same MIME engine the real app uses for outbound mail (composeRfc822 in lib/core/mailer.ts) —
// used directly rather than through composeRfc822/OutboundMail so the thread-linking headers
// (Message-ID/In-Reply-To/References) stay under our control. HTML is optional: when given, this
// produces a real multipart/alternative message so the mail client renders lists/paragraphs
// properly instead of the plain-text-only fallback.
async function buildRfc822(o: {
    from: string;
    to: string;
    subject: string;
    date: Date;
    text: string;
    html?: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
}): Promise<Buffer> {
    return new MailComposer({
        from: o.from,
        to: o.to,
        subject: o.subject,
        date: o.date,
        text: o.text,
        html: o.html,
        messageId: `<${o.messageId}>`,
        inReplyTo: o.inReplyTo ? `<${o.inReplyTo}>` : undefined,
        references: o.references?.length ? o.references.map((r) => `<${r}>`) : undefined,
    })
        .compile()
        .build();
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
    getItemMapRoot(doc, 'comments').set(card.id, y);
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
    const { pushTeamAvatar, sendToHome } = await import('../lib/home/home-relay');
    const { generateImagePreview } = await import('../lib/shared/thumbnails');
    const { renderAttachmentPills } = await import('../lib/core/mail-template');
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

    // --- Team avatar: the festival logo through the same pipeline as the avatar route
    // (512px cover webp). Resilient like the persona avatars: logged, never fatal. ---
    try {
        const logoBytes = readFileSync(join(FIXTURES_DIR, 'branding', 'logo.webp'));
        const result = await generateImagePreview(logoBytes, 'image/webp', 'logo.webp', '', 'avatar', {
            maxSize: 512,
            quality: 80,
            fit: 'cover',
        });
        if (!result) throw new Error('avatar thumbnail generation failed');
        await pushTeamAvatar(teamId, result.data);
    } catch (err) {
        console.warn('team avatar seed failed:', err instanceof Error ? err.message : err);
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

    // --- Branding assets: committed fixtures uploaded into branding/ (see fixtures/branding/). ---
    const brandingFolderId = folderId.get('branding')!;
    for (const asset of BRANDING) {
        const bytes = readFileSync(join(FIXTURES_DIR, 'branding', asset.file));
        await teamDrive.createFileFromData(
            teamMountId,
            brandingFolderId,
            asset.file,
            asset.mimeType,
            bytes,
            userByKey.get(asset.uploader)!,
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

    // --- Volunteer roster: a doc in volunteers/ listing every crew member with a link to their team
    // contact card. Built here (not in content.ts) so the links carry the runtime team id + emails.
    // The team id is shared by every persona, so one URL works for every visitor. Links are
    // root-relative (no host) so they resolve against whatever domain the demo is served on. ---
    {
        const author = userForRole('volunteers');
        const rosterItems = PERSONAS.map((p) => {
            const url = `/contacts/team/${teamId}?contactId=${encodeURIComponent(emailFor(p.key))}`;
            return `<li><a href="${url}">${p.name}</a> - ${p.title}</li>`;
        }).join('');
        const rosterHtml = [
            '<h1>Crew roster</h1>',
            '<p>Everyone helping to run the festival this edition. Click a name to open their contact card.</p>',
            `<ul>${rosterItems}</ul>`,
        ].join('');
        const docxBytes = Buffer.from(await htmlToDocx(rosterHtml));
        const upload = await teamDrive.createFileFromData(
            teamMountId,
            folderId.get('volunteers')!,
            'crew roster.docx',
            DOCX_MIME,
            docxBytes,
            author,
        );
        const { mount: docMount, path: docSource } = await teamDrive.resolveFile(teamMountId, upload.id);
        const docPath = await convertToDocument(teamDrive, docMount, docSource, 'eigendoc', author);
        await teamDrive.deletePath(teamMountId, upload.id, author); // trash the raw upload
        await teamDrive.flushContainerDb(teamMountId, docPath.id);
    }

    // --- Slides / sheets / stickies: byte-copy the committed fixture containers. The slides deck and
    // budget sheet are hand-maintained (edited in a live demo, copied back — see fixtures/), so their
    // data.db carries the real content; the stickies board's creators/colors are patched below. ---
    const placeFixture = async (
        parentId: string,
        driveName: string,
        type: 'slides' | 'sheets' | 'stickies',
        fixtureDir: string,
        actor: User,
    ): Promise<string> => {
        const container = await teamDrive.createFolder(teamMountId, parentId, driveName, actor, type);
        for (const dbName of ['data.db', 'comments.db']) {
            const bytes = readFileSync(join(FIXTURES_DIR, fixtureDir, dbName));
            await teamDrive.createFileFromData(teamMountId, container.id, dbName, SQLITE_MIME, bytes, actor);
        }
        // Embedded media (e.g. an image dropped into the deck) lives under the fixture's media/ folder
        // and is referenced by name from data.db — copy it so the byte-copied doc stays whole.
        const mediaFolder = await teamDrive.createFolder(teamMountId, container.id, 'media', actor);
        const mediaDir = join(FIXTURES_DIR, fixtureDir, 'media');
        if (existsSync(mediaDir)) {
            for (const file of readdirSync(mediaDir)) {
                const path = join(mediaDir, file);
                const bytes = readFileSync(path);
                await teamDrive.createFileFromData(
                    teamMountId,
                    mediaFolder.id,
                    file,
                    Bun.file(path).type,
                    bytes,
                    actor,
                );
            }
        }
        await teamDrive.createFolder(teamMountId, container.id, 'chat', actor);
        return container.id;
    };

    await placeFixture(
        folderId.get(SPONSOR_DECK.folder)!,
        `${SPONSOR_DECK.name}.eigenslides`,
        'slides',
        'sponsor-pitch.eigenslides',
        userForRole(SPONSOR_DECK.author),
    );

    await placeFixture(
        folderId.get(BUDGET.folder)!,
        `${BUDGET.name}.eigensheets`,
        'sheets',
        'festival-budget.eigensheets',
        userForRole(BUDGET.author),
    );

    const boardId = await placeFixture(
        folderId.get(KANBAN.folder)!,
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
            for (const [, entry] of getItemMapRoot(board.doc, rootName)) {
                const creator = entry.get('creator');
                if (typeof creator === 'string' && !creator.includes('@')) entry.set('creator', emailFor(creator));
            }
        }
        const tasksMap = getItemMapRoot(board.doc, 'tasks');
        for (const [cardId, chatName] of cardChatNames) {
            const task = tasksMap.get(cardId)!;
            task.set('color', DEFAULT_CARD_COLOR);
            task.set('chatName', chatName);
        }
    });
    await teamDrive.flushContainerDb(teamMountId, boardId);

    // --- Site plan: a vector drawing built straight into the container's Y.Doc from the SITE_PLAN
    // spec (no fixture bytes; see demo/vector-build.ts). The two referenced images are uploaded into
    // the container's media/ subfolder (CollabDocument.create makes it) so the drawing stays whole. ---
    {
        const author = userForRole(SITE_PLAN.author);
        const container = await teamDrive.create(
            teamMountId,
            folderId.get(SITE_PLAN.folder)!,
            SITE_PLAN.name,
            'vector',
            author,
        );
        const mediaFolder = await teamDrive.getChildByName(teamMountId, container.id, 'media');
        if (!mediaFolder) throw new Error(`media/ subfolder missing for ${container.name}`);
        for (const image of SITE_PLAN.images) {
            const path = join(FIXTURES_DIR, image.file);
            const bytes = readFileSync(path);
            await teamDrive.createFileFromData(
                teamMountId,
                mediaFolder.id,
                basename(path),
                Bun.file(path).type,
                bytes,
                author,
            );
        }
        const collab = await teamDrive.getCollabDocument(teamMountId, container.id);
        buildVectorDoc(collab.doc, SITE_PLAN);
        await teamDrive.flushContainerDb(teamMountId, container.id);
    }

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
    // Anchor the festival on a weekend: the first Saturday at least ~3 weeks out (so it lands 20-26
    // days ahead). Every event is placed relative to this Saturday, so the festival is always Sat/Sun
    // and the go/no-go the Friday before, whatever weekday the hourly reseed happens to run on.
    const festivalSaturday = new Date(now);
    festivalSaturday.setDate(festivalSaturday.getDate() + 20);
    while (festivalSaturday.getDay() !== 6) festivalSaturday.setDate(festivalSaturday.getDate() + 1);
    festivalSaturday.setHours(0, 0, 0, 0);
    const resolvePersona = (ref: string) =>
        PERSONAS.some((p) => p.role === ref) ? personaByRole(ref as LeadRole) : personaByKey(ref);
    for (const event of EVENTS) {
        // Resolve the event's calendar date by walking from the festival Saturday.
        const day = new Date(festivalSaturday);
        day.setDate(day.getDate() + event.daysFromFestival);
        let start: Date;
        let end: Date;
        if (event.allDay) {
            // All-day events are stored as UTC midnight with an exclusive end — the calendar buckets
            // all-day events by their UTC date, so local midnight would shift the festival a day early
            // in a UTC+ timezone. Matches the create-event dialog and CalDAV import.
            start = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
            end = new Date(start);
            end.setUTCDate(end.getUTCDate() + 2); // spans the festival Saturday + Sunday
        } else {
            start = new Date(day);
            start.setHours(event.startHour, 0, 0, 0);
            end = new Date(start);
            end.setHours(end.getHours() + event.durationHours);
        }
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
    // A drive-reference to the shared team drive root, for all-hands mails that link the workspace.
    const teamDriveRef: AttachmentReference = {
        type: 'reference',
        ownerId: `team_${teamId}`,
        mountId: teamMountId,
        id: teamRoot.id,
        name: TEAM_MOUNT_NAME,
        driveType: DRIVE_TYPE_FOLDER,
        mimeType: DRIVE_MIME_FOLDER,
    };
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
                const buffer = await buildRfc822({
                    from,
                    to,
                    subject: previousId ? `Re: ${flow.subject}` : flow.subject,
                    date,
                    text: message.text,
                    html: message.html,
                    messageId,
                    inReplyTo: previousId,
                    references: references.length ? references : undefined,
                });
                const deliveredId = await recipientHome.mail.mailboxDeliver(buffer);
                // The persona's own replies in the thread belong in their Sent box, not their inbox
                // (the other end is the external party). Moving them keeps only genuinely inbound mail
                // in the inbox; mark read since you sent it.
                if (!external) {
                    await recipientHome.mail.messageMove(deliveredId, 'Sent');
                    await recipientHome.mail.messageSetRead(deliveredId, true);
                }
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
            // Seeded bodies are HTML fragments (no <body>), so the pill just appends — the same
            // outcome as the mail client's appendReferenceLinks fallback for a sent message.
            const html =
                flow.attachTeamDrive && message.html
                    ? message.html + renderAttachmentPills([teamDriveRef])
                    : message.html;
            for (const persona of PERSONAS) {
                const home = await getHome(userByKey.get(persona.key)!.id);
                const buffer = await buildRfc822({
                    from,
                    to,
                    subject: flow.subject,
                    date,
                    text: message.text,
                    html,
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

    // --- Personal notes: a private "my notes" eigendoc in every persona's own drive (same cozy
    // content for all). Dogfoods the .docx importer like the team docs; the docx is built once and
    // converted per persona into their own home drive. ---
    const notesDocx = Buffer.from(await htmlToDocx(NOTES.html));
    for (const persona of PERSONAS) {
        const owner = userByKey.get(persona.key)!;
        const ownerHome = await getHome(owner.id);
        const ownerRoot = await ownerHome.drive.getRootFolder('default');
        if (!ownerRoot) throw new Error(`Root missing for ${owner.email}`);
        const upload = await ownerHome.drive.createFileFromData(
            'default',
            ownerRoot.id,
            `${NOTES.name}.docx`,
            DOCX_MIME,
            notesDocx,
            owner,
        );
        const { mount: notesMount, path: notesSource } = await ownerHome.drive.resolveFile('default', upload.id);
        await convertToDocument(ownerHome.drive, notesMount, notesSource, 'eigendoc', owner);
        await ownerHome.drive.deletePath('default', upload.id, owner); // trash the raw upload
    }

    // Clean exit: drain fire-and-forget fan-outs, checkpoint + close every home, then exit.
    await drainACLFanOuts();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await drainACLFanOuts();
    await shutdownAllHomes();

    console.log(`Seeded "Tuimel Festival" for ${PERSONAS.length} personas at ${DATA_ROOT}`);
    console.log(`  org:   ${ORG_NAME}  team: ${TEAM_NAME}`);
    console.log(`  admin: ${ADMIN_EMAIL}  password: ${ADMIN_PASSWORD}`);

    // The reset script's restart gate — written last so a mid-seed crash leaves no gate and the
    // API stays down rather than restarting onto a half-built world. The wipe clears data/server.
    writeFileSync(join(DATA_ROOT, 'server', '.demo-seeded'), '');
    process.exit(0);
}

main().catch((error) => {
    console.error('seed-demo failed:', error);
    process.exit(1);
});
