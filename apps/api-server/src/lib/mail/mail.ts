import {type User} from "better-auth/types";
import imap from "./imap";

async function getMailClient(user: User) {
    const mail = new imap(user);
    await mail.login();

    return mail;
}


export async function getMailboxes(user: User) {
    const mail = await getMailClient(user);
    return await mail.mailboxes_list();
}

export async function getMailbox(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return mail.messages_fetch(mailbox);
}