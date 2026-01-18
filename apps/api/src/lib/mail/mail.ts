import {type User} from "better-auth/types";
import type {EmailDraft} from "@workspace/lib/types/mail";
import {getUserByEmail} from "../users/users.ts";
import {getHome} from "../home/home.ts";

async function getMailClient(user: User) {
    const home = await getHome(user);
    return home.mail;
}

export async function mailboxesList(user: User) {
    const mail = await getMailClient(user);
    return await mail.mailboxesList();
}

export async function mailboxGet(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxGet(mailbox);
}

export async function mailboxCreate(user: User, mailbox: string, attributes: string[] = []) {
    const mail = await getMailClient(user);
    return await mail.mailboxCreate(mailbox, attributes);
}

export async function mailboxExists(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxExists(mailbox);
}

export async function mailboxDeliver(to: string, file: ArrayBuffer) {
    const user = await getUserByEmail(to);
    console.log('Delivering message to:', to, user, file);
    if (user) {
        const mail = await getMailClient(user);
        // convert file to string
        const message = new TextDecoder().decode(new Uint8Array(file));
        return await mail.mailboxDeliver(message);
    } else {
        return false;
    }
}

export async function messageGetFile(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageGetFile(messageId);
}

export async function messageGet(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageGet(messageId);
}

export async function messageDelete(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageDelete(messageId);
}

export async function messageMove(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageMove(messageId, targetMailbox);
}

async function messageMoveToSpecial(user: User, messageId: string, flag: string) {
    const mailboxes = await mailboxesList(user);
    const target = mailboxes.find(mailbox => mailbox.flags.includes(flag));
    if (target) {
        return await messageMove(user, messageId, target.path);
    }
}

export async function messageMoveToInbox(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Inbox');
}

export async function messageMoveToArchive(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Archive');
}

export async function messageMoveToSpam(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Junk');
}

export async function messageMoveToTrash(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Trash');
}

export async function messageCopy(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageCopy(messageId, targetMailbox);
}

export async function messageHandleDraft(user: User, mail: EmailDraft) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageHandleDraft(mail);
}

export async function messageSend(user: User, mail: EmailDraft) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageSend(mail);
}

export async function messageSetRead(user: User, messageId: string, read: boolean) {
    const mail = await getMailClient(user);
    return await mail.messageSetRead(messageId, read);
}

export async function messageGetAttachment(user: User, messageId: string, index: number) {
    const mail = await getMailClient(user);
    return await mail.messageGetAttachment(messageId, index);
}
