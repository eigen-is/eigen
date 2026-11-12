// Builds the "Tuimel Festival" demo world for an EIGEN_DEMO instance: a crew of personas in one org and its team, a
// lived-in team drive with such files as docs, a budget sheet and a stickies board, and their mail, calendars, chats
// and contacts. It boots the API in this process and acts as the personas through the product's own code, so
// activity, file history and notifications fill in. The demo reset wipes the data root and runs it again, and a
// completed setup is refused. It needs EIGEN_DATA_ROOT; MAIL_DOMAIN, DOMAIN and EIGEN_DEMO_ADMIN_PASSWORD may be set.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { VCARD_CONTENT_TYPE } from '@workspace/lib/constants/contact';
import { CONTAINER_CHAT_FOLDER, CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import { MAILBOX_INBOX, MAILBOX_SENT } from '@workspace/lib/constants/mailboxes';
import { XLSX_MIME } from '@workspace/lib/constants/mime';
import { DEFAULT_NORMAL_STYLE, DEFAULT_PAGE_SETUP } from '@workspace/lib/docs/eigendoc';
import { stripTagsServer } from '@workspace/lib/html';
import { formatReplyQuote } from '@workspace/lib/mail/reply-quote';
import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER, DRIVE_TYPE_FOLDER } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { toAttachmentReference } from '@workspace/lib/types/drive-reference';
import { VCARD_MIMES } from '@workspace/lib/types/file-kinds';
import { JSDOM } from 'jsdom';
import MailComposer from 'nodemailer/lib/mail-composer';
import * as Y from 'yjs';
import type { Drive } from '../lib/drive';
import { textToHtml } from '../lib/mail/mail-parser/html';
import { CONTAINER_COMMENTS_DB, CONTAINER_DATA_DB } from '../lib/mount/container-dbs';
import { writeTempWithHash } from '../lib/storage';
import type { User } from '../lib/user';
import type { LeadRole, MailAttachment, SeededInvite, SeededMail, VCardSpec } from './demo/content';
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
    MAILS,
    NOTES,
    ORG_NAME,
    PERSONAL_SHARES,
    PERSONAS,
    PHOTOS,
    personaByKey,
    personaByRole,
    SHIFTS,
    SITE_PLAN,
    SPONSOR_DECK,
    TEAM_FOLDERS,
    TEAM_MOUNT_NAME,
    TEAM_NAME,
    TRYING_EIGEN,
    VCARD_FILES,
} from './demo/content';
import { buildDeckDoc } from './demo/deck-build';
import { buildWorkbook, buildWorkbookDoc } from './demo/sheet-build';
import { buildVectorDoc } from './demo/vector-build';

const SQLITE_MIME = 'application/x-sqlite3';
const FIXTURES_DIR = join(import.meta.dir, 'demo', 'fixtures');
const AVATARS_DIR = join(FIXTURES_DIR, 'avatars');
// The color the card dialog falls back to. Every seeded card gets it explicitly, so none renders uncolored.
const DEFAULT_CARD_COLOR = EIGEN_STICKIES_COLORS[0][1].value;

const DATA_ROOT = process.env['EIGEN_DATA_ROOT'] ?? '';
if (!DATA_ROOT) {
    console.error('EIGEN_DATA_ROOT is required (absolute path to the data root). Aborting.');
    process.exit(1);
}
process.env['API_URL'] ||= 'http://localhost';

// Setup reads both from the env, as it does after ./eigen setup.
const MAIL_DOMAIN = (process.env['MAIL_DOMAIN'] ||= 'tuimel.example');
const DOMAIN = (process.env['DOMAIN'] ||= MAIL_DOMAIN);

// Seeded mail links drive files with pills ("Open festival →"), and appUrl builds their links from the per-app
// VITE_APP_*_URL vars. A `compose run` reads them from `.env.production`. Without them the links would point at
// the dev localhost and be stored that way in the mail. So a missing one points at the deploy host, each app under
// its own path, which is what the live API resolves for a real user's mail.
const WEB_ORIGIN = DOMAIN === 'localhost' ? 'http://localhost' : `https://${DOMAIN}`;
for (const [name, path] of [
    ['VITE_APP_DRIVE_URL', '/drive'],
    ['VITE_APP_DOCS_URL', '/docs'],
    ['VITE_APP_SLIDES_URL', '/slides'],
    ['VITE_APP_SHEETS_URL', '/sheets'],
    ['VITE_APP_VECTOR_URL', '/vector'],
    ['VITE_APP_STICKIES_URL', '/stickies'],
    ['VITE_APP_CHAT_URL', '/chat'],
] as const) {
    process.env[name] ||= `${WEB_ORIGIN}${path}`;
}
const ADMIN_PASSWORD = process.env['EIGEN_DEMO_ADMIN_PASSWORD'] || randomBytes(12).toString('base64url');
// A random one is enough: the demo entry route resets each persona's password on every visit.
const PERSONA_PASSWORD = randomBytes(18).toString('base64url');

const emailFor = (localPart: string) => `${localPart}@${MAIL_DOMAIN}`;
const ADMIN_EMAIL = emailFor(ADMIN_LOCALPART);

