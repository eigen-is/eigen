/// <reference path="../mail-modules.d.ts" />

import type { Readable } from 'node:stream';
import { Transform, type TransformCallback, type TransformOptions } from 'node:stream';
import type { ImipMethod } from '@workspace/lib/types/calendar';
import type {
    AddressObject,
    Attachment,
    HeaderLines,
    HeaderValue,
    MailHeaders,
    StructuredHeader,
} from '@workspace/lib/types/mail';
import encodingJapanese from 'encoding-japanese';
import he from 'he';
import { htmlToText } from 'html-to-text';
import iconv from 'iconv-lite';
import libmime from 'libmime';
import LinkifyIt from 'linkify-it';
import addressparser from 'nodemailer/lib/addressparser';
import punycode from 'punycode.js';
import tlds from 'tlds';
import FlowedDecoder from '../mail-split/flowed-decoder';
import Splitter from '../mail-split/message-splitter';
import StreamHash from './stream-hash';

// htmlToText runs synchronously at ~70-90 ms/MB on the shared event loop, on every message
// open and every cold-index/sync pass — a multi-MB HTML body is a DoS lever. Bound its input
// so the work is capped; the rendered html body stays whole (email readable), only the derived
// plaintext is cut off past the cap.
const MAX_HTML_TEXT_LENGTH = 2 * 1024 * 1024;

const linkify = new LinkifyIt();

linkify
    .tlds(tlds)
    .tlds('onion', true)
    .add('git:', 'http:')
    .add('ftp:', null)
    .set({ fuzzyIP: true, fuzzyLink: true, fuzzyEmail: true });

linkify.add('@', {
    validate(text: string, pos: number, self: LinkifyIt) {
        const tail = text.slice(pos);
        const re = self.re as Record<string, RegExp>;

        if (!re['bluesky']) {
            re['bluesky'] = new RegExp(`^([a-zA-Z0-9_][a-zA-Z0-9._-]*[a-zA-Z0-9])(?=$|${re['src_ZPCc']})`);
        }
        if (re['bluesky'].test(tail)) {
            if (pos >= 2 && tail[pos - 2] === '@') {
                return false;
            }
            return tail.match(re['bluesky'])![0].length;
        }
        return 0;
    },
    normalize(match: { url: string }) {
        match.url = `https://bsky.app/profile/${match.url.replace(/^@/, '')}`;
    },
});

// --- Exported types ---
// The shared mail types (StructuredHeader, HeaderValue, HeaderLines, EmailAddress, AddressObject,
// Attachment, ParsedMail, MailHeaders) live in @workspace/lib/types/mail.

// The streaming attachment the parser emits before its content is buffered into an Attachment.
export type AttachmentStream = Omit<Attachment, 'content'> & {
    content: Readable;
    release(): void;
};

export type MessageText = {
    type: 'text';
    html?: string | boolean;
    text?: string;
    textAsHtml?: string;
};

export type MailParserOptions = TransformOptions & {
    skipHtmlToText?: boolean;
    maxHtmlLengthToParse?: number;
    formatDateString?: (d: Date) => string;
    skipImageLinks?: boolean;
    skipTextToHtml?: boolean;
    skipTextLinks?: boolean;
    Iconv?: unknown;
    keepCidLinks?: boolean;
    keepDeliveryStatus?: boolean;
    checksumAlgo?: string;
};

// --- Internal types ---

type ParsedAddress = {
    address?: string;
    name: string;
    group?: ParsedAddress[];
};

type Decoder = {
    decodeStream(charset: string): Transform;
};

type MimeTreeNode = {
    node: SplitterNode;
    headerLines: HeaderLines;
    headers: MailHeaders;
    contentType: string;
    children: MimeTreeNode[];
    disposition?: string;
    isAttachment?: boolean;
    encoding?: string;
    charset?: string;
    decoder?: Transform;
    root?: boolean;
    parent?: MimeTreeNode;
    contentStream?: Transform | Readable;
    textContent?: string;
    showMeta?: boolean;
};

type SplitterNode = {
    contentType: string;
    disposition?: string;
    encoding?: string;
    charset?: string;
    root?: boolean;
    headers: {
        lines: HeaderLines;
        getList(): Array<{ key: string; line: string }>;
    };
    getDecoder(): Transform;
    parentNode?: SplitterNode;
    messageNode?: boolean;
    filename?: string;
    flowed?: boolean;
    delSp?: boolean;
};

type SplitterChunk = {
    type: 'node' | 'data' | 'body';
    _parentBoundary?: string;
    value?: Buffer;
    contentType?: string;
    disposition?: string;
    encoding?: string;
    charset?: string;
    root?: boolean;
    headers?: {
        lines: HeaderLines;
        getList(): Array<{ key: string; line: string }>;
    };
    getDecoder?: () => Transform;
    parentNode?: SplitterNode;
    messageNode?: boolean;
    filename?: string;
    flowed?: boolean;
    delSp?: boolean;
};

