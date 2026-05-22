export type MailSearchHit = {
    kind: 'mail';
    id: string;
    subject: string;
    from: string;
    mailbox: string;
    date: Date;
};

export type SearchResponse = {
    mail: MailSearchHit[];
};