if (existsSync(join(DATA_ROOT, 'server', 'config.json'))) {
    console.error(`Setup already completed at ${DATA_ROOT} (server/config.json exists). The reset script wipes first.`);
    process.exit(1);
}
mkdirSync(join(DATA_ROOT, 'server'), { recursive: true });
mkdirSync(join(DATA_ROOT, 'home'), { recursive: true });

// A seeded value by its key, such as a user, a folder or a document. The seed data is ours, so a key it names that
// nothing holds is a bug in it.
function lookup<V>(map: ReadonlyMap<string, V>, key: string): V {
    const value = map.get(key);
    if (value === undefined) throw new Error(`The seed data names '${key}', which nothing holds`);
    return value;
}

// A raw message from the MIME composer that the app's outbound mail uses. It calls the composer directly, not
// through composeRfc822, so the seed sets the threading headers (Message-ID, In-Reply-To, References) itself.
// With html, the message is multipart/alternative, so the mail client renders its lists and paragraphs.
async function buildRfc822(mail: {
    from: string;
    to: string;
    subject: string;
    date: Date;
    text: string;
    html?: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: { filename: string; contentType: string; content: string | Buffer }[];
    icalEvent?: { method: string; content: string };
}): Promise<Buffer> {
    return new MailComposer({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        date: mail.date,
        text: mail.text,
        html: mail.html,
        messageId: `<${mail.messageId}>`,
        inReplyTo: mail.inReplyTo ? `<${mail.inReplyTo}>` : undefined,
        references: mail.references?.length ? mail.references.map((id) => `<${id}>`) : undefined,
        attachments: mail.attachments,
        icalEvent: mail.icalEvent,
    })
        .compile()
        .build();
}

// Anchors a card the way the editor's setComment command does. It wraps the first occurrence of the anchor phrase
// in a `comment` mark that carries the card id, and changes the JSON in place.
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

// The demo docs are written as HTML; the editor's schema parses them into the JSON a doc stores.
function htmlToDocJson(schema: Schema, html: string): JSONContent {
    const { document } = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
    return PmDOMParser.fromSchema(schema).parse(document.body).toJSON();
}

// The comments panel renders from the doc's `comments` Y.Map. Mirrors the FE's writeCardToDoc, which lives in a
// React hooks module the API must not pull into its module graph.
function writeCommentCard(doc: Y.Doc, card: CommentCard): void {
    const entry = new Y.Map<unknown>();
    entry.set('id', card.id);
    entry.set('title', card.title);
    entry.set('description', card.description);
    if (card.color) entry.set('color', card.color);
    if (card.chatName) entry.set('chatName', card.chatName);
    if (card.creator) entry.set('creator', card.creator);
    if (card.createdAt !== undefined) entry.set('createdAt', card.createdAt);
    if (card.attachments) entry.set('attachments', card.attachments);
    getItemMapRoot(doc, 'comments').set(card.id, entry);
}