type InternalAttachment = {
    type: 'attachment';
    content: Transform | null;
    contentType: string;
    partId: string | null;
    contentDisposition?: string;
    filename?: string;
    contentId?: string;
    cid?: string;
    related?: boolean;
    headers?: MailHeaders;
    checksum: string;
    size: number;
    release: (() => void) | null;
    calendarMethod?: ImipMethod;
};

type BoundaryEntry = {
    name: string;
    count: number;
};

type CidEntry = {
    attachment: InternalAttachment;
    url?: string;
};

// --- Decoder classes ---

class IconvDecoder extends Transform {
    private stream: Transform;
    private endCb: TransformCallback | null;

    constructor(Iconv: unknown, charset: string) {
        super();

        if (charset.toLowerCase() === 'ks_c_5601-1987') {
            charset = 'CP949';
        }
        this.stream = new (Iconv as new (from: string, to: string) => Transform)(charset, 'UTF-8//TRANSLIT//IGNORE');

        this.endCb = null;

        this.stream.on('error', (err: Error) => this.emit('error', err));
        this.stream.on('data', (chunk: Buffer) => this.push(chunk));
        this.stream.on('end', () => {
            if (typeof this.endCb === 'function') {
                this.endCb();
            }
        });
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        this.stream.write(chunk);
        done();
    }

    _flush(done: TransformCallback): void {
        this.endCb = done;
        this.stream.end();
    }
}

class JPDecoder extends Transform {
    private charset: string;
    private chunks: Buffer[];
    private chunklen: number;

    constructor(charset: string) {
        super();

        this.charset = charset;
        this.chunks = [];
        this.chunklen = 0;
    }

    _transform(chunk: Buffer | string, encoding: BufferEncoding, done: TransformCallback): void {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        this.chunks.push(chunk);
        this.chunklen += chunk.length;
        done();
    }

    _flush(done: TransformCallback): void {
        const input = Buffer.concat(this.chunks, this.chunklen);
        try {
            let output: string | Buffer = encodingJapanese.convert(input, {
                to: 'UNICODE',
                from: this.charset,
                type: 'string',
            }) as string;
            if (typeof output === 'string') {
                output = Buffer.from(output);
            }
            this.push(output);
        } catch (_err) {
            this.push(input);
        }

        done();
    }
}

// --- Main MailParser class ---

class MailParser extends Transform {
    options: MailParserOptions;
    splitter: InstanceType<typeof Splitter>;
    finished: boolean;
    waitingEnd: ((err?: Error) => void) | null;

    headers: MailHeaders | null;
    headerLines: HeaderLines | null;

    endReceived: boolean;
    reading: boolean;
    hasFailed: boolean;

    tree: MimeTreeNode | null;
    curnode: MimeTreeNode | null;
    waitUntilAttachmentEnd: boolean;
    attachmentCallback: (() => void) | null;

    hasHtml: boolean;
    hasText: boolean;

    text: string | null;
    html: string | null;
    textAsHtml: string | null;

    attachmentList: InternalAttachment[];
    boundaries: BoundaryEntry[];
    textTypes: string[];
    decoder: Decoder;
    decoderEnded?: boolean;

    libmime: InstanceType<(typeof libmime)['Libmime']>;

    constructor(config?: MailParserOptions) {
        super({
            readableObjectMode: true,
            writableObjectMode: false,
        });

        this.options = config || {};
        this.splitter = new Splitter(config);
        this.finished = false;
        this.waitingEnd = null;

        this.headers = null;
        this.headerLines = null;

        this.endReceived = false;
        this.reading = false;
        this.hasFailed = false;

        this.tree = null;
        this.curnode = null;
        this.waitUntilAttachmentEnd = false;
        this.attachmentCallback = null;

        this.hasHtml = false;
        this.hasText = false;

        this.text = null;
        this.html = null;
        this.textAsHtml = null;

        this.attachmentList = [];

        this.boundaries = [];

        this.textTypes = ['text/plain', 'text/html'].concat(
            !this.options.keepDeliveryStatus ? 'message/delivery-status' : [],
        );

        this.decoder = this.getDecoder();

        this.splitter.on('readable', () => {
            if (this.reading) {
                return false;
            }
            this.readData();
        });

        this.splitter.on('end', () => {
            this.endReceived = true;
            if (!this.reading) {
                this.endStream();
            }
        });

        this.splitter.on('error', (err: Error) => {
            this.hasFailed = true;
            if (typeof this.waitingEnd === 'function') {
                return this.waitingEnd(err);
            }
            this.emit('error', err);
        });

        this.libmime = new libmime.Libmime({ Iconv: this.options.Iconv });
    }

