// Hard caps on one outgoing message. The reference cap is also enforced in the composer, so a
// 21st linked document is refused before it 422s every save; the recipient cap is a 400 at send.
export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;

// Length of the list preview (`EmailSummary.textShort`) as stored for drafts and as served by the list route.
export const MAIL_PREVIEW_CHARS = 200;

// One whole `.eml`, shared FE/BE: the preview guard and the import refuse a bigger file. The same 25 MiB
// a single outgoing attachment is capped at (config/enforcement.ts), which is what a message of this size
// would be made of — a separate fact, so a separate constant.
export const EML_MAX_BYTES = 25 * 1024 * 1024;

// What one `.eml` preview may carry. The parser bounds none of them: it leaves the body unbounded and
// copies an inlined `cid:` image once per reference, so the builder is where the payload is bounded.
export const EML_PREVIEW_MAX_ATTACHMENTS = 50;
export const EML_PREVIEW_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const EML_PREVIEW_MAX_INLINE_BYTES = 5 * 1024 * 1024;
// A character count, like the parser's own body ceilings (mail-parser/html.ts).
export const EML_PREVIEW_MAX_TEXT_CHARS = 1024 * 1024;
