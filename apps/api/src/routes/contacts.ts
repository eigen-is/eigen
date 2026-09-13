import { IMPORT_MAX_BYTES, IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import type { Contact, ImportContactsResult } from '@workspace/lib/types/contact';
import { isVCardFile } from '@workspace/lib/types/drive';
import type { Label } from '@workspace/lib/types/label';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { parseVCard, unescapeText } from '@workspace/lib/vcard';
import { Elysia, t } from 'elysia';
import { enforceAvatarUpload } from '../lib/config/enforcement';
import { CARD_MAX_BYTES } from '../lib/contacts/card-store';
import { getContacts } from '../lib/contacts/contacts';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { contentDisposition, readBoundedBody, setCacheHeaders } from '../lib/core/http';
import { getSharedDrive } from '../lib/drive';
import { betterAuth } from './auth';

// Field bounds in front of the ceiling the write seam enforces on the assembled card: generous enough that
// no real contact meets them, tight enough that no single value can be the whole card. Free text is capped
// at the card ceiling itself — a value that cannot fit in a card is never worth parsing.
const TEXT = { maxLength: 512 };
const FREE_TEXT = { maxLength: CARD_MAX_BYTES };

const AddressSchema = t.Object({
    street: t.Optional(t.String(TEXT)),
    city: t.Optional(t.String(TEXT)),
    state: t.Optional(t.String(TEXT)),
    zipCode: t.Optional(t.String(TEXT)),
    country: t.Optional(t.String(TEXT)),
});

// The client-writable fields — the create body. The id and the etag are the server's to assign.
const CreateContactSchema = t.Object({
    firstName: t.String(TEXT),
    lastName: t.String(TEXT),
    email: t.Array(t.String({ maxLength: MAX_EMAIL_LENGTH }), { maxItems: 100 }),
    phone: t.Array(t.String(TEXT), { maxItems: 100 }),
    company: t.Optional(t.String(TEXT)),
    jobTitle: t.Optional(t.String(TEXT)),
    address: t.Optional(t.Array(AddressSchema, { maxItems: 50 })),
    birthday: t.Optional(t.String(TEXT)),
    notes: t.Optional(t.String(FREE_TEXT)),
    avatar: t.Optional(t.String(TEXT)),
    labels: t.Optional(t.Array(t.String(TEXT), { maxItems: 200 })),
    eigenId: t.Optional(t.String(TEXT)),
});

// The update body: the same fields plus the etag the client loaded, required by the schema so a write that
// carries no precondition is refused before any handler runs (UpdateContactInput).
const UpdateContactSchema = t.Object({
    ...CreateContactSchema.properties,
    etag: t.String({ ...TEXT, minLength: 1 }),
});

const LabelSchema = t.Object({
    id: t.Optional(t.String(TEXT)),
    name: t.String(TEXT),
    color: t.String(TEXT),
});

// All contacts routes require ownerId === user.id (contacts are personal-only, no shared access)
export const contactsRouter = new Elysia({ name: 'contacts' })
    .use(betterAuth)
    .get(
        '/contacts/:ownerId/contacts',
        async ({ params, user }): Promise<Contact[]> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getContacts();
        },
        { auth: true },
    )
    .get(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, user }): Promise<Contact | null> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getContactById(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/contacts',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).addContact(body);
        },
        {
            body: CreateContactSchema,
            auth: true,
        },
    )
    .put(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, body, user }): Promise<void> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            await (await getContacts(user)).updateContact(params.id, body, body.etag);
        },
        {
            body: UpdateContactSchema,
            auth: true,
        },
    )
    .delete(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, query, user }): Promise<void> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            await (await getContacts(user)).deleteContact(params.id, query.etag);
        },
        {
            query: t.Object({ etag: t.String() }),
            auth: true,
        },
    )
    .get(
        '/contacts/:ownerId/labels',
        async ({ params, user }): Promise<Label[]> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getLabels();
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/labels',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).addLabel(body);
        },
        {
            body: LabelSchema,
            auth: true,
        },
    )
    .put(
        '/contacts/:ownerId/labels/:id',
        async ({ params, body, user }): Promise<Label> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).updateLabel(params.id, body);
        },
        {
            body: LabelSchema,
            auth: true,
        },
    )
    .delete(
        '/contacts/:ownerId/labels/:id',
        async ({ params, user }): Promise<void> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            await (await getContacts(user)).deleteLabel(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/avatar',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            await enforceAvatarUpload(user.id, body.file.size);
            return await (await getContacts(user)).uploadAvatar(body.file);
        },
        {
            body: t.Object({
                file: t.File({ format: 'image/*' }),
            }),
            auth: true,
        },
    )
    .get(
        '/contacts/:ownerId/avatar/:filename',
        async ({ params, user, set }): Promise<ArrayBuffer> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const data = await (await getContacts(user)).downloadAvatar(params.filename);
            if (!data) throw new ApiError(404, 'Avatar not found');
            setCacheHeaders(set, 900);
            set.headers['Content-Type'] = 'image/webp';
            return data;
        },
        { auth: true },
    )
    .get(
        '/contacts/:ownerId/me',
        async ({ params, user }): Promise<Contact | null> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getMe();
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/export',
        async ({ params, body, user, set }): Promise<string> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const text = await (await getContacts(user)).exportCards(body.ids);
            // A one-card export is named after the card itself — its FN, the display name every client
            // writes — a multi-card one generically. contentDisposition sanitises whatever comes back
            // before it reaches the header; the clamp keeps one absurd FN from filling it.
            let fileName = 'contacts.vcf';
            if (body.ids?.length === 1) {
                const fn = parseVCard(text).lines.find((line) => line.name === 'FN');
                const name = fn ? unescapeText(fn.value).trim().slice(0, 200) : '';
                fileName = `${name || 'contact'}.vcf`;
            }
            set.headers['Content-Type'] = 'text/vcard; charset=utf-8';
            set.headers['Content-Disposition'] = contentDisposition('attachment', fileName);
            return text;
        },
        {
            // The same card-count ceiling the import side enforces: one selection can't outgrow one file.
            body: t.Object({ ids: t.Optional(t.Array(t.String(TEXT), { maxItems: IMPORT_MAX_CARDS })) }),
            auth: true,
        },
    )
    .post(
        '/contacts/:ownerId/import',
        async ({ params, request, user, server }): Promise<ImportContactsResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            // A whole book replays card by card through the CardDAV write seam, answering nothing until the
            // last one lands — longer than any server-wide idleTimeout, so exempt this request.
            server?.timeout(request, 0);
            // A card whose name came out of a Windows-1252 export would be stored mangled and re-served to
            // every DAV client, so the file is refused instead of decoded with replacement characters.
            let text: string | null;
            try {
                text = await readBoundedBody(request, IMPORT_MAX_BYTES, true);
            } catch {
                throw new ApiError(400, 'File is not UTF-8 encoded');
            }
            if (text === null) throw new ApiError(413, 'Upload too large');
            return await (await getContacts(user)).importCards(text);
        },
        { auth: true, parse: 'none' },
    )
    .post(
        '/contacts/:ownerId/import-from-drive',
        async ({ params, body, request, user, server }): Promise<ImportContactsResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            // Same idle-timeout exemption as the raw import route: silent until the last card lands.
            server?.timeout(request, 0);
            // The source can live in any drive the user may read — SharedDrive is what checks that.
            const sourceDrive = await getSharedDrive(body.sourceOwnerId, user);
            const source = await sourceDrive.getPath(body.sourceMountId, body.sourcePathId);
            if (!source) throw new ApiError(404, 'Source file not found');
            if (!isVCardFile(source.mimeType, source.name)) throw new ApiError(400, 'Not a vCard file');
            if (source.size > IMPORT_MAX_BYTES) throw new ApiError(413, 'Upload too large');
            const file = await sourceDrive.downloadFile(body.sourceMountId, body.sourcePathId);
            if (!file) throw new ApiError(404, 'Source file not found');
            let text: string;
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            } catch {
                throw new ApiError(400, 'File is not UTF-8 encoded');
            }
            return await (await getContacts(user)).importCards(text);
        },
        {
            body: t.Object({
                sourceOwnerId: t.String(),
                sourceMountId: t.String(),
                sourcePathId: t.String(),
            }),
            auth: true,
        },
    );