async function main(): Promise<void> {
    // The app's modules read the env as they load, such as API_URL for auth, so they load only now that it is set.
    const { app } = await import('../app');
    const { createSetupToken } = await import('../lib/setup/setup-token');

    const setupRes = await app.handle(
        new Request('http://localhost/setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                setupToken: createSetupToken(),
                orgName: ORG_NAME,
                storageType: 'local-id',
                adminUsername: ADMIN_LOCALPART,
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
    const { resolveContacts } = await import('../lib/contacts/get-contacts');
    const { commitEigendocImport } = await import('../lib/document/doc');
    const { docSchema } = await import('../lib/document/doc-schema');
    const { drainHomeDeliveries, pushTeamAvatar } = await import('../lib/home/home-relay');
    const { generateImagePreview } = await import('../lib/shared/thumbnails');
    const { renderAttachmentPills } = await import('../lib/mailer/mail-template');
    const { createVCard } = await import('../lib/vcard');
    const { serializeEventForImip } = await import('../lib/ical');
    const { lossCounter } = await import('../lib/document/transform/protocol');
    const { writeXlsx } = await import('../lib/export/sheets/xlsx/to-xlsx');

    // Small quotas and no open signup. The setup call already chose local-id storage. This runs before any home
    // exists, because a user home fixes its mount type on its first init. The welcome mail is off, or it would be
    // the first message in every persona's inbox and spoil the lived-in world.
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
    const userForRole = (role: LeadRole): User => lookup(userByKey, personaByRole(role).key);
    const emailForRole = (role: LeadRole): string => emailFor(personaByRole(role).key);

    // --- Avatars: each persona's portrait goes through the upload a user makes, so it sets user.image the same
    // way. A missing or broken fixture is logged and skipped, never fatal. ---
    const seedAvatar = async (user: User, fixtureFile: string): Promise<void> => {
        const filePath = join(AVATARS_DIR, fixtureFile);
        if (!existsSync(filePath)) {
            console.warn(`avatar fixture missing, skipping: ${fixtureFile}`);
            return;
        }
        const contacts = await resolveContacts(user, user.id);
        const me = await contacts.getMe();
        if (!me) return;
        const uploadedPath = await contacts.uploadAvatar(
            new File([readFileSync(filePath)], fixtureFile, { type: 'image/jpeg' }),
        );
        const { id, ...fields } = me;
        // An update of your own card goes through pushUserProfile, which stores the avatar and sets user.image.
        await contacts.updateContact(id, { ...fields, avatar: uploadedPath });
    };
    for (const persona of PERSONAS) {
        try {
            await seedAvatar(lookup(userByKey, persona.key), persona.avatar);
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

    // updateTeam needs the headers of a signed-in admin.
    const signIn = await auth.api.signInEmail({
        returnHeaders: true,
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    // With an https API_URL or in production, better-auth gives its cookie names a __Secure- prefix. So the
    // whole name=value pair is kept, and the session lookup finds it.
    const setCookie = signIn.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(/(?:__Secure-|__Host-)?better-auth\.session_token=[^;,]+/);
    if (!cookieMatch) throw new Error('Could not obtain an admin session token');
    const adminHeaders = new Headers({ cookie: cookieMatch[0] });

    // --- Team (the whole crew shares one workspace): the default team, which every persona joined
    // with the org, renamed from the org's name to the crew's. ---
    const teamId = getServerConfig()?.defaultTeamId;
    if (!teamId) throw new Error('defaultTeamId missing after setup');
    await auth.api.updateTeam({
        body: { teamId, data: { name: TEAM_NAME, organizationId: orgId } },
        headers: adminHeaders,
    });

    // --- Team avatar: the festival logo, through the same pipeline as the avatar route. A failure is logged and
    // skipped, like a persona's. ---
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

    // The folder tree, made by the production lead. The chat channels go in chats/.
    const folderId = new Map<string, string>();
    for (const name of TEAM_FOLDERS) {
        const folder = await teamDrive.createFolder(teamMountId, teamRoot.id, name, userForRole('production'));
        folderId.set(name, folder.id);
    }

    const postTo = async (
        chatId: string,
        author: User,
        text: string,
        attachments?: ChatAttachment[],
    ): Promise<void> => {
        const room = await teamDrive.getChat(teamMountId, chatId);
        await room.postMessage(author, text, 'message', undefined, undefined, attachments);
    };

    // Seeded team documents by content name, so chat lines can attach them as drive references.
    const teamDocs = new Map<string, DrivePath>();
    const teamDocRef = (name: string): AttachmentReference => toAttachmentReference(lookup(teamDocs, name));

    // --- Site photos: committed .webp fixtures uploaded into images/ through the real drive path. ---
    const imagesFolderId = lookup(folderId, 'images');
    for (const photo of PHOTOS) {
        const bytes = readFileSync(join(FIXTURES_DIR, 'images', photo.file));
        await teamDrive.createFileFromData(
            teamMountId,
            imagesFolderId,
            photo.file,
            'image/webp',
            bytes,
            lookup(userByKey, photo.uploader),
        );
    }

    // --- Branding assets: committed fixtures uploaded into branding/. ---
    const brandingFolderId = lookup(folderId, 'branding');
    for (const asset of BRANDING) {
        const bytes = readFileSync(join(FIXTURES_DIR, 'branding', asset.file));
        await teamDrive.createFileFromData(
            teamMountId,
            brandingFolderId,
            asset.file,
            asset.mimeType,
            bytes,
            lookup(userByKey, asset.uploader),
        );
    }

    // --- Contact cards: each spec goes through the shipped vCard writer and is uploaded as a .vcf like any other
    // file. The uid is deterministic, so a reseed writes the same card. ---
    // Both card writers take this input. The empty defaults write nothing for a field the spec leaves out.
    const contactInput = (spec: VCardSpec): CreateContactInput => ({
        eigenId: '',
        firstName: spec.firstName,
        lastName: spec.lastName,
        email: [spec.email],
        phone: spec.phone ? [spec.phone] : [],
        company: spec.company ?? '',
        jobTitle: spec.jobTitle ?? '',
        address: [],
        birthday: '',
        notes: spec.notes ?? '',
        avatar: '',
        labels: [],
    });
    // The optional portrait is embedded as an inline PHOTO, read from the same avatars/ fixtures the
    // personas use. A missing fixture is logged and skipped, never fatal, like a persona avatar.
    const cardPhoto = (spec: VCardSpec): { bytes: Uint8Array; mediaType: string } | undefined => {
        if (!spec.photo) return undefined;
        const filePath = join(AVATARS_DIR, spec.photo);
        if (!existsSync(filePath)) {
            console.warn(`vcard photo fixture missing, skipping: ${spec.photo}`);
            return undefined;
        }
        return { bytes: readFileSync(filePath), mediaType: 'image/jpeg' };
    };
    const seedVCard = (spec: VCardSpec): string =>
        createVCard({ ...contactInput(spec), photo: cardPhoto(spec) }, `demo-${spec.email}`);
    for (const vcf of VCARD_FILES) {
        await teamDrive.createFileFromData(
            teamMountId,
            lookup(folderId, vcf.folder),
            vcf.name,
            VCARD_MIMES[0],
            Buffer.from(seedVCard(vcf.card), 'utf8'),
            lookup(userByKey, vcf.uploader),
        );
    }

    // A new eigendoc holding the JSON, written as one update to its live collab doc.
    const createDoc = async (
        drive: Drive,
        mountId: string,
        parentId: string,
        name: string,
        json: JSONContent,
        author: User,
    ): Promise<DrivePath> => {
        const docPath = await drive.create(mountId, parentId, name, 'doc', author);
        const collab = await drive.getCollabDocument(mountId, docPath.id);
        const update = prosemirrorJSONToYDoc(docSchema(), json, 'default');
        commitEigendocImport(collab.doc, {
            update: Y.encodeStateAsUpdate(update),
            page: DEFAULT_PAGE_SETUP,
            style: DEFAULT_NORMAL_STYLE,
        });
        update.destroy();
        return docPath;
    };

    // --- Volunteer roster: a doc in volunteers/ that lists the crew, each name linked to its team contact card.
    // It is built here, not in the content, because the links carry the team id and emails of this run. Every
    // persona shares the team, so one link works for every visitor. The links have no host, so they work on
    // whatever domain serves the demo. ---
    {
        const author = userForRole('volunteers');
        const rosterItems = PERSONAS.map((persona) => {
            const url = `/contacts/team/${teamId}?contactId=${encodeURIComponent(emailFor(persona.key))}`;
            return `<li><a href="${url}">${persona.name}</a> - ${persona.title}</li>`;
        }).join('');
        const rosterHtml = [
            '<h1>Crew roster</h1>',
            '<p>Everyone helping to run the festival this edition. Click a name to open their contact card.</p>',
            `<ul>${rosterItems}</ul>`,
        ].join('');
        const docPath = await createDoc(
            teamDrive,
            teamMountId,
            lookup(folderId, 'volunteers'),
            'crew roster',
            htmlToDocJson(docSchema(), rosterHtml),
            author,
        );
        await teamDrive.flushContainerDb(teamMountId, docPath.id);
        teamDocs.set('crew roster', docPath);
    }

    // Fixture files into a container's media/ folder, where a doc's figures and a canvas's images find them by name,
    // so the document stays whole.
    const uploadMedia = async (
        drive: Drive,
        mountId: string,
        container: DrivePath,
        files: string[],
        author: User,
    ): Promise<void> => {
        const mediaFolder = await drive.getChildByName(mountId, container.id, CONTAINER_MEDIA_FOLDER);
        if (!mediaFolder) throw new Error(`media/ subfolder missing for ${container.name}`);
        for (const file of files) {
            const path = join(FIXTURES_DIR, file);
            const bytes = readFileSync(path);
            await drive.createFileFromData(mountId, mediaFolder.id, basename(path), Bun.file(path).type, bytes, author);
        }
    };

    // --- Docs: each HTML spec becomes an eigendoc in one write, with its comment marks anchored first. The comment
    // threads are chats inside the doc. The container comes first: its chat/ subfolder holds the threads the marks
    // point at, and its media/ holds the photos its figures show. ---
    for (const doc of DOCS) {
        const author = userForRole(doc.author);
        const parentId = lookup(folderId, doc.folder);
        const docPath = await teamDrive.create(teamMountId, parentId, doc.name, 'doc', author);
        teamDocs.set(doc.name, docPath);
        await uploadMedia(teamDrive, teamMountId, docPath, doc.media ?? [], author);

        // Comment threads are chats inside the container's chat/ subfolder.
        const chatFolder = await teamDrive.getChildByName(teamMountId, docPath.id, CONTAINER_CHAT_FOLDER);
        if (!chatFolder) throw new Error(`chat/ subfolder missing for ${docPath.name}`);
        const docJson = htmlToDocJson(docSchema(), doc.html);
        const cards: { spec: (typeof doc.comments)[number]; card: CommentCard; chatName: string }[] = [];
        for (const comment of doc.comments) {
            const commentAuthor = lookup(userByKey, comment.author);
            const chat = await teamDrive.create(teamMountId, chatFolder.id, comment.card, 'chat', commentAuthor);
            await postTo(chat.id, commentAuthor, comment.text);
            for (const reply of comment.replies ?? []) {
                await postTo(chat.id, lookup(userByKey, reply.author), reply.text);
            }
            // The title is the anchored text, as the editor makes it.
            const card: CommentCard = {
                id: crypto.randomUUID(),
                title: comment.anchor.slice(0, 100),
                description: '',
                color: DEFAULT_CARD_COLOR,
                chatName: chat.name,
                creator: commentAuthor.email,
                createdAt: Date.now(),
                attachments: comment.attach?.map(teamDocRef),
            };
            if (!injectCommentMark(docJson, comment.anchor, card.id)) {
                throw new Error(`Anchor "${comment.anchor}" not found in "${doc.name}"`);
            }
            cards.push({ spec: comment, card, chatName: chat.name });
        }
        // The doc's one write, with the anchored marks. The cards land in the comments Y.Map the panel renders
        // from. The collab doc opens right before the write, because a document that no socket joins closes a
        // minute after its open, and a write after that close is lost.
        const collab = await teamDrive.getCollabDocument(teamMountId, docPath.id);
        const marked = prosemirrorJSONToYDoc(docSchema(), docJson, 'default');
        commitEigendocImport(collab.doc, {
            update: Y.encodeStateAsUpdate(marked),
            page: DEFAULT_PAGE_SETUP,
            style: DEFAULT_NORMAL_STYLE,
        });
        marked.destroy();
        collab.doc.transact(() => {
            for (const { card } of cards) writeCommentCard(collab.doc, card);
        });
        for (const { spec, card, chatName } of cards) {
            if (!spec.assignTo) continue;
            const commentAuthor = lookup(userByKey, spec.author);
            const assignee = userForRole(spec.assignTo);
            await teamDrive.assignComment(teamMountId, docPath.id, chatName, assignee.email, commentAuthor, card.title);
        }
        await teamDrive.flushContainerDb(teamMountId, docPath.id);
    }

    // --- The containers built straight into their Y.Doc from a typed spec, with no fixture bytes, such as the site
    // plan, the sponsor deck and the budget. The images a spec names go into the container's media/ first. ---
    const seedBuiltContainer = async (
        spec: { folder: string; name: string; author: LeadRole },
        type: 'vector' | 'slides' | 'sheets',
        imageFiles: string[],
        build: (doc: Y.Doc) => void,
    ): Promise<DrivePath> => {
        const author = userForRole(spec.author);
        const container = await teamDrive.create(teamMountId, lookup(folderId, spec.folder), spec.name, type, author);
        await uploadMedia(teamDrive, teamMountId, container, imageFiles, author);
        const collab = await teamDrive.getCollabDocument(teamMountId, container.id);
        build(collab.doc);
        await teamDrive.flushContainerDb(teamMountId, container.id);
        return container;
    };

    teamDocs.set(
        SITE_PLAN.name,
        await seedBuiltContainer(
            SITE_PLAN,
            'vector',
            SITE_PLAN.images.map((image) => image.file),
            (doc) => buildVectorDoc(doc, SITE_PLAN),
        ),
    );
    teamDocs.set(
        SPONSOR_DECK.name,
        await seedBuiltContainer(
            SPONSOR_DECK,
            'slides',
            SPONSOR_DECK.slides.flatMap((slide) => slide.images ?? []).map((image) => image.file),
            (doc) => buildDeckDoc(doc, SPONSOR_DECK.slides),
        ),
    );
    teamDocs.set(
        BUDGET.name,
        await seedBuiltContainer(BUDGET, 'sheets', [], (doc) => buildWorkbookDoc(doc, BUDGET.sheets)),
    );

    // --- Stickies: a byte copy of the fixture's databases. A container finds its parts by name, so the copy works,
    // and they go in through the mount, as no person writes inside a document. ---
    const boardAuthor = userForRole('production');
    const boardFolderId = lookup(folderId, KANBAN.folder);
    const { mount: teamMount } = await teamDrive.resolveFile(teamMountId, boardFolderId);
    const boardId = await teamMount.createFolder(boardFolderId, `${KANBAN.name}.eigenstickies`, 'stickies');
    for (const dbName of [CONTAINER_DATA_DB, CONTAINER_COMMENTS_DB]) {
        const tempId = crypto.randomUUID();
        const bytes = readFileSync(join(FIXTURES_DIR, 'festival-kanban.eigenstickies', dbName));
        const { size, hash } = await writeTempWithHash(teamMount.getTempPath(tempId), bytes);
        await teamMount.createFileFromTemp(boardId, dbName, SQLITE_MIME, size, hash, tempId);
        await teamMount.cleanupTemp(tempId);
    }
    await teamMount.createFolder(boardId, CONTAINER_MEDIA_FOLDER);
    await teamMount.createFolder(boardId, CONTAINER_CHAT_FOLDER);
    await teamDrive.recordFileEvent(teamMountId, boardId, boardAuthor, { eventType: 'created' });
    teamDocs.set(KANBAN.name, await teamMount.getActivePath(boardId));

    // Card chat threads work like doc comments: a real chat in the container's chat/ subfolder, started by the
    // card's creator and linked back onto the card by name.
    const boardChatFolder = await teamDrive.getChildByName(teamMountId, boardId, CONTAINER_CHAT_FOLDER);
    if (!boardChatFolder) throw new Error(`chat/ subfolder missing for ${KANBAN.name}`);
    const cardChatNames: string[] = [];
    for (const card of KANBAN.cards) {
        const cardAuthor = lookup(userByKey, card.creator);
        const chat = await teamDrive.create(teamMountId, boardChatFolder.id, card.chat, 'chat', cardAuthor);
        await postTo(chat.id, cardAuthor, card.chatText);
        for (const reply of card.chatReplies ?? []) {
            const replyAuthor = lookup(userByKey, reply.author);
            const attachments: ChatAttachment[] = reply.attach?.map(teamDocRef) ?? [];
            // An uploaded copy lands in the chat's own media/, where the thread resolves attachment names.
            for (const name of reply.attachVCards ?? []) {
                const vcf = VCARD_FILES.find((file) => file.name === name);
                if (!vcf) throw new Error(`Card chat reply attaches unknown vCard file '${name}'`);
                const chatMedia = await teamDrive.getChildByName(teamMountId, chat.id, CONTAINER_MEDIA_FOLDER);
                if (!chatMedia) throw new Error(`media/ subfolder missing for ${chat.name}`);
                const upload = await teamDrive.createFileFromData(
                    teamMountId,
                    chatMedia.id,
                    vcf.name,
                    VCARD_MIMES[0],
                    Buffer.from(seedVCard(vcf.card), 'utf8'),
                    replyAuthor,
                );
                attachments.push(upload.name);
            }
            await postTo(chat.id, replyAuthor, reply.text, attachments);
        }
        cardChatNames.push(chat.name);
    }

    // The fixture stores card and column creators as bare persona keys. They become this run's emails, so the board
    // shows author names under any MAIL_DOMAIN. Every card also gets the default card color, its chat link and a
    // createdAt relative to the seed time.
    const boardCreatedAt = Date.now() - 14 * 86_400_000;
    const board = await teamDrive.getCollabDocument(teamMountId, boardId);
    board.doc.transact(() => {
        for (const rootName of ['tasks', 'columns']) {
            for (const [, entry] of getItemMapRoot(board.doc, rootName)) {
                if (!(entry instanceof Y.Map)) continue;
                entry.set('creator', emailFor(entry.get('creator')));
            }
        }
        const tasksMap = getItemMapRoot(board.doc, 'tasks');
        for (const [i, spec] of KANBAN.cards.entries()) {
            const task = tasksMap.get(`card-${i + 1}`);
            if (!(task instanceof Y.Map)) continue;
            task.set('color', DEFAULT_CARD_COLOR);
            task.set('chatName', cardChatNames[i]);
            task.set('createdAt', boardCreatedAt + (i + 1) * 86_400_000); // a card a day after the board
            if (spec.attach) task.set('attachments', spec.attach.map(teamDocRef));
        }
    });
    await teamDrive.flushContainerDb(teamMountId, boardId);

    // --- Chat channels in chats/, such as #production with its worry about the weather. ---
    for (const channel of CHATS) {
        const first = lookup(userByKey, channel.messages[0].author);
        const chat = await teamDrive.create(teamMountId, lookup(folderId, 'chats'), channel.name, 'chat', first);
        const room = await teamDrive.getChat(teamMountId, chat.id);
        for (const line of channel.messages) {
            const attachments = line.attach?.map(teamDocRef);
            await room.postMessage(
                lookup(userByKey, line.author),
                line.text,
                'message',
                undefined,
                undefined,
                attachments,
            );
        }
    }

    // --- Calendar: team events. The team calendar is shared, so an event sends no invitations. ---
    const defaultCalendar = (await teamHome.calendar.getCalendars()).find((calendar) => calendar.isDefault);
    if (!defaultCalendar) throw new Error('Team default calendar missing');
    const now = new Date();
    // Anchor the festival on a weekend: the first Saturday at least ~3 weeks out (so it lands 20-26
    // days ahead). Every event is placed relative to this Saturday, so the festival is always Sat/Sun
    // and the go/no-go the Friday before, whatever weekday the hourly reseed happens to run on.
    const festivalSaturday = new Date(now);
    festivalSaturday.setDate(festivalSaturday.getDate() + 20);
    while (festivalSaturday.getDay() !== 6) festivalSaturday.setDate(festivalSaturday.getDate() + 1);
    festivalSaturday.setHours(0, 0, 0, 0);
    // A timed slot of a seeded event, shift or invitation: its day walked from the festival Saturday, at local hours.
    const timedSlot = (slot: { daysFromFestival: number; startHour: number; durationHours: number }) => {
        const start = new Date(festivalSaturday);
        start.setDate(start.getDate() + slot.daysFromFestival);
        start.setHours(slot.startHour, 0, 0, 0);
        const end = new Date(start);
        end.setHours(end.getHours() + slot.durationHours);
        return { start, end };
    };
    const resolvePersona = (ref: string) => PERSONAS.find((persona) => persona.role === ref) ?? personaByKey(ref);
    for (const event of EVENTS) {
        let { start, end } = timedSlot(event);
        if (event.allDay) {
            // An all-day event is stored as UTC midnight with an exclusive end, as the create-event dialog and the
            // CalDAV import store it. The calendar groups all-day events by their UTC date, so local midnight
            // would move the festival a day early in a timezone east of UTC.
            start = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
            end = new Date(start);
            end.setUTCDate(end.getUTCDate() + 2); // the festival Saturday and Sunday
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
        await teamHome.calendar.createEvent(defaultCalendar.id, {
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

    // --- Shifts: one event in each persona's own calendar, which their home makes on first open. ---
    for (const shift of SHIFTS) {
        const owner = lookup(userByKey, shift.persona);
        const { calendar } = await getHome(owner.id);
        const personal = (await calendar.getCalendars()).find((candidate) => candidate.isDefault);
        if (!personal) throw new Error(`Default calendar missing for ${owner.email}`);
        const { start, end } = timedSlot(shift);
        await calendar.createEvent(personal.id, {
            title: shift.title,
            startTime: start,
            endTime: end,
            allDay: false,
            createByUserId: owner.id,
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
    // Real MIME attachments: committed fixture bytes, a vCard written by the shipped writer, or a workbook written by
    // the shipped xlsx exporter.
    const mailAttachment = (attachment: MailAttachment) => {
        const { filename } = attachment;
        if ('vcard' in attachment) {
            return { filename, contentType: VCARD_CONTENT_TYPE, content: seedVCard(attachment.vcard) };
        }
        if ('workbook' in attachment) {
            const sheets = buildWorkbook(attachment.workbook);
            const xlsx = writeXlsx(sheets, { title: basename(filename, '.xlsx'), media: [], lost: lossCounter().lost });
            return { filename, contentType: XLSX_MIME, content: Buffer.from(xlsx) };
        }
        return {
            filename,
            contentType: attachment.mimeType,
            content: readFileSync(join(FIXTURES_DIR, attachment.fixture)),
        };
    };
    // An invitation as an outside calendar sends one: the shipped iMIP writer over the event its organizer holds.
    // Seeded mail carries no DKIM verdict, so delivery leaves the persona's calendar alone, and the mail shows the
    // invitation card all the same.
    const inviteIcs = (invite: SeededInvite, organizer: { name: string; email: string }, attendee: User): string => {
        const { start, end } = timedSlot(invite);
        const event: CalendarEvent = {
            id: crypto.randomUUID(),
            calendarId: '',
            uid: `${crypto.randomUUID()}@${organizer.email.split('@')[1]}`,
            uri: '',
            title: invite.title,
            description: invite.description ?? null,
            location: invite.location ?? null,
            startTime: start,
            endTime: end,
            allDay: false,
            rrule: null,
            timezone: null,
            parentEventId: null,
            recurrenceDate: null,
            status: 'confirmed',
            sequence: 0,
            etag: '',
            data: {
                organizer: { userId: '', email: organizer.email, name: organizer.name },
                attendees: [{ email: attendee.email, name: attendee.name, status: 'pending', role: 'required' }],
            },
            createByUserId: null,
            createdAt: now,
            updatedAt: now,
        };
        return serializeEventForImip(event, 'REQUEST');
    };
    // The sender of a seeded message, as the From line and a reply's quote header name them.
    const senderOf = (message: SeededMail['messages'][number]): { name: string; address: string } => {
        if (message.fromExternal) return { name: message.fromExternal.name, address: message.fromExternal.email };
        if (!message.from) throw new Error('A seeded message names no sender');
        const persona = resolvePersona(message.from);
        return { name: persona.name, address: emailFor(persona.key) };
    };
    // Threads one flow's messages: the date, the Re: prefix, the In-Reply-To and References chain, and the quote.
    // Each branch below only picks the sender and the recipient and delivers. A reply quotes the message before it,
    // as Eigen's composer does, so the last reply holds the whole thread. Its text part is the text of its HTML, as
    // in a reply sent from Eigen.
    const threadState = (subject: string) => {
        const references: string[] = [];
        let previous: { id: string; from: { name: string; address: string }; date: Date; html: string } | undefined;
        return async (
            message: SeededMail['messages'][number],
            parts: { to: string; html?: string; icalEvent?: { method: string; content: string } },
        ): Promise<Buffer> => {
            const date = new Date(now.getTime() - message.daysAgo * 86_400_000);
            date.setHours(message.hour, 0, 0, 0);
            const messageId = `${crypto.randomUUID()}@${MAIL_DOMAIN}`;
            const from = senderOf(message);
            const ownHtml = parts.html ?? textToHtml(message.text);
            const reply = previous && ownHtml + formatReplyQuote(previous.from, previous.date, previous.html);
            const buffer = await buildRfc822({
                from: `${from.name} <${from.address}>`,
                to: parts.to,
                subject: previous ? `Re: ${subject}` : subject,
                date,
                text: reply ? stripTagsServer(reply) : message.text,
                html: reply ?? parts.html,
                messageId,
                inReplyTo: previous?.id,
                references: references.length ? references : undefined,
                attachments: message.attachments?.map(mailAttachment),
                icalEvent: parts.icalEvent,
            });
            references.push(messageId);
            previous = { id: messageId, from, date, html: reply ?? ownHtml };
            return buffer;
        };
    };
    for (const flow of MAILS) {
        const nextInThread = threadState(flow.subject);
        if (flow.kind === 'inbox-thread') {
            if (!flow.to) throw new Error(`Inbox thread '${flow.subject}' names no recipient`);
            const recipient = lookup(userByKey, resolvePersona(flow.to).key);
            const recipientHome = await getHome(recipient.id);
            // The outside party, such as a booker, is the other end of every message.
            const externalParty = flow.messages.find((message) => message.fromExternal)?.fromExternal;
            let answeredId: string | undefined;
            for (const message of flow.messages) {
                const external = message.fromExternal;
                const to = external
                    ? recipient.email
                    : externalParty
                      ? `${externalParty.name} <${externalParty.email}>`
                      : recipient.email;
                const icalEvent =
                    external && message.invite
                        ? { method: 'REQUEST', content: inviteIcs(message.invite, external, recipient) }
                        : undefined;
                const buffer = await nextInThread(message, { to, html: message.html, icalEvent });
                const deliveredId = await recipientHome.mail.mailboxDeliver(buffer);
                // The persona's own replies belong in their Sent box, not their inbox. They move there and are
                // marked read, as mail you sent is.
                if (!external) {
                    await recipientHome.mail.messageMove(deliveredId, MAILBOX_SENT);
                    await recipientHome.mail.messageSetRead(deliveredId, true);
                    // The inbound message it answers shows the reply arrow, as a real send leaves it.
                    if (answeredId) await recipientHome.mail.messageSetReplied(answeredId);
                }
                answeredId = external ? deliveredId : undefined;
            }
        } else {
            const to = `${TEAM_NAME} <crew@${MAIL_DOMAIN}>`;
            // Each persona's copy of the previous message, which the next sender's reply answers.
            let previousCopies = new Map<string, string>();
            for (const [i, message] of flow.messages.entries()) {
                const senderAddress = senderOf(message).address;
                // Only the mail that opens the flow links the drive. A seeded body is an HTML fragment with no
                // <body>, so the pill goes at its end, as the mail client's appendReferenceLinks puts it.
                const html =
                    i === 0 && flow.attachTeamDrive && message.html
                        ? message.html + renderAttachmentPills([teamDriveRef])
                        : message.html;
                // Every persona gets a copy of one message with one Message-ID, as with a real list mail. A
                // reply threads only when it references that id.
                const buffer = await nextInThread(message, { to, html });
                const copies = new Map<string, string>();
                for (const persona of PERSONAS) {
                    const home = await getHome(lookup(userByKey, persona.key).id);
                    const deliveredId = await home.mail.mailboxDeliver(buffer);
                    copies.set(persona.key, deliveredId);
                    // The sender's own copy belongs in their Sent box, same as an inbox-thread reply.
                    if (emailFor(persona.key) === senderAddress) {
                        await home.mail.messageMove(deliveredId, MAILBOX_SENT);
                        await home.mail.messageSetRead(deliveredId, true);
                        const answeredId = previousCopies.get(persona.key);
                        if (answeredId) await home.mail.messageSetReplied(answeredId);
                    }
                }
                previousCopies = copies;
            }
        }
    }

    // --- Contacts: the external ecosystem in a few leads' address books. ---
    for (const contact of CONTACTS) {
        const owner = userForRole(contact.owner);
        const contacts = await resolveContacts(owner, owner.id);
        await contacts.addContact(contactInput(contact));
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

    // --- Personal docs: a private "my notes" and a "trying eigen" scratch doc in every persona's own drive (same
    // content for all). Each JSON is built once and written into each persona's own home drive, its photos into the
    // doc's media/. ---
    const personalDocs = [NOTES, TRYING_EIGEN].map((doc) => ({
        name: doc.name,
        json: htmlToDocJson(docSchema(), doc.html),
        media: doc.media ?? [],
    }));
    for (const persona of PERSONAS) {
        const owner = lookup(userByKey, persona.key);
        const ownerHome = await getHome(owner.id);
        const ownerRoot = await ownerHome.drive.getRootFolder('default');
        if (!ownerRoot) throw new Error(`Root missing for ${owner.email}`);
        for (const doc of personalDocs) {
            const docPath = await createDoc(ownerHome.drive, 'default', ownerRoot.id, doc.name, doc.json, owner);
            await uploadMedia(ownerHome.drive, 'default', docPath, doc.media, owner);
        }
    }

    // --- Unread: only the newest message in each persona's inbox, the rest read as if they had opened it. Runs last,
    // after every delivery, through the store's mark-read path, which sets the message's Maildir seen flag. ---
    for (const persona of PERSONAS) {
        const ownerMail = (await getHome(lookup(userByKey, persona.key).id)).mail;
        // Newest first, so everything after the head is older.
        const [, ...older] = await ownerMail.mailboxGet(MAILBOX_INBOX);
        for (const email of older) {
            if (!email.isRead) await ownerMail.messageSetRead(email.id, true);
        }
    }

    // Wait for the deliveries that run in the background, then close every home with its databases.
    await drainHomeDeliveries();
    await Bun.sleep(500);
    await drainHomeDeliveries();
    await shutdownAllHomes();

    console.log(`Seeded "Tuimel Festival" for ${PERSONAS.length} personas at ${DATA_ROOT}`);
    console.log(`  org:   ${ORG_NAME}  team: ${TEAM_NAME}`);
    console.log(`  admin: ${ADMIN_EMAIL}  password: ${ADMIN_PASSWORD}`);

    // The reset script restarts the API only once this file exists. It is written last, so a crash during the seed
    // leaves the API down rather than serving a half-built world. The wipe clears it.
    writeFileSync(join(DATA_ROOT, 'server', '.demo-seeded'), '');
    process.exit(0);
}

main().catch((error) => {
    console.error('seed-demo failed:', error);
    process.exit(1);
});