    private getDecoder(): Decoder {
        if (this.options.Iconv) {
            const Iconv = this.options.Iconv;
            return {
                decodeStream(charset: string): Transform {
                    return new IconvDecoder(Iconv, charset);
                },
            };
        } else {
            return {
                decodeStream(charset: string): Transform {
                    charset = (charset || 'ascii').toString().trim().toLowerCase();
                    if (/^jis|^iso-?2022-?jp|^EUCJP/i.test(charset)) {
                        return new JPDecoder(charset);
                    }

                    return iconv.decodeStream(charset) as unknown as Transform;
                },
            };
        }
    }

    private readData(): void {
        if (this.hasFailed) {
            return;
        }
        this.reading = true;
        const data = this.splitter.read() as SplitterChunk | null;
        if (data === null) {
            this.reading = false;
            if (this.endReceived) {
                this.endStream();
            }
            return;
        }

        this.processChunk(data, (err?: Error) => {
            if (err) {
                if (typeof this.waitingEnd === 'function') {
                    return this.waitingEnd(err);
                }
                return this.emit('error', err);
            }
            process.nextTick(() => this.readData());
        });
    }

    private endStream(): void {
        this.finished = true;

        if (this.curnode && (this.curnode as MimeTreeNode).decoder) {
            (this.curnode as MimeTreeNode).decoder!.end();
        }
        if (typeof this.waitingEnd === 'function') {
            this.waitingEnd();
        }
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        if (!chunk?.length) {
            done();
            return;
        }

        if (this.splitter.write(chunk) === false) {
            this.splitter.once('drain', done);
        } else {
            done();
        }
    }

    _flush(done: TransformCallback): void {
        process.nextTick(() => this.splitter.end());
        if (this.finished) {
            this.cleanup(done);
            return;
        }
        this.waitingEnd = () => {
            this.cleanup(() => {
                done();
            });
        };
    }

    private cleanup(done: () => void): void {
        const finish = () => {
            try {
                const t = this.getTextContent();
                this.push(t);
            } catch (_err) {
                return this.emit('error', _err);
            }

            done();
        };

        const curnode = this.curnode;
        // biome-ignore lint/complexity/useOptionalChain: TypeScript can't narrow `null | T` through optional chaining
        if (curnode && curnode.decoder?.readable && !this.decoderEnded) {
            (curnode.contentStream || curnode.decoder).once('end', () => {
                finish();
            });
            curnode.decoder.end();
        } else {
            process.nextTick(finish);
        }
    }

    private processHeaders(lines: Array<{ key: string; line: string }>): MailHeaders {
        const headers: Map<string, unknown[]> = new Map();
        for (const line of lines || []) {
            let key = line.key;
            let value: unknown = ((this.libmime.decodeHeader(line.line) || ({} as Record<string, unknown>)).value || '')
                .toString()
                .trim();
            value = Buffer.from(value as string, 'binary').toString();
            switch (key) {
                case 'content-type':
                case 'content-disposition':
                case 'dkim-signature':
                    value = this.libmime.parseHeaderValue(value as string);
                    if ((value as StructuredHeader).value) {
                        (value as StructuredHeader).value = this.libmime.decodeWords((value as StructuredHeader).value);
                    }
                    for (const pkey of Object.keys(
                        ((value as StructuredHeader) && (value as StructuredHeader).params) || {},
                    )) {
                        try {
                            (value as StructuredHeader).params[pkey] = this.libmime.decodeWords(
                                (value as StructuredHeader).params[pkey],
                            );
                        } catch (_E) {
                            // ignore, keep as is
                        }
                    }
                    break;
                case 'date': {
                    let dateValue = new Date(value as string);
                    if (Number.isNaN(dateValue.getTime())) {
                        dateValue = new Date();
                    }
                    value = dateValue;
                    break;
                }
                case 'subject':
                    try {
                        value = this.libmime.decodeWords(value as string);
                    } catch (_E) {
                        // ignore, keep as is
                    }
                    break;
                case 'references':
                    try {
                        value = this.libmime.decodeWords(value as string);
                    } catch (_E) {
                        // ignore
                    }
                    value = (value as string).split(/\s+/).map(this.ensureMessageIDFormat);
                    break;
                case 'message-id':
                case 'in-reply-to':
                    try {
                        value = this.libmime.decodeWords(value as string);
                    } catch (_E) {
                        // ignore
                    }
                    value = this.ensureMessageIDFormat(value as string);
                    break;
                case 'priority':
                case 'x-priority':
                case 'x-msmail-priority':
                case 'importance':
                    key = 'priority';
                    value = this.parsePriority(value as string);
                    break;
                case 'from':
                case 'to':
                case 'cc':
                case 'bcc':
                case 'sender':
                case 'reply-to':
                case 'delivered-to':
                case 'return-path':
                case 'disposition-notification-to':
                    value = addressparser(value as string) as ParsedAddress[];
                    this.decodeAddresses(value as ParsedAddress[]);
                    value = {
                        value,
                        html: this.getAddressesHTML(value as ParsedAddress[]),
                        text: this.getAddressesText(value as ParsedAddress[]),
                    };
                    break;
            }

            if (key.slice(0, 5) === 'list-') {
                value = this.parseListHeader(key.slice(5), value as string);
                key = 'list';
            }

            if (value) {
                if (!headers.has(key)) {
                    headers.set(key, ([] as unknown[]).concat(value || []));
                } else if (Array.isArray(value)) {
                    headers.set(key, headers.get(key)!.concat(value));
                } else {
                    headers.get(key)!.push(value);
                }
            }
        }

        const singleKeys = [
            'message-id',
            'content-id',
            'from',
            'sender',
            'in-reply-to',
            'reply-to',
            'subject',
            'date',
            'content-disposition',
            'content-type',
            'content-transfer-encoding',
            'priority',
            'mime-version',
            'content-description',
            'precedence',
            'errors-to',
            'disposition-notification-to',
        ];

        const result: MailHeaders = headers as unknown as MailHeaders;

        for (const [key, value] of headers.entries()) {
            if (Array.isArray(value)) {
                if (singleKeys.includes(key) && value.length) {
                    result.set(key, value[value.length - 1] as HeaderValue);
                } else if (value.length === 1) {
                    result.set(key, value[0] as HeaderValue);
                }
            }

            if (key === 'list') {
                const listValue: Record<string, unknown> = {};
                for (const val of ([] as unknown[]).concat(value || [])) {
                    for (const listKey of Object.keys((val as Record<string, unknown>) || {})) {
                        listValue[listKey] = (val as Record<string, unknown>)[listKey];
                    }
                }
                result.set(key, listValue as unknown as HeaderValue);
            }
        }

        return result;
    }

