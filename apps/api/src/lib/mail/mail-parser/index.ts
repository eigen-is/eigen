export type {
    AddressObject,
    Attachment,
    AttachmentCommon,
    AttachmentStream,
    EmailAddress,
    HeaderLines,
    Headers,
    HeaderValue,
    MailParserOptions,
    MessageText,
    ParsedMail,
    StructuredHeader,
} from './mail-parser';

export { default as MailParser } from './mail-parser';
export type { SimpleParserOptions, Source } from './simple-parser';
export { default as simpleParser } from './simple-parser';
