// Builds the "Tuimel Festival" demo world for an EIGEN_DEMO instance: a crew of personas in one org and its teams, a
// lived-in team drive with such files as docs, a budget and a stickies board, their mail, calendars, chats and
// contacts, and an outside guest. It boots the API in-process and acts as the personas through the product's own
// code, so activity, history and notifications fill in. The demo reset wipes the data root and reruns it; a completed
// setup is refused. It needs EIGEN_DATA_ROOT; MAIL_DOMAIN, DOMAIN and the EIGEN_DEMO_*_PASSWORD vars may be set.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { EIGEN_ACCENT_COLORS_SHUFFLED, EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
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
import { teamOwnerId } from '@workspace/lib/types/owner';
import { parseIdList, serializeIdList } from '@workspace/lib/vector';
import { eq } from 'drizzle-orm';
import { JSDOM } from 'jsdom';
import MailComposer from 'nodemailer/lib/mail-composer';
import * as Y from 'yjs';
import type { Contacts } from '../lib/contacts/contacts';
import type { Drive } from '../lib/drive';
import { textToHtml } from '../lib/mail/mail-parser/html';
import { CONTAINER_COMMENTS_DB, CONTAINER_DATA_DB } from '../lib/mount/container-dbs';
import { writeTempWithHash } from '../lib/storage';
import type { User } from '../lib/user';
import type {
    CanvasComment,
    ChatLine,
    LeadRole,
    MailAttachment,
    SeededInvite,
    SeededMail,
    SeededTime,
    SeededVCardFile,
    VCardSpec,
} from './demo/content';
import {
    ADMIN_AVATAR,
    ADMIN_LOCALPART,
    ADMIN_NAME,
    BRANDING,
    BUDGET,
    CHATS,
    CONTACTS,
    DEMO_MAIL_DOMAIN,
    DOCS,
    EVENTS,
    emailFor,
    HEIN_KLARENBEEK,
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
    TECH_TEAM_MEMBERS,
    TECH_TEAM_NAME,
    TRYING_EIGEN,
    threadTimes,
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
const MAIL_DOMAIN = (process.env['MAIL_DOMAIN'] ||= DEMO_MAIL_DOMAIN);
const DOMAIN = (process.env['DOMAIN'] ||= MAIL_DOMAIN);

// A seeded mail stores the link of each drive pill, built from the per-app VITE_APP_*_URL vars. A missing one would
// bake in the dev localhost, so it points at the deploy host, each app under its own path, as the live API resolves.
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
// The demo entry route resets each persona's password on every visit, so a demo box needs none of its own. A tool that
// signs a persona in with a password sets one.
const PERSONA_PASSWORD = process.env['EIGEN_DEMO_PERSONA_PASSWORD'] || randomBytes(18).toString('base64url');

const ADMIN_EMAIL = emailFor(ADMIN_LOCALPART, MAIL_DOMAIN);

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

// A raw message from the MIME composer the app's outbound mail uses, called directly so the seed sets the threading
// headers (Message-ID, In-Reply-To, References) itself, and any a receiving MTA would add. With html it is
// multipart/alternative.
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
    headers?: Record<string, string>;
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
        headers: mail.headers,
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

// A file a container keeps in its media/, such as a fixture photo or a vCard written at seed time.
type MediaFile = { name: string; type: string; bytes: Buffer };

function fixtureMedia(file: string): MediaFile {
    const path = join(FIXTURES_DIR, file);
    return { name: basename(path), type: Bun.file(path).type, bytes: readFileSync(path) };
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
    entry.set('chatName', card.chatName);
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
    const { drainHomeDeliveries } = await import('../lib/home/home-relay');
    const { writeTeamAvatar } = await import('../lib/user/profile');
    const { generateImagePreview } = await import('../lib/shared/thumbnails');
    const { renderAttachmentPills } = await import('../lib/mailer/mail-template');
    const { createVCard } = await import('../lib/vcard');
    const { serializeEventForImip } = await import('../lib/ical');
    const { lossCounter } = await import('../lib/document/transform/protocol');
    const { writeXlsx } = await import('../lib/export/sheets/xlsx/to-xlsx');
    const { CHAT_ROOM_DB_CONFIG } = await import('../lib/chat/db-config');
    const { messages } = await import('../lib/chat/schema');
    const { grantAccessForReferences } = await import('../lib/mail/access-grants');
    const { createGuestUser } = await import('../lib/auth/guest-auth');
    const { reconcileShares } = await import('../lib/share');

    // The one moment every seeded date counts back from.
    const now = new Date();

    // Before any home exists, because a home fixes its mount type on its first init. The welcome mail is off, or it
    // would be the first message in every persona's inbox.
    await updateServerSettings({
        guests: { openSignup: false },
        quotas: { defaultMountMaxSizeMB: 50, maxUploadSizeMB: 5 },
        onboarding: { welcomeMail: { enabled: false } },
    });

    // --- Personas: the user.create hook auto-joins each to the default org as `member`. ---
    for (const persona of PERSONAS) {
        await auth.api.createUser({
            body: {
                email: emailFor(persona.key, MAIL_DOMAIN),
                password: PERSONA_PASSWORD,
                name: persona.name,
                role: 'user',
            },
        });
    }
    const userByKey = new Map<string, User>();
    for (const persona of PERSONAS) {
        const user = await getUserByEmail(emailFor(persona.key, MAIL_DOMAIN));
        if (!user) throw new Error(`Persona ${persona.key} not found after creation`);
        userByKey.set(persona.key, user);
    }
    const userForRole = (role: LeadRole): User => lookup(userByKey, personaByRole(role).key);
    const emailForRole = (role: LeadRole): string => emailFor(personaByRole(role).key, MAIL_DOMAIN);

    // A portrait fixture uploaded into a book's avatar store, the upload a person makes from the card dialog.
    const uploadPortrait = (contacts: Contacts, fixtureFile: string): Promise<string> =>
        contacts.uploadAvatar(
            new File([readFileSync(join(AVATARS_DIR, fixtureFile))], fixtureFile, { type: 'image/jpeg' }),
        );

    // --- Own cards: every account's portrait, and for a persona the job title, the festival and a phone. An update
    // of your own card goes through writeUserProfile, which stores the avatar and sets user.image. ---
    const seedOwnCard = async (
        user: User,
        avatarFile: string,
        details?: Pick<CreateContactInput, 'jobTitle' | 'company' | 'phone'>,
    ): Promise<void> => {
        const contacts = await resolveContacts(user, user.id);
        const me = await contacts.getMe();
        if (!me) throw new Error(`No own card for ${user.email}`);
        const { id, ...fields } = me;
        await contacts.updateContact(id, { ...fields, ...details, avatar: await uploadPortrait(contacts, avatarFile) });
    };
    for (const persona of PERSONAS) {
        await seedOwnCard(lookup(userByKey, persona.key), persona.avatar, {
            jobTitle: persona.title,
            company: ORG_NAME,
            phone: [persona.phone],
        });
    }
    const adminUser = await getUserByEmail(ADMIN_EMAIL);
    if (!adminUser) throw new Error('The admin is missing after setup');
    await seedOwnCard(adminUser, ADMIN_AVATAR);

    const orgId = getServerConfig()?.orgId;
    if (!orgId) throw new Error('orgId missing after setup');

    // The team calls need the headers of a signed-in admin.
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

    // The leads have signed in before, so the admin's user list shows when each was last active. The sessions are
    // not kept.
    for (const persona of PERSONAS) {
        if (!persona.role) continue;
        await auth.api.signInEmail({ body: { email: emailFor(persona.key, MAIL_DOMAIN), password: PERSONA_PASSWORD } });
    }

    // --- Team (the whole crew shares one workspace): the default team, which every persona joined
    // with the org, renamed from the org's name to the crew's. ---
    const teamId = getServerConfig()?.defaultTeamId;
    if (!teamId) throw new Error('defaultTeamId missing after setup');
    await auth.api.updateTeam({
        body: { teamId, data: { name: TEAM_NAME, organizationId: orgId } },
        headers: adminHeaders,
    });
    // A second team, made and filled as the Admin app does. Each add reconciles the member's shares in its hook.
    const techTeam = await auth.api.createTeam({
        body: { name: TECH_TEAM_NAME, organizationId: orgId },
        headers: adminHeaders,
    });
    for (const key of TECH_TEAM_MEMBERS) {
        await auth.api.addTeamMember({
            body: { teamId: techTeam.id, userId: lookup(userByKey, key).id, organizationId: orgId },
            headers: adminHeaders,
        });
    }

    // --- Team avatar: the festival logo, through the same pipeline as the avatar route. ---
    const logoBytes = readFileSync(join(FIXTURES_DIR, 'branding', 'logo.webp'));
    const logo = await generateImagePreview(logoBytes, 'image/webp', 'logo.webp', '', 'avatar', {
        maxSize: 512,
        quality: 80,
        fit: 'cover',
    });
    if (!logo) throw new Error('The team avatar thumbnail failed');
    await writeTeamAvatar(teamId, logo.data);

    // --- Team home: enable the calendar (starts disabled) and add the shared mount, raised above the default quota
    // for the crew's photos. ---
    const teamHome = await getTeamHome(teamOwnerId(teamId));
    await teamHome.settings.set({ calendar: { enabled: true } });
    const mount = await teamHome.addMount({ name: TEAM_MOUNT_NAME, maxSizeMB: 100 });
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
    // The optional portrait is embedded as an inline PHOTO, read from the same avatars/ fixtures the personas use.
    const seedVCard = (spec: VCardSpec): string =>
        createVCard(
            {
                ...contactInput(spec),
                photo: spec.photo
                    ? { bytes: readFileSync(join(AVATARS_DIR, spec.photo)), mediaType: 'image/jpeg' }
                    : undefined,
            },
            `demo-${spec.email}`,
        );
    const vcardMedia = (vcf: SeededVCardFile): MediaFile => ({
        name: vcf.name,
        type: VCARD_MIMES[0],
        bytes: Buffer.from(seedVCard(vcf.card), 'utf8'),
    });
    const vcardFiles = new Map(VCARD_FILES.map((vcf) => [vcf.name, vcf]));
    for (const vcf of VCARD_FILES) {
        const { name, type, bytes } = vcardMedia(vcf);
        const folder = lookup(folderId, vcf.folder);
        await teamDrive.createFileFromData(teamMountId, folder, name, type, bytes, lookup(userByKey, vcf.uploader));
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

    // --- Volunteer roster: a doc in volunteers/ that links each name to its team contact card. It is built here,
    // because the links carry this run's team id and emails. They have no host, so any domain serves them. ---
    {
        const author = userForRole('volunteers');
        const rosterItems = PERSONAS.map((persona) => {
            const url = `/contacts/team/${teamId}?contactId=${encodeURIComponent(emailFor(persona.key, MAIL_DOMAIN))}`;
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

    // Files into a container's media/ folder, where a doc's figures, a canvas's images and a chat's attachments find
    // them by name, so the document stays whole.
    const uploadMedia = async (
        drive: Drive,
        mountId: string,
        container: DrivePath,
        files: readonly MediaFile[],
        author: User,
    ): Promise<DrivePath[]> => {
        const mediaFolder = await drive.getChildByName(mountId, container.id, CONTAINER_MEDIA_FOLDER);
        if (!mediaFolder) throw new Error(`media/ subfolder missing for ${container.name}`);
        const uploads: DrivePath[] = [];
        for (const { name, type, bytes } of files) {
            uploads.push(await drive.createFileFromData(mountId, mediaFolder.id, name, type, bytes, author));
        }
        return uploads;
    };

    // --- Threads: the room's own post stamps the seed minute, so a thread's rows are dated after it, in the order
    // they were posted and never back in time, which the paging by time and row needs. Returns the first time. ---
    const postThread = async (chat: DrivePath, start: SeededTime | Date, lines: readonly ChatLine[]): Promise<Date> => {
        const room = await teamDrive.getChat(teamMountId, chat.id);
        const times = threadTimes(now, start, lines.slice(1));
        const posted: { id: string; createdAt: Date }[] = [];
        for (const [i, line] of lines.entries()) {
            const author = lookup(userByKey, line.author);
            // An upload lands in the chat's own media/, where the thread resolves attachment names.
            const files = [
                ...(line.upload ?? []).map(fixtureMedia),
                ...(line.attachVCards ?? []).map((name) => vcardMedia(lookup(vcardFiles, name))),
            ];
            const uploads = await uploadMedia(teamDrive, teamMountId, chat, files, author);
            const attachments: ChatAttachment[] = [
                ...(line.attach?.map(teamDocRef) ?? []),
                ...uploads.map((upload) => upload.name),
            ];
            // A whisper names its reader by email, as the chat client sends one.
            const whisperTo = line.whisperTo ? lookup(userByKey, line.whisperTo).email : undefined;
            const { id } = await room.postMessage(
                author,
                line.text,
                whisperTo ? 'whisper' : 'message',
                whisperTo,
                undefined,
                attachments,
            );
            posted.push({ id, createdAt: times[i] });
        }
        const dataDb = await teamDrive.getChildByName(teamMountId, chat.id, CONTAINER_DATA_DB);
        if (!dataDb) throw new Error(`data.db missing for ${chat.name}`);
        await teamDrive.withDatabase(teamMountId, CHAT_ROOM_DB_CONFIG, dataDb.id, async ({ db }) => {
            for (const { id, createdAt } of posted) {
                await db.update(messages).set({ createdAt }).where(eq(messages.id, id));
            }
        });
        return times[0];
    };

    // A comment's thread, posted as a chat in its container's chat/, and the card that names it, as old as the thread.
    const seedCommentThread = async (
        chatFolder: DrivePath,
        comment: Omit<CanvasComment, 'element' | 'start'> & { start: SeededTime | Date; attach?: string[] },
    ): Promise<CommentCard & { createdAt: number }> => {
        const author = lookup(userByKey, comment.author);
        const chat = await teamDrive.create(teamMountId, chatFolder.id, comment.card, 'chat', author);
        const startedAt = await postThread(chat, comment.start, [
            { author: comment.author, text: comment.text },
            ...(comment.replies ?? []),
        ]);
        return {
            id: crypto.randomUUID(),
            title: comment.title,
            description: '',
            color: DEFAULT_CARD_COLOR,
            chatName: chat.name,
            creator: author.email,
            createdAt: startedAt.getTime(),
            attachments: comment.attach?.map(teamDocRef),
        };
    };

    // --- Docs: each HTML spec becomes an eigendoc in one write, its comment marks anchored first. The container
    // comes before it: its chat/ holds the threads the marks point at, and its media/ the photos its figures show. ---
    for (const doc of DOCS) {
        const author = userForRole(doc.author);
        const parentId = lookup(folderId, doc.folder);
        const docPath = await teamDrive.create(teamMountId, parentId, doc.name, 'doc', author);
        teamDocs.set(doc.name, docPath);
        await uploadMedia(teamDrive, teamMountId, docPath, (doc.media ?? []).map(fixtureMedia), author);

        const chatFolder = await teamDrive.getChildByName(teamMountId, docPath.id, CONTAINER_CHAT_FOLDER);
        if (!chatFolder) throw new Error(`chat/ subfolder missing for ${docPath.name}`);
        const docJson = htmlToDocJson(docSchema(), doc.html);
        const cards: { spec: (typeof doc.comments)[number]; card: CommentCard }[] = [];
        for (const comment of doc.comments) {
            // The title is the anchored text, as the editor makes it.
            const card = await seedCommentThread(chatFolder, { ...comment, title: comment.anchor.slice(0, 100) });
            if (!injectCommentMark(docJson, comment.anchor, card.id)) {
                throw new Error(`Anchor "${comment.anchor}" not found in "${doc.name}"`);
            }
            cards.push({ spec: comment, card });
        }
        // The collab doc opens right before the doc's one write, because a document that no socket joins closes a
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
        for (const { spec, card } of cards) {
            if (!spec.assignTo) continue;
            const commentAuthor = lookup(userByKey, spec.author);
            const assignee = userForRole(spec.assignTo).email;
            await teamDrive.assignComment(teamMountId, docPath.id, card.chatName, assignee, commentAuthor, card.title);
        }
        await teamDrive.flushContainerDb(teamMountId, docPath.id);
    }

    // --- The containers built straight into their Y.Doc from a typed spec, such as the site plan and the budget. A
    // canvas comment is written in the editor's order: the thread, the card, then its id on the element. ---
    const seedBuiltContainer = async (
        spec: { folder: string; name: string; author: LeadRole; comments?: CanvasComment[] },
        type: 'vector' | 'slides' | 'sheets',
        imageFiles: string[],
        build: (doc: Y.Doc) => void,
    ): Promise<DrivePath> => {
        const author = userForRole(spec.author);
        const container = await teamDrive.create(teamMountId, lookup(folderId, spec.folder), spec.name, type, author);
        await uploadMedia(teamDrive, teamMountId, container, imageFiles.map(fixtureMedia), author);
        const chatFolder = await teamDrive.getChildByName(teamMountId, container.id, CONTAINER_CHAT_FOLDER);
        if (!chatFolder) throw new Error(`chat/ subfolder missing for ${container.name}`);
        const cards: { elementId: string; card: CommentCard }[] = [];
        for (const comment of spec.comments ?? []) {
            cards.push({ elementId: `el-${comment.element}`, card: await seedCommentThread(chatFolder, comment) });
        }
        // The collab doc opens right before its one write, as a doc's does above.
        const collab = await teamDrive.getCollabDocument(teamMountId, container.id);
        build(collab.doc);
        const anchored = cards.map(({ elementId, card }) => {
            const element = collab.doc.getMap('elements').get(elementId);
            if (!(element instanceof Y.Map))
                throw new Error(`"${spec.name}" has no element ${elementId} to comment on`);
            return { element, card };
        });
        collab.doc.transact(() => {
            for (const { element, card } of anchored) {
                writeCommentCard(collab.doc, card);
                const held = element.get('commentCardIds');
                const ids = parseIdList(typeof held === 'string' ? held : '');
                element.set('commentCardIds', serializeIdList([...ids, card.id]));
            }
        });
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
    const boardPath = await teamMount.getActivePath(boardId);
    teamDocs.set(KANBAN.name, boardPath);

    // A card's thread is a chat in the board's chat/, as old as the card. Its cover is an upload into the board's
    // media/ on its attachments, because a card's first image attachment is its cover. The board's author hands it out.
    const boardChatFolder = await teamDrive.getChildByName(teamMountId, boardId, CONTAINER_CHAT_FOLDER);
    if (!boardChatFolder) throw new Error(`chat/ subfolder missing for ${KANBAN.name}`);
    const boardCreatedAt = now.getTime() - 14 * 86_400_000;
    const boardCards: { chatName: string; createdAt: number; attachments: ChatAttachment[] }[] = [];
    for (const [i, card] of KANBAN.cards.entries()) {
        const { chatName, createdAt } = await seedCommentThread(boardChatFolder, {
            card: card.chat,
            title: card.title,
            author: card.creator,
            text: card.chatText,
            start: card.start ?? new Date(boardCreatedAt + (i + 1) * 86_400_000),
            replies: card.chatReplies,
        });
        const cover = card.cover ? [fixtureMedia(card.cover)] : [];
        const covers = await uploadMedia(teamDrive, teamMountId, boardPath, cover, lookup(userByKey, card.creator));
        boardCards.push({
            chatName,
            createdAt,
            attachments: [...covers.map((upload) => upload.name), ...(card.attach?.map(teamDocRef) ?? [])],
        });
        if (card.assignTo) {
            const assignee = emailForRole(card.assignTo);
            await teamDrive.assignComment(teamMountId, boardId, chatName, assignee, boardAuthor, card.title);
        }
        if (card.resolvedBy) {
            const resolver = lookup(userByKey, card.resolvedBy);
            await teamDrive.setCommentStatus(teamMountId, boardId, chatName, 'resolved', resolver, card.title);
        }
    }

    // The fixture stores creators as bare persona keys, which become this run's emails. Its createdAt is the day it
    // was authored, so every card gets one relative to the seed.
    const board = await teamDrive.getCollabDocument(teamMountId, boardId);
    board.doc.transact(() => {
        for (const rootName of ['tasks', 'columns']) {
            for (const [, entry] of getItemMapRoot(board.doc, rootName)) {
                if (!(entry instanceof Y.Map)) continue;
                entry.set('creator', emailFor(entry.get('creator'), MAIL_DOMAIN));
            }
        }
        const tasksMap = getItemMapRoot(board.doc, 'tasks');
        for (const [i, { chatName, createdAt, attachments }] of boardCards.entries()) {
            const task = tasksMap.get(`card-${i + 1}`);
            if (!(task instanceof Y.Map)) continue;
            task.set('color', DEFAULT_CARD_COLOR);
            task.set('chatName', chatName);
            task.set('createdAt', createdAt);
            if (attachments.length > 0) task.set('attachments', attachments);
        }
    });
    await teamDrive.flushContainerDb(teamMountId, boardId);

    // --- Chat channels in chats/, such as #production with its worry about the weather. ---
    for (const channel of CHATS) {
        const first = lookup(userByKey, channel.messages[0].author);
        const chat = await teamDrive.create(teamMountId, lookup(folderId, 'chats'), channel.name, 'chat', first);
        await postThread(chat, channel.start, channel.messages);
    }

    // --- Calendar: team events. The team calendar is shared, so an event sends no invitations. ---
    const defaultCalendar = (await teamHome.calendar.getCalendars()).find((calendar) => calendar.isDefault);
    if (!defaultCalendar) throw new Error('Team default calendar missing');
    // The festival is the first Saturday at least 20 days out. Every event is placed from it, so the weekdays hold
    // whatever day the hourly reseed runs on.
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
            // An all-day event is stored as UTC midnight with an exclusive end, as the create-event dialog stores
            // it. The calendar groups them by UTC date, so local midnight would move the festival a day early.
            start = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
            end = new Date(start);
            end.setUTCDate(end.getUTCDate() + 2); // the festival Saturday and Sunday
        }
        const organizer = userForRole(event.organizer);
        const attendees: Attendee[] = event.attendees.map((ref) => {
            const persona = resolvePersona(ref);
            return {
                email: emailFor(persona.key, MAIL_DOMAIN),
                name: persona.name,
                status: event.replies?.[persona.key] ?? 'accepted',
                role: 'required',
            };
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

    // --- Shifts: personal lines in each persona's own calendar, which their home makes on first open. ---
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
        ownerId: teamOwnerId(teamId),
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
                organizer: { email: organizer.email, name: organizer.name },
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
        return { name: persona.name, address: emailFor(persona.key, MAIL_DOMAIN) };
    };
    // Threads one flow's messages: the date, the Re: prefix, the reference chain and the quote. A reply quotes the
    // message before it and its text part is the text of its HTML, both as Eigen's composer writes a reply.
    const threadState = (subject: string) => {
        const references: string[] = [];
        let previous: { id: string; from: { name: string; address: string }; date: Date; html: string } | undefined;
        return async (
            message: SeededMail['messages'][number],
            parts: {
                to: string;
                html?: string;
                icalEvent?: { method: string; content: string };
                headers?: Record<string, string>;
            },
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
                headers: parts.headers,
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
                // An invitation arrives as our MTA hands over a signed one, with its DKIM verdict, so delivery files it
                // in the persona's calendar as a pending invitation.
                const invite =
                    external && message.invite
                        ? {
                              icalEvent: { method: 'REQUEST', content: inviteIcs(message.invite, external, recipient) },
                              headers: {
                                  'Authentication-Results': `${MAIL_DOMAIN}; dkim=pass header.d=${external.email.split('@')[1]}`,
                              },
                          }
                        : {};
                // The persona's own message links documents as a send does that grants the outside party read access.
                let html = message.html;
                if (!external && message.attachDocs) {
                    if (!externalParty) throw new Error(`'${flow.subject}' links documents to nobody outside`);
                    const refs = message.attachDocs.map(teamDocRef);
                    await grantAccessForReferences(
                        recipient,
                        refs,
                        refs.map((ref) => ref.id),
                        [externalParty.email],
                    );
                    html = (html ?? textToHtml(message.text)) + renderAttachmentPills(refs, externalParty.email);
                }
                const buffer = await nextInThread(message, { to, html, ...invite });
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
                    if (emailFor(persona.key, MAIL_DOMAIN) === senderAddress) {
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

    // --- The one guest: Hein opened Saar's link and signed in, which made his account and read his share into it. ---
    await reconcileShares(await createGuestUser(HEIN_KLARENBEEK.email));

    // --- Contacts: the external ecosystem in a few leads' address books, with their labels and portraits. ---
    for (const contact of CONTACTS) {
        const owner = userForRole(contact.owner);
        const contacts = await resolveContacts(owner, owner.id);
        const labelIds = new Map((await contacts.getLabels()).map((label) => [label.name, label.id]));
        for (const name of contact.labels ?? []) {
            if (labelIds.has(name)) continue;
            // A new label takes the next accent color after the ones the book holds.
            labelIds.set(
                name,
                await contacts.addLabel({
                    name,
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[labelIds.size % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
                }),
            );
        }
        await contacts.addContact({
            ...contactInput(contact),
            labels: contact.labels?.map((name) => lookup(labelIds, name)),
            avatar: contact.photo ? await uploadPortrait(contacts, contact.photo) : '',
        });
    }

    // --- Personal-drive files shared with a lead or a team (shared-with-me variety). ---
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
            {
                add: [
                    {
                        id:
                            share.shareWith === TECH_TEAM_NAME
                                ? teamOwnerId(techTeam.id)
                                : emailForRole(share.shareWith),
                        read: true,
                        write: false,
                    },
                ],
            },
            undefined,
            undefined,
            owner,
        );
    }

    // --- Personal docs: "my notes" and "trying eigen" in every persona's own drive, the same for all. Each JSON is
    // built once, and its photos go into the doc's media/. ---
    const personalDocs = [NOTES, TRYING_EIGEN].map((doc) => ({
        name: doc.name,
        json: htmlToDocJson(docSchema(), doc.html),
        media: (doc.media ?? []).map(fixtureMedia),
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