    private parseListHeader(key: string, value: string): Record<string, Record<string, string>> | null {
        const addresses = addressparser(value) as ParsedAddress[];
        const response: Record<string, string> = {};
        const data = addresses
            .map((address) => {
                if (/^https?:/i.test(address.name)) {
                    response['url'] = address.name;
                } else if (address.name) {
                    response['name'] = address.name;
                }
                if (address.address && /^mailto:/.test(address.address)) {
                    response['mail'] = address.address.slice(7);
                } else if (address.address && address.address.indexOf('@') < 0) {
                    response['id'] = address.address;
                } else if (address.address) {
                    response['mail'] = address.address;
                }
                if (Object.keys(response).length) {
                    return response;
                }
                return null;
            })
            .filter((address) => address);
        if (data.length) {
            return {
                [key]: response,
            };
        }
        return null;
    }

    private parsePriority(value: string): 'normal' | 'low' | 'high' {
        value = value.toLowerCase().trim();
        if (!Number.isNaN(parseInt(value, 10))) {
            const num = parseInt(value, 10) || 0;
            if (num === 3) {
                return 'normal';
            } else if (num > 3) {
                return 'low';
            } else {
                return 'high';
            }
        } else {
            switch (value) {
                case 'non-urgent':
                case 'low':
                    return 'low';
                case 'urgent':
                case 'high':
                    return 'high';
            }
        }
        return 'normal';
    }

    private ensureMessageIDFormat(value: string): string | null {
        if (!value.length) {
            return null;
        }

        if (value.charAt(0) !== '<') {
            value = `<${value}`;
        }

        if (value.charAt(value.length - 1) !== '>') {
            value += '>';
        }

        return value;
    }

    private decodeAddresses(addresses: ParsedAddress[]): void {
        const processedAddress = new WeakSet<ParsedAddress>();
        for (let i = 0; i < addresses.length; i++) {
            const address = addresses[i];
            address.name = (address.name || '').toString().trim();

            if (
                !address.address &&
                /^(=\?([^?]+)\?[Bb]\?[^?]*\?=)(\s*=\?([^?]+)\?[Bb]\?[^?]*\?=)*$/.test(address.name) &&
                !processedAddress.has(address)
            ) {
                const parsed = addressparser(this.libmime.decodeWords(address.name)) as ParsedAddress[];
                if (parsed.length) {
                    for (const entry of parsed) {
                        processedAddress.add(entry);
                        addresses.push(entry);
                    }
                }

                addresses.splice(i, 1);
                i--;
                continue;
            }

            if (address.name) {
                try {
                    address.name = this.libmime.decodeWords(address.name);
                } catch (_E) {
                    //ignore, keep as is
                }
            }
            if (address.address && /@xn--/.test(address.address)) {
                try {
                    address.address =
                        address.address.slice(0, address.address.lastIndexOf('@') + 1) +
                        punycode.toUnicode(address.address.slice(address.address.lastIndexOf('@') + 1));
                } catch (_E) {
                    // Not a valid punycode string; keep as is
                }
            }
            if (address.group) {
                this.decodeAddresses(address.group);
            }
        }
    }

