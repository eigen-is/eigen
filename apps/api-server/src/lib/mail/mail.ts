import {User} from "better-auth/types";
import imap from "./imap";

async function getMailClient(user: User) {
    const mail = new imap(user);
    await mail.login();

    // check if all mailboxes needed are created
    await mail.create_tables();
    await mail.mailboxes_create('INBOX', []);
    await mail.mailboxes_create('[EigenMail]', ['\\NOSELECT']);
    await mail.mailboxes_create('[Eigen]/All Mail', ['\\All']);
    await mail.mailboxes_create('[Eigen]/Drafts', ['\\Drafts']);
    await mail.mailboxes_create('[Eigen]/Sent Mail', ['\\Sent']);
    await mail.mailboxes_create('[Eigen]/Spam', ['\\Junk']);
    await mail.mailboxes_create('[Eigen]/Starred', ['\\Flagged']);
    await mail.mailboxes_create('[Eigen]/Trash', ['\\Trash']);

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