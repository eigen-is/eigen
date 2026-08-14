import { Elysia, t } from 'elysia';
import { enforceAvatarUpload } from '../lib/config/enforcement';
import { getContacts } from '../lib/contacts/contacts';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { setCacheHeaders } from '../lib/core/http';
import { betterAuth } from './auth';

const AddressSchema = t.Object({
    street: t.Optional(t.String()),
    city: t.Optional(t.String()),
    state: t.Optional(t.String()),
    zipCode: t.Optional(t.String()),
    country: t.Optional(t.String()),
});

const ContactSchema = t.Object({
    id: t.Optional(t.String()),
    firstName: t.String(),
    lastName: t.String(),
    email: t.Array(t.String()),
    phone: t.Array(t.String()),
    company: t.Optional(t.String()),
    jobTitle: t.Optional(t.String()),
    address: t.Optional(t.Array(AddressSchema)),
    birthday: t.Optional(t.String()),
    notes: t.Optional(t.String()),
    avatar: t.Optional(t.String()),
    labels: t.Optional(t.Array(t.String())),
    eigenId: t.Optional(t.String()),
    // Optional in the schema so POST (create) can omit it; PUT enforces its presence in the handler.
    etag: t.Optional(t.String()),
});

const LabelSchema = t.Object({
    id: t.Optional(t.String()),
    name: t.String(),
    color: t.String(),
});

// All contacts routes require ownerId === user.id (contacts are personal-only, no shared access)
export const contactsRouter = new Elysia({ name: 'contacts' })
    .use(betterAuth)
    .get(
        '/contacts/:ownerId/contacts',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getContacts();
        },
        { auth: true },
    )
    .get(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getContactById(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/contacts',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).addContact(body);
        },
        {
            body: ContactSchema,
            auth: true,
        },
    )
    .put(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            if (!body.etag) throw new ApiError(400, 'etag is required');
            return await (await getContacts(user)).updateContact(params.id, body, body.etag);
        },
        {
            body: ContactSchema,
            auth: true,
        },
    )
    .delete(
        '/contacts/:ownerId/contacts/:id',
        async ({ params, query, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).deleteContact(params.id, query.etag);
        },
        {
            query: t.Object({ etag: t.String() }),
            auth: true,
        },
    )
    .get(
        '/contacts/:ownerId/labels',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getLabels();
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/labels',
        async ({ params, body, user }) => {
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
        async ({ params, body, user }) => {
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
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).deleteLabel(params.id);
        },
        { auth: true },
    )
    .post(
        '/contacts/:ownerId/avatar',
        async ({ params, body, user }) => {
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
        async ({ params, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const data = await (await getContacts(user)).downloadAvatar(params.filename);
            if (!data) throw new ApiError(404, 'Avatar not found');
            setCacheHeaders(set, 900);
            set.headers['Content-Type'] = 'image/webp';
            return new Response(data);
        },
        { auth: true },
    )
    .get(
        '/contacts/:ownerId/me',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getContacts(user)).getMe();
        },
        { auth: true },
    );