    private createNode(node: SplitterChunk): MimeTreeNode {
        let contentType = node.contentType;
        const disposition = node.disposition;
        const encoding = node.encoding;
        const charset = node.charset;

        if (!contentType && node.root) {
            contentType = 'text/plain';
        }

        const newNode: MimeTreeNode = {
            node: node as unknown as SplitterNode,
            headerLines: node.headers!.lines,
            headers: this.processHeaders(node.headers!.getList()),
            contentType: contentType || '',
            children: [],
        };

        if (!/^multipart\//i.test(contentType || '')) {
            let disp = disposition;
            if (disp && !['attachment', 'inline'].includes(disp)) {
                disp = 'attachment';
            }

            if (!disp && !this.textTypes.includes(contentType || '')) {
                newNode.disposition = 'attachment';
            } else {
                newNode.disposition = disp || 'inline';
            }

            newNode.isAttachment = !this.textTypes.includes(contentType || '') || newNode.disposition !== 'inline';

            newNode.encoding = encoding && ['quoted-printable', 'base64'].includes(encoding) ? encoding : 'binary';

            if (charset) {
                newNode.charset = charset;
            }

            const decoder = node.getDecoder!();
            decoder.on('end', () => {
                this.decoderEnded = true;
            });
            newNode.decoder = decoder;
        }

        if (node.root) {
            this.headers = newNode.headers;
            this.headerLines = newNode.headerLines;
        }

        if (!this.tree) {
            newNode.root = true;
            this.curnode = this.tree = newNode;
            return newNode;
        }

        const curnode = this.curnode as MimeTreeNode;

        if (!curnode.parent) {
            newNode.parent = curnode;
            curnode.children.push(newNode);
            this.curnode = newNode;
            return newNode;
        }

        if (curnode.parent.node === (node as unknown as SplitterNode).parentNode) {
            newNode.parent = curnode.parent;
            curnode.parent.children.push(newNode);
            this.curnode = newNode;
            return newNode;
        }

        if (curnode.node === (node as unknown as SplitterNode).parentNode) {
            newNode.parent = curnode;
            curnode.children.push(newNode);
            this.curnode = newNode;
            return newNode;
        }

        let parentNode: MimeTreeNode | undefined = curnode;
        while ((parentNode = parentNode.parent)) {
            if (parentNode.node === (node as unknown as SplitterNode).parentNode) {
                newNode.parent = parentNode;
                parentNode.children.push(newNode);
                this.curnode = newNode;
                return newNode;
            }
        }

        this.curnode = newNode;
        return newNode;
    }

