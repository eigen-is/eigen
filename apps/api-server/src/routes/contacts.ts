// user middleware (compute user and session and pass to routes)
import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {
    addContact,
    addContactLabel,
    deleteContact,
    deleteContactLabel,
    getContactById,
    getContactLabels,
    getContacts,
    updateContact,
    updateContactLabel
} from "../lib/contacts/contacts";
import {type Contact} from "../types/contact";
import {type Label} from "../types/label";
import {type User} from "better-auth";

export const contactsRouter = new Elysia({name: "contacts"})
    .use(betterAuth)
    .get("/contacts/contacts", async ({user}) => await getContacts(user), {
        auth: true
    })
    .get("/contacts/contacts/:id", async ({params, user} : {params: {id: string}, user: User}) => await getContactById(user, params.id), {
        auth: true
    })
    .post("/contacts/contacts", async ({body, user} : {body: Contact, user: User}) => await addContact(user, body), {
        auth: true
    })
    .put("/contacts/contacts/:id", async ({params, body, user} : {params: {id: string}, body: Contact, user: User}) => await updateContact(user, params.id, body), {
        auth: true
    })
    .delete("/contacts/contacts/:id", async ({params, user} : {params: {id: string}, user: User}) => await deleteContact(user, params.id), {
        auth: true
    })
    .get("/contacts/labels", async ({user}) => await getContactLabels(user), {
        auth: true
    })
    .post("/contacts/labels", async ({body, user} : {body: Label, user: User}) => await addContactLabel(user, body), {
        auth: true
    })
    .put("/contacts/labels/:id", async ({params, body, user} : {params: {id: string}, body: Label, user: User}) => await updateContactLabel(user, params.id, body), {
        auth: true
    })
    .delete("/contacts/labels/:id", async ({params, user} : {params: {id: string}, user: User}) => await deleteContactLabel(user, params.id), {
        auth: true
    })