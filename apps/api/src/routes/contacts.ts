// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getContacts} from "../lib/contacts/contacts";
import {enforceAvatarUpload} from "../lib/config/enforcement";

const AddressSchema = t.Object({
    street: t.Optional(t.String()),
    city: t.Optional(t.String()),
    state: t.Optional(t.String()),
    zipCode: t.Optional(t.String()),
    country: t.Optional(t.String())
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
    eigenId: t.Optional(t.String())
});

const LabelSchema = t.Object({
    id: t.Optional(t.String()),
    name: t.String(),
    color: t.String()
});

export const contactsRouter = new Elysia({name: "contacts"})
    .use(betterAuth)
    .get("/contacts/:ownerId/contacts", async ({user}) => await (await getContacts(user)).getContacts(), {
        auth: true
    })
    .get("/contacts/:ownerId/contacts/:id", async ({
                                                       params,
                                                       user
                                                   }) => await (await getContacts(user)).getContactById(params.id), {
        auth: true
    })
    .post("/contacts/:ownerId/contacts", async ({body, user}) => await (await getContacts(user)).addContact(body), {
        body: ContactSchema,
        auth: true
    })
    .put("/contacts/:ownerId/contacts/:id", async ({
                                                       params,
                                                       body,
                                                       user
                                                   }) => await (await getContacts(user)).updateContact(params.id, body), {
        body: ContactSchema,
        auth: true
    })
    .delete("/contacts/:ownerId/contacts/:id", async ({
                                                          params,
                                                          user
                                                      }) => await (await getContacts(user)).deleteContact(params.id), {
        auth: true
    })
    .get("/contacts/:ownerId/labels", async ({user}) => await (await getContacts(user)).getLabels(), {
        auth: true
    })
    .post("/contacts/:ownerId/labels", async ({body, user}) => await (await getContacts(user)).addLabel(body), {
        body: LabelSchema,
        auth: true
    })
    .put("/contacts/:ownerId/labels/:id", async ({
                                                     params,
                                                     body,
                                                     user
                                                 }) => await (await getContacts(user)).updateLabel(params.id, body), {
        body: LabelSchema,
        auth: true
    })
    .delete("/contacts/:ownerId/labels/:id", async ({
                                                        params,
                                                        user
                                                    }) => await (await getContacts(user)).deleteLabel(params.id), {
        auth: true
    })
    .post("/contacts/:ownerId/avatar", async ({body, user}) => {
        await enforceAvatarUpload(user.id, body.file.size);
        return await (await getContacts(user)).uploadAvatar(body.file);
    }, {
        body: t.Object({
            file: t.File({format: 'image/*'})
        }),
        auth: true
    })
    .get("/contacts/:ownerId/avatar/:filename", async ({params, user, set}) => {
        try {
            const data = await (await getContacts(user)).downloadAvatar(params.filename);
            set.headers['Cache-Control'] = 'public, max-age=900';
            set.headers['Expires'] = new Date(Date.now() + 900000).toUTCString();
            set.headers['Content-Type'] = 'image/webp';
            return new Response(data);
        } catch (e) {
            set.status = 404;
            return null;
        }
    }, {
        auth: true
    })
    .get("/contacts/:ownerId/me", async ({user}) => await (await getContacts(user)).getMe(), {
        auth: true
    })