    private getTextContent(): MessageText {
        const text: string[] = [];
        const html: string[] = [];
        const processNode = (alternative: boolean, level: number, node: MimeTreeNode): void => {
            if (node.showMeta) {
                const metaKeys = ['From', 'Subject', 'Date', 'To', 'Cc', 'Bcc'] as const;
                type MetaKey = (typeof metaKeys)[number];
                type MetaEntry = { key: MetaKey; value: HeaderValue };

                const meta: MetaEntry[] = [];
                for (const fkey of metaKeys) {
                    if (!node.headers.has(fkey.toLowerCase())) continue;
                    const raw = node.headers.get(fkey.toLowerCase());
                    if (!raw) continue;
                    meta.push({ key: fkey, value: Array.isArray(raw) ? raw[raw.length - 1] : raw });
                }

                const formatMetaHtml = (entry: MetaEntry): string => {
                    let value: string;
                    switch (entry.key) {
                        case 'From':
                        case 'To':
                        case 'Cc':
                        case 'Bcc':
                            value = (entry.value as AddressObject).html;
                            break;
                        case 'Date':
                            value = this.options.formatDateString
                                ? this.options.formatDateString(entry.value as Date)
                                : (entry.value as Date).toUTCString();
                            break;
                        case 'Subject':
                            value = `<strong>${he.encode(entry.value as string)}</strong>`;
                            break;
                    }
                    return `<tr><td class="mp_head_key">${he.encode(entry.key)}:</td><td class="mp_head_value">${value!}<td></tr>`;
                };

                const formatMetaText = (entry: MetaEntry): string => {
                    let value: string;
                    switch (entry.key) {
                        case 'From':
                        case 'To':
                        case 'Cc':
                        case 'Bcc':
                            value = (entry.value as AddressObject).text;
                            break;
                        case 'Date':
                            value = this.options.formatDateString
                                ? this.options.formatDateString(entry.value as Date)
                                : (entry.value as Date).toUTCString();
                            break;
                        default:
                            value = entry.value as string;
                    }
                    return `${entry.key}: ${value}`;
                };

                if (this.hasHtml) {
                    html.push(`<table class="mp_head">${meta.map(formatMetaHtml).join('\n')}<table>`);
                }
                if (this.hasText) {
                    text.push(`\n${meta.map(formatMetaText).join('\n')}\n`);
                }
            }
            if (node.textContent) {
                if (node.contentType === 'text/plain') {
                    text.push(node.textContent);
                    if (!alternative && this.hasHtml) {
                        html.push(this.textToHtml(node.textContent));
                    }
                } else if (node.contentType === 'message/delivery-status' && !this.options.keepDeliveryStatus) {
                    text.push(node.textContent);
                    if (!alternative && this.hasHtml) {
                        html.push(this.textToHtml(node.textContent));
                    }
                } else if (node.contentType === 'text/html') {
                    let failedToParseHtml = false;
                    if ((!alternative && this.hasText) || (node.root && !this.hasText)) {
                        if (this.options.skipHtmlToText) {
                            text.push('');
                        } else if (
                            this.options.maxHtmlLengthToParse &&
                            node.textContent.length > this.options.maxHtmlLengthToParse
                        ) {
                            this.emit('error', new Error(`HTML too long for parsing ${node.textContent.length} bytes`));
                            text.push('Invalid HTML content (too long)');
                            failedToParseHtml = true;
                        } else {
                            try {
                                text.push(htmlToText(node.textContent.slice(0, MAX_HTML_TEXT_LENGTH)));
                            } catch (_err) {
                                this.emit('error', new Error('Failed to parse HTML'));
                                text.push('Invalid HTML content');
                                failedToParseHtml = true;
                            }
                        }
                    }
                    if (!failedToParseHtml) {
                        html.push(node.textContent);
                    }
                }
            }
            alternative = alternative || node.contentType === 'multipart/alternative';
            if (node.children) {
                for (const subNode of node.children) {
                    processNode(alternative, level + 1, subNode);
                }
            }
        };

        processNode(false, 0, this.tree as MimeTreeNode);

        const response: MessageText = {
            type: 'text',
        };
        if (html.length) {
            this.html = response.html = html.join('<br/>\n');
        }
        if (text.length) {
            this.text = response.text = text.join('\n');
            this.textAsHtml = response.textAsHtml = text.map((part) => this.textToHtml(part)).join('<br/>\n');
        }
        return response;
    }

