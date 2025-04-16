// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {type Contact} from "../types/contact";
import {type Label} from "../types/label";
import {type User} from "better-auth";
import {getContacts} from "../lib/contacts/contacts";

type AvatarBody = {
    file: File;
}

export const contactsRouter = new Elysia({name: "contacts"})
    .use(betterAuth)
    .get("/contacts/contacts", async ({user}) => await (await getContacts(user)).getContacts(), {
        auth: true
    })
    .get("/contacts/contacts/:id", async ({params, user}: {
        params: { id: string },
        user: User
    }) => await (await getContacts(user)).getContactById(params.id), {
        auth: true
    })
    .post("/contacts/contacts", async ({body, user}: {
        body: Contact,
        user: User
    }) => await (await getContacts(user)).addContact(body), {
        auth: true
    })
    .put("/contacts/contacts/:id", async ({params, body, user}: {
        params: { id: string },
        body: Contact,
        user: User
    }) => await (await getContacts(user)).updateContact(params.id, body), {
        auth: true
    })
    .delete("/contacts/contacts/:id", async ({params, user}: {
        params: { id: string },
        user: User
    }) => await (await getContacts(user)).deleteContact(params.id), {
        auth: true
    })
    .get("/contacts/labels", async ({user}) => await (await getContacts(user)).getLabels(), {
        auth: true
    })
    .post("/contacts/labels", async ({body, user}: {
        body: Label,
        user: User
    }) => await (await getContacts(user)).addLabel(body), {
        auth: true
    })
    .put("/contacts/labels/:id", async ({params, body, user}: {
        params: { id: string },
        body: Label,
        user: User
    }) => await (await getContacts(user)).updateLabel(params.id, body), {
        auth: true
    })
    .delete("/contacts/labels/:id", async ({params, user}: {
        params: { id: string },
        user: User
    }) => await (await getContacts(user)).deleteLabel(params.id), {
        auth: true
    })
    .post("/contacts/avatar", async ({body, user}: {
        body: AvatarBody,
        user: User
    }) => await (await getContacts(user)).uploadAvatar(body.file), {
        body: t.Object({
            file: t.File({
                format: 'image/*',
                maxSize: 15 * 1024 * 1024  // 15MB maximum file size
            })
        }),
        auth: true
    })
    .get("/contacts/avatar/:filename", async ({params, user}: {
        params: { filename: string },
        user: User
    }) => await (await getContacts(user)).downloadAvatar(params.filename), {
        auth: true
    })
    .get("/contacts/me", async ({user}) => await (await getContacts(user)).getMe(), {
        auth: true
    })