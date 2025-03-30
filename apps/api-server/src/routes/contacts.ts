// user middleware (compute user and session and pass to routes)
import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {type Contact} from "../types/contact";
import {type Label} from "../types/label";
import {type User} from "better-auth";
import {getContacts} from "../lib/contacts/contacts.ts";

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
    });
