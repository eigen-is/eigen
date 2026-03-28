export type {
    ParsedMail,
    Attachment,
    AttachmentCommon,
    AttachmentStream,
    AddressObject,
    EmailAddress,
    Headers,
    HeaderLines,
    HeaderValue,
    StructuredHeader,
    MessageText,
    MailParserOptions,
} from './mail-parser';

export { default as MailParser } from './mail-parser';
export { default as simpleParser } from './simple-parser';
export type { Source, SimpleParserOptions } from './simple-parser';
