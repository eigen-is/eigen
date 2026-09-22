import { VCARD_CONTENT_TYPE, VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import type { Contact } from '@workspace/lib/types/contact';
import { isVCardFile } from '@workspace/lib/types/drive';
import type { Label } from '@workspace/lib/types/label';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { Elysia, t } from 'elysia';
import { enforceAvatarUpload } from '../lib/config/enforcement';
import { CARD_MAX_BYTES } from '../lib/contacts/card-store';
import { resolveContacts } from '../lib/contacts/get-contacts';
import { ApiError } from '../lib/core';
import { requireNonGuest } from '../lib/core/access';
import { contentDisposition, readBoundedBodyBytes, setCacheHeaders } from '../lib/core/http';
import { NOT_A_VCARD_FILE, VCARD_IMPORT_MAX_CARDS } from '../lib/core/transfer';
import { readImportSourceBytes } from '../lib/drive';
import { parseVCardLines, unescapeText } from '../lib/vcard';
import { betterAuth } from './auth';
import { importFromDriveSchema } from './shared-schemas';

// Field bounds in front of the card ceiling. TEXT is for the ids and keys Eigen mints; everything a CardDAV
// PUT may store caps at the resource ceiling itself, or the card a device wrote would be uneditable here.
const TEXT = { maxLength: 512 };
const FREE_TEXT = { maxLength: CARD_MAX_BYTES };
// An address, an email, a phone or a category is one line of the file, and a file holds no more lines than it holds bytes.
const LINES = { maxItems: CARD_MAX_BYTES };

// Every ADR component is free text the card spells.
const AddressSchema = t.Object({
    street: t.Optional(t.String(FREE_TEXT)),
    city: t.Optional(t.String(FREE_TEXT)),
    state: t.Optional(t.String(FREE_TEXT)),
    zipCode: t.Optional(t.String(FREE_TEXT)),
    country: t.Optional(t.String(FREE_TEXT)),
});

// The client-writable fields — the create body. The id and the etag are the server's to assign. A BDAY is
// normalized to YYYY-MM-DD on both write paths and an avatar is the server's own cache name, so both stay
// on TEXT; an EMAIL is stored as the card spells it, never against an address grammar.
const CreateContactSchema = t.Object({
    firstName: t.String(FREE_TEXT),
    lastName: t.String(FREE_TEXT),
    email: t.Array(t.String(FREE_TEXT), LINES),
    phone: t.Array(t.String(FREE_TEXT), LINES),
    company: t.Optional(t.String(FREE_TEXT)),
    jobTitle: t.Optional(t.String(FREE_TEXT)),
    address: t.Optional(t.Array(AddressSchema, LINES)),
    birthday: t.Optional(t.String(TEXT)),
    notes: t.Optional(t.String(FREE_TEXT)),
    avatar: t.Optional(t.String(TEXT)),
    labels: t.Optional(t.Array(t.String(TEXT), LINES)),
    eigenId: t.Optional(t.String(TEXT)),
});

// The update body: the same fields plus the etag the client loaded, required by the schema so a write that
// carries no precondition is refused before any handler runs (UpdateContactInput).
const UpdateContactSchema = t.Object({
    ...CreateContactSchema.properties,
    etag: t.String({ ...TEXT, minLength: 1 }),
});

// A label is minted from a card's CATEGORIES, which the file spells however long; the color is Eigen's own.
const LabelSchema = t.Object({
    id: t.Optional(t.String(TEXT)),
    name: t.String(FREE_TEXT),
    color: t.String(TEXT),
});

// All contacts routes require ownerId === user.id (contacts are personal-only, no shared access)
export const contactsRouter = new Elysia({ name: 'contacts' })
    .use(betterAuth)
    .get(
        '/contacts/:ownerId/contacts',
        async ({ params, user }): Promise<Contact[]> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.getContacts();
        },
        { auth: true },
    )
    .get(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, user }): Promise<Contact | null> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.getContactById(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/contacts',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.addContact(body);
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
            const contacts = await resolveContacts(user, params.ownerId);
            await contacts.updateContact(params.id, body, body.etag);
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
            const contacts = await resolveContacts(user, params.ownerId);
            await contacts.deleteContact(params.id, query.etag);
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
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.getLabels();
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/labels',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.addLabel(body);
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
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.updateLabel(params.id, body);
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
            const contacts = await resolveContacts(user, params.ownerId);
            await contacts.deleteLabel(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/avatar',
        async ({ params, body, user }): Promise<string> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            await enforceAvatarUpload(user.id, body.file.size);
            return await contacts.uploadAvatar(body.file);
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
            const contacts = await resolveContacts(user, params.ownerId);
            const data = await contacts.downloadAvatar(params.filename);
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
            const contacts = await resolveContacts(user, params.ownerId);
            return await contacts.getMe();
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/export',
        async ({ params, body, user, set }): Promise<string> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            const text = await contacts.exportCards(body.ids);
            // A one-card export is named after the card itself — its FN, the display name every client
            // writes — a multi-card one generically. contentDisposition sanitizes whatever comes back
            // before it reaches the header; the clamp keeps one absurd FN from filling it.
            let fileName = 'contacts.vcf';
            if (body.ids?.length === 1) {
                const fn = parseVCardLines(text).find((line) => line.name === 'FN');
                const name = fn ? unescapeText(fn.value).trim().slice(0, 200) : '';
                fileName = `${name || 'contact'}.vcf`;
            }
            set.headers['Content-Type'] = VCARD_CONTENT_TYPE;
            set.headers['Content-Disposition'] = contentDisposition('attachment', fileName);
            return text;
        },
        {
            // The same card-count ceiling the import side enforces: one selection can't outgrow one file.
            body: t.Object({ ids: t.Optional(t.Array(t.String(TEXT), { maxItems: VCARD_IMPORT_MAX_CARDS })) }),
            auth: true,
        },
    )
    .post(
        '/contacts/:ownerId/import',
        async ({ params, request, user, server }): Promise<ImportCountsResult> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            // A whole book replays card by card through the CardDAV write seam, answering nothing until the
            // last one lands — longer than any server-wide idleTimeout, so exempt this request.
            server?.timeout(request, 0);
            const bytes = await readBoundedBodyBytes(request, VCARD_MAX_BYTES);
            if (bytes === null) throw new ApiError(413, 'Upload too large');
            return await contacts.importCards(bytes);
        },
        { auth: true, parse: 'none' },
    )
    .post(
        '/contacts/:ownerId/import-from-drive',
        async ({ params, body, request, user, server }): Promise<ImportCountsResult> => {
            requireNonGuest(user);
            const contacts = await resolveContacts(user, params.ownerId);
            // Same idle-timeout exemption as the raw import route: silent until the last card lands.
            server?.timeout(request, 0);
            const bytes = await readImportSourceBytes(user, body, {
                accepts: isVCardFile,
                rejection: NOT_A_VCARD_FILE,
                maxBytes: VCARD_MAX_BYTES,
            });
            return await contacts.importCards(bytes);
        },
        {
            body: importFromDriveSchema,
            auth: true,
        },
    );