    private processChunk(data: SplitterChunk, done: (err?: Error) => void): void {
        let partId: string | null = null;
        if (data._parentBoundary) {
            partId = this._getPartId(data._parentBoundary);
        }
        switch (data.type) {
            case 'node': {
                const node = this.createNode(data);
                if (node === this.tree) {
                    for (const key of [
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
                    ]) {
                        if (node.headers.has(key)) {
                            (this as unknown as Record<string, unknown>)[
                                key.replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase())
                            ] = node.headers.get(key);
                        }
                    }
                    this.emit('headers', node.headers);

                    if (node.headerLines) {
                        this.emit('headerLines', node.headerLines);
                    }
                }

                if (data.contentType === 'message/rfc822' && data.messageNode) {
                    break;
                }

                if (data.parentNode && data.parentNode.contentType === 'message/rfc822') {
                    node.showMeta = true;
                }

                if (node.isAttachment) {
                    let contentType = node.contentType;
                    if (node.contentType === 'application/octet-stream' && data.filename) {
                        contentType = this.libmime.detectMimeType(data.filename) || 'application/octet-stream';
                    }

                    const attachment: InternalAttachment = {
                        type: 'attachment',
                        content: null,
                        contentType,
                        partId,
                        checksum: '',
                        size: 0,
                        release: () => {
                            attachment.release = null;
                            if (this.waitUntilAttachmentEnd && typeof this.attachmentCallback === 'function') {
                                process.nextTick(this.attachmentCallback);
                            }
                            this.attachmentCallback = null;
                            this.waitUntilAttachmentEnd = false;
                        },
                    };

                    const algo = this.options.checksumAlgo || 'md5';
                    const hasher = new StreamHash(attachment, algo);
                    node.decoder!.on('error', (err: Error) => {
                        hasher.emit('error', err);
                    });

                    node.decoder!.on('readable', () => {
                        let chunk: Buffer | null;

                        while ((chunk = node.decoder!.read() as Buffer | null) !== null) {
                            hasher.write(chunk);
                        }
                    });

                    node.decoder!.once('end', () => {
                        hasher.end();
                    });

                    attachment.content = hasher;

                    this.waitUntilAttachmentEnd = true;
                    if (data.disposition) {
                        attachment.contentDisposition = data.disposition;
                    }

                    if (data.filename) {
                        attachment.filename = data.filename;
                    }

                    if (node.headers.has('content-id')) {
                        attachment.contentId = ([] as string[])
                            .concat((node.headers.get('content-id') as string | string[]) || [])
                            .shift();
                        attachment.cid = attachment.contentId!.trim().replace(/^<|>$/g, '').trim();
                        let pNode: MimeTreeNode | undefined = node;
                        while ((pNode = pNode.parent)) {
                            if (pNode.contentType === 'multipart/related') {
                                attachment.related = true;
                            }
                        }
                    }

                    attachment.headers = node.headers;

                    if (contentType.startsWith('text/calendar')) {
                        const ct = node.headers.get('content-type') as StructuredHeader | undefined;
                        const method = ct?.params?.['method'];
                        if (method) {
                            const m = method.toUpperCase();
                            if (m === 'REQUEST' || m === 'REPLY' || m === 'CANCEL') {
                                attachment.calendarMethod = m;
                            }
                        }
                    }

                    this.push(attachment);
                    this.attachmentList.push(attachment);
                } else if (node.disposition === 'inline') {
                    const chunks: Buffer[] = [];
                    let chunklen = 0;
                    node.contentStream = node.decoder;

                    if (node.contentType === 'text/plain') {
                        this.hasText = true;
                    } else if (node.contentType === 'text/html') {
                        this.hasHtml = true;
                    } else if (node.contentType === 'message/delivery-status' && !this.options.keepDeliveryStatus) {
                        this.hasText = true;
                    }

                    if ((node.node as SplitterNode).flowed) {
                        const contentStream = node.contentStream!;
                        const flowDecoder = new FlowedDecoder({
                            delSp: (node.node as SplitterNode).delSp,
                        });
                        contentStream.on('error', (err: Error) => {
                            flowDecoder.emit('error', err);
                        });
                        (contentStream as Transform).pipe(flowDecoder);
                        node.contentStream = flowDecoder;
                    }

                    const charset = node.charset || 'utf-8';

                    if (!['ascii', 'usascii', 'utf8'].includes(charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
                        try {
                            const contentStream = node.contentStream!;
                            const decodeStream = this.decoder.decodeStream(charset);
                            contentStream.on('error', (err: Error) => {
                                decodeStream.emit('error', err);
                            });
                            (contentStream as Transform).pipe(decodeStream);
                            node.contentStream = decodeStream;
                        } catch (_E) {
                            // do not decode charset
                        }
                    }

                    node.contentStream!.on('readable', () => {
                        let chunk: Buffer | string | null;
                        while (
                            (chunk = (node.contentStream as Transform & { read(): Buffer | string | null }).read()) !==
                            null
                        ) {
                            if (typeof chunk === 'string') {
                                chunk = Buffer.from(chunk);
                            }
                            chunks.push(chunk);
                            chunklen += chunk.length;
                        }
                    });

                    node.contentStream!.once('end', () => {
                        node.textContent = Buffer.concat(chunks, chunklen).toString().replace(/\r?\n/g, '\n');
                    });

                    node.contentStream!.once('error', (err: Error) => {
                        this.emit('error', err);
                    });
                }

                break;
            }

            case 'data':
                if (this.curnode && (this.curnode as MimeTreeNode).decoder) {
                    (this.curnode as MimeTreeNode).decoder!.end();
                }

                if (this.waitUntilAttachmentEnd) {
                    this.attachmentCallback = done;
                    return;
                }

                break;

            case 'body': {
                const bodyNode = this.curnode;
                // biome-ignore lint/complexity/useOptionalChain: TypeScript can't narrow `null | T` through optional chaining
                if (bodyNode && bodyNode.decoder?.writable) {
                    if (bodyNode.decoder.write(data.value!) === false) {
                        bodyNode.decoder.once('drain', done);
                        return;
                    }
                }
                break;
            }
        }

        process.nextTick(done);
    }

    private _getPartId(parentBoundary: string): string {
        let boundaryIndex = this.boundaries.findIndex((item) => item.name === parentBoundary);
        if (boundaryIndex === -1) {
            this.boundaries.push({ name: parentBoundary, count: 1 });
            boundaryIndex = this.boundaries.length - 1;
        } else {
            this.boundaries[boundaryIndex].count++;
        }
        let partId = '1';
        for (let i = 0; i <= boundaryIndex; i++) {
            if (i === 0) partId = this.boundaries[i].count.toString();
            else partId += `.${this.boundaries[i].count.toString()}`;
        }
        return partId;
    }

