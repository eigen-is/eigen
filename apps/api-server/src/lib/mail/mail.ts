import {type User} from "better-auth/types";
import Maildir from "./maildir";

async function getMailClient(user: User) {
    const mail = new Maildir(user);
    await mail.init();

    return mail;
}


export async function mailboxesList(user: User) {
    const mail = await getMailClient(user);
    return await mail.mailboxesList();
}

export async function getMailbox(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxGet(mailbox);
}