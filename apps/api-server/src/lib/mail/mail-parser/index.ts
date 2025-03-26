// Re-export the types from the index.d.ts file
export type {
    ParsedMail,
    Attachment,
    AttachmentCommon,
    AttachmentStream,
    AddressObject,
    EmailAddress,
    Headers,
    HeaderLines,
    StructuredHeader
} from './index.d';

// Import the default export from simple-parser.js and re-export it as simpleParser
// @ts-ignore - Ignoring the lack of type definitions for the simple-parser module
import simpleParserDefault from './simple-parser';

export const simpleParser = simpleParserDefault;
