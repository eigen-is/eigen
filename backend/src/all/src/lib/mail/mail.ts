import {User} from "better-auth/types";
import imap from "./imap";

export async function getMailboxes(user: User) {
    const mail = new imap(user);
    await mail.init();
    const {mailboxes} = await mail.mailboxes_list();
    return mailboxes;
}

