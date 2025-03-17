// user middleware (compute user and session and pass to routes)
import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {getContacts, getContactById, addContact, updateContact, deleteContact, getContactLabels, addContactLabel, updateContactLabel, deleteContactLabel} from "../lib/contacts/contacts";

export const contactsRouter = new Elysia({name: "contacts"})
    .use(betterAuth)
    .get("/contacts/contacts", async ({user}) => await getContacts(user), {
        auth: true
    })
    .get("/contacts/contacts/:id", async ({params, user}) => await getContactById(user, params.id), {
        auth: true
    })
    .post("/contacts/contacts", async ({body, user}) => await addContact(user, body), {
        auth: true
    })
    .put("/contacts/contacts/:id", async ({params, body, user}) => await updateContact(user, params.id, body), {
        auth: true
    })
    .delete("/contacts/contacts/:id", async ({params, user}) => await deleteContact(user, params.id), {
        auth: true
    })
    .get("/contacts/labels", async ({user}) => await getContactLabels(user), {
        auth: true
    })
    .post("/contacts/labels", async ({body, user}) => await addContactLabel(user, body), {
        auth: true
    })
    .put("/contacts/labels/:id", async ({params, body, user}) => await updateContactLabel(user, params.id, body), {
        auth: true
    })
    .delete("/contacts/labels/:id", async ({params, user}) => await deleteContactLabel(user, params.id), {
        auth: true
    })