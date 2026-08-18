import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { enforceAvatarUpload } from '../lib/config/enforcement';
import { CARD_MAX_BYTES } from '../lib/contacts/card-store';
import { getContacts } from '../lib/contacts/contacts';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { setCacheHeaders } from '../lib/core/http';
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
    );