    private getAddressesHTML(value: ParsedAddress[]): string {
        const formatSingleLevel = (addresses: ParsedAddress[]): string =>
            addresses
                .map((address) => {
                    let str = '<span class="mp_address_group">';
                    if (address.name) {
                        str +=
                            '<span class="mp_address_name">' +
                            he.encode(address.name) +
                            (address.group ? ': ' : '') +
                            '</span>';
                    }
                    if (address.address) {
                        const link =
                            '<a href="mailto:' +
                            he.encode(address.address) +
                            '" class="mp_address_email">' +
                            he.encode(address.address) +
                            '</a>';
                        if (address.name) {
                            str += ` &lt;${link}&gt;`;
                        } else {
                            str += link;
                        }
                    }
                    if (address.group) {
                        str += `${formatSingleLevel(address.group)};`;
                    }
                    return `${str}</span>`;
                })
                .join(', ');
        return formatSingleLevel(([] as ParsedAddress[]).concat(value || []));
    }

    private getAddressesText(value: ParsedAddress[]): string {
        const formatSingleLevel = (addresses: ParsedAddress[]): string =>
            addresses
                .map((address) => {
                    let str = '';
                    if (address.name) {
                        str += `"${address.name}"${address.group ? ': ' : ''}`;
                    }
                    if (address.address) {
                        const link = address.address;
                        if (address.name) {
                            str += ` <${link}>`;
                        } else {
                            str += link;
                        }
                    }
                    if (address.group) {
                        str += `${formatSingleLevel(address.group)};`;
                    }
                    return str;
                })
                .join(', ');
        return formatSingleLevel(([] as ParsedAddress[]).concat(value || []));
    }

    updateImageLinks(
        replaceCallback: (attachment: InternalAttachment, done: (err: Error | null, url: string) => void) => void,
        done: (err: Error | null, html: string | null) => void,
    ): void {
        if (!this.html) {
            process.nextTick(() => done(null, null));
            return;
        }

        const cids = new Map<string, CidEntry>();
        let html = (this.html || '').toString();

        if (this.options.skipImageLinks) {
            done(null, html);
            return;
        }

        html.replace(/\bcid:([^'"\s]{1,256})/g, (match: string, cid: string) => {
            for (let i = 0, len = this.attachmentList.length; i < len; i++) {
                if (this.attachmentList[i].cid === cid && /^image\/[\w]+$/i.test(this.attachmentList[i].contentType)) {
                    cids.set(cid, {
                        attachment: this.attachmentList[i],
                    });
                    break;
                }
            }
            return match;
        });

        const cidList: CidEntry[] = [];
        for (const entry of cids.values()) {
            cidList.push(entry);
        }

        let pos = 0;
        const processNext = (): void => {
            if (pos >= cidList.length) {
                html = html.replace(/\bcid:([^'"\s]{1,256})/g, (match: string, cid: string) => {
                    if (cids.has(cid) && cids.get(cid)!.url) {
                        return cids.get(cid)!.url!;
                    }
                    return match;
                });

                done(null, html);
                return;
            }
            const entry = cidList[pos++];
            replaceCallback(entry.attachment, (err: Error | null, url: string) => {
                if (err) {
                    return process.nextTick(() => done(err, null));
                }
                entry.url = url;
                process.nextTick(processNext);
            });
        };

        process.nextTick(processNext);
    }

    private textToHtml(str: string): string {
        if (this.options.skipTextToHtml) {
            return '';
        }
        str = (str || '').toString();
        let encoded: string;

        let linkified = false;
        if (!this.options.skipTextLinks) {
            try {
                if (linkify.pretest(str)) {
                    linkified = true;
                    const links = linkify.match(str) || [];
                    const result: string[] = [];
                    let last = 0;

                    for (const link of links) {
                        if (last < link.index) {
                            const textPart = he.encode(str.slice(last, link.index), {
                                useNamedReferences: true,
                            });
                            result.push(textPart);
                        }

                        result.push(`<a href="${link.url}">${link.text}</a>`);

                        last = link.lastIndex;
                    }

                    const textPart = he.encode(str.slice(last), {
                        useNamedReferences: true,
                    });
                    result.push(textPart);

                    encoded = result.join('');
                }
            } catch (_E) {
                // failed, don't linkify
            }
        }

        if (!linkified) {
            encoded = he.encode(str, {
                useNamedReferences: true,
            });
        }

        const text =
            '<p>' +
            encoded!
                .replace(/\r?\n/g, '\n')
                .trim()
                .replace(/[ \t]+$/gm, '')
                .trim()
                .replace(/\n\n+/g, '</p><p>')
                .trim()
                .replace(/\n/g, '<br/>') +
            '</p>';

        return text;
    }
}

export default MailParser;
