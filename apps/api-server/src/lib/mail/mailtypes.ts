export * from "./mail-parser";

import type {ParsedMail} from "./mail-parser";

export type EmailSummary = {
    id: string;
    subject: string;
    fromShort: string;
    textShort: string;
    date: Date;
    isRead: boolean;
    isStarred: boolean;
    isDraft: boolean;
    hasAttachments: boolean;
    mailbox: string;

    _isParsed: boolean;
};

export type Email = ParsedMail & EmailSummary;

export interface MaildirMailbox {
    path: string;
    name: string;
    delimiter: string;
    flags: string[];
    total: number;
    unread: number;
}