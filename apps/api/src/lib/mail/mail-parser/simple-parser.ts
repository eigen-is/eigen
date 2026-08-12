import type { Readable } from 'node:stream';
import type { Attachment, HeaderValue, ParsedMail } from '@workspace/lib/types/mail';
import type { AttachmentStream, MailParserOptions } from './mail-parser';
import MailParser from './mail-parser';

export type Source = Buffer | Readable | string;
export type SimpleParserOptions = MailParserOptions;

type SimpleParserCallback = (err: Error | null, mail: ParsedMail) => void;

function simpleParser(source: Source, callback: SimpleParserCallback): void;
function simpleParser(source: Source, options: SimpleParserOptions, callback: SimpleParserCallback): void;
function simpleParser(source: Source, options?: SimpleParserOptions): Promise<ParsedMail>;
function simpleParser(
    source: Source,
    optionsOrCallback?: SimpleParserOptions | SimpleParserCallback,
    maybeCallback?: SimpleParserCallback,
): Promise<ParsedMail> | undefined {
    if (source === null || source === undefined) {
        throw new TypeError('Input cannot be null or undefined.');
    }

    let callback = maybeCallback;
    let options: SimpleParserOptions;

    if (!callback && typeof optionsOrCallback === 'function') {
        callback = optionsOrCallback;
        options = {};
    } else {
        options = (optionsOrCallback as SimpleParserOptions) || {};
    }

    let promise: Promise<ParsedMail> | undefined;
    if (!callback) {
        promise = new Promise<ParsedMail>((resolve, reject) => {
            callback = (err, mail) => (err ? reject(err) : resolve(mail));
        });
    }

    const cb = callback!;
    const keepCidLinks = !!options.keepCidLinks;

    const mail: Record<string, unknown> & { attachments: Attachment[] } = {
        attachments: [],
    };

    const parser = new MailParser(options);

    parser.on('error', (err: Error) => {
        cb(err, mail as unknown as ParsedMail);
    });

    parser.on('headers', (headers: Map<string, HeaderValue>) => {
        mail['headers'] = headers;
        mail['headerLines'] = parser.headerLines;
    });

    let reading = false;
    const reader = (): void => {
        reading = true;

        const data = parser.read() as
            | AttachmentStream
            | { type: 'text'; html?: string | boolean; text?: string; textAsHtml?: string }
            | null;
        if (data === null) {
            reading = false;
            return;
        }

        if (data.type === 'text') {
            for (const key of ['text', 'html', 'textAsHtml'] as const) {
                if (key in data) {
                    mail[key] = data[key];
                }
            }
        }

        if (data.type === 'attachment') {
            const att = data as AttachmentStream;
            mail.attachments.push(att as unknown as Attachment);

            const chunks: Buffer[] = [];
            let chunklen = 0;

            att.content.on('readable', () => {
                let chunk: Buffer | null;
                while ((chunk = att.content.read() as Buffer | null) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            att.content.on('end', () => {
                (att as unknown as Record<string, unknown>)['content'] = Buffer.concat(chunks, chunklen);
                att.release();
                reader();
            });
        } else {
            reader();
        }
    };

    parser.on('readable', () => {
        if (!reading) reader();
    });

    parser.on('end', () => {
        const headerKeys = [
            'subject',
            'references',
            'date',
            'to',
            'from',
            'to',
            'cc',
            'bcc',
            'message-id',
            'in-reply-to',
            'reply-to',
        ];
        const headers = mail['headers'] as Map<string, HeaderValue> | undefined;
        if (headers) {
            for (const key of headerKeys) {
                if (headers.has(key)) {
                    mail[key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = headers.get(key);
                }
            }
        }

        if (keepCidLinks) {
            return cb(null, mail as unknown as ParsedMail);
        }

        parser.updateImageLinks(
            (attachment, done) => {
                const content = attachment.content as Buffer | null;
                if (!content) return done(null, '');
                done(null, `data:${attachment.contentType};base64,${content.toString('base64')}`);
            },
            (err, html) => {
                if (err) return cb(err, mail as unknown as ParsedMail);
                mail['html'] = html;
                cb(null, mail as unknown as ParsedMail);
            },
        );
    });

    if (typeof source === 'string') {
        parser.end(Buffer.from(source));
    } else if (Buffer.isBuffer(source)) {
        parser.end(source);
    } else {
        (source as Readable)
            .once('error', (err: Error) => {
                (source as Readable).destroy();
                parser.destroy();
                cb(err, mail as unknown as ParsedMail);
            })
            .pipe(parser);
    }

    return promise;
}

export default simpleParser;
