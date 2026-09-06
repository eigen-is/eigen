import { extname } from 'node:path';
import { domainToUnicode } from 'node:url';
import type { AddressObject, EmailAddress, ParsedMail } from '@workspace/lib/types/mail';
import libmime from 'libmime';
import addressparser from 'nodemailer/lib/addressparser';

export type StructuredValue = { value: string; params: Record<string, string> };

export type PartHeaders = Pick<
    ParsedMail,
    'subject' | 'date' | 'from' | 'to' | 'cc' | 'bcc' | 'replyTo' | 'messageId' | 'inReplyTo' | 'references'
> & {
    contentType: StructuredValue;
    contentDisposition: StructuredValue;
    transferEncoding: string;
    contentId: string | undefined;
    // Raw `Authentication-Results` values in document order — the MTA prepends its own on receipt.
    authenticationResults: string[];
};

type HeaderLine = { key: string; value: string };

// A display name made only of B-encoded words may decode to a full "Name <addr>" that needs re-parsing.
const ENCODED_WORDS_ONLY = /^(=\?([^?]+)\?[Bb]\?[^?]*\?=)(\s*=\?([^?]+)\?[Bb]\?[^?]*\?=)*$/;

export function parseHeaders(head: Buffer): PartHeaders {
    const lines = headerLines(head);
    const first = (key: string) => lines.find((line) => line.key === key);
    const last = (key: string) => lines.findLast((line) => line.key === key && line.value !== '')?.value;
    const addresses = (key: string) =>
        lines.filter((line) => line.key === key).map((line) => parseAddresses(line.value));
    const oneOrMany = (list: AddressObject[]) => (list.length > 1 ? list : list.at(0));

    const contentDisposition = structured(first('content-disposition')?.value ?? '');
    const contentTypeLine = first('content-type');
    const contentType = structured(contentTypeLine ? contentTypeLine.value : defaultContentType(contentDisposition));

    const dateLine = lines.findLast((line) => line.key === 'date');
    const date = dateLine ? new Date(dateLine.value) : undefined;
    const subject = last('subject');
    const messageId = last('message-id');
    const inReplyTo = last('in-reply-to');
    const references = lines
        .filter((line) => line.key === 'references')
        .flatMap((line) => libmime.decodeWords(line.value).split(/\s+/).filter(Boolean).map(messageIdFormat));
    const authenticationResults = lines
        .filter((line) => line.key === 'authentication-results')
        .map((line) => line.value);

    return {
        authenticationResults,
        contentType,
        contentDisposition,
        transferEncoding:
            first('content-transfer-encoding')
                ?.value.replace(/\(.*\)/g, '')
                .toLowerCase()
                .trim() ?? '',
        contentId: last('content-id'),
        subject: subject && libmime.decodeWords(subject),
        date: date && Number.isNaN(date.getTime()) ? new Date() : date,
        from: addresses('from').at(-1),
        replyTo: addresses('reply-to').at(-1),
        to: oneOrMany(addresses('to')),
        cc: oneOrMany(addresses('cc')),
        bcc: oneOrMany(addresses('bcc')),
        messageId: messageId && messageIdFormat(libmime.decodeWords(messageId)),
        inReplyTo: inReplyTo && messageIdFormat(libmime.decodeWords(inReplyTo)),
        references: references.length > 1 ? references : references.at(0),
    };
}

// Unfolds continuation lines, then splits `Key: value` per logical line. Header bytes are read as
// latin1 so the split is byte-exact; each value is then re-decoded from UTF-8.
function headerLines(head: Buffer): HeaderLine[] {
    const logical: string[] = [];
    for (const line of head
        .toString('latin1')
        .replace(/[\r\n]+$/, '')
        .split(/\r?\n/)) {
        if (logical.length && (line.startsWith(' ') || line.startsWith('\t'))) {
            logical[logical.length - 1] += `\r\n${line}`;
        } else {
            logical.push(line);
        }
    }

    const lines: HeaderLine[] = [];
    for (const [i, logicalLine] of logical.entries()) {
        // mbox `From ` / HTTP `POST ` envelope line, not a header
        if (i === 0 && /^(From|POST) /i.test(logicalLine)) continue;
        const match = /^\s*([^:]+):(.*)$/.exec(logicalLine.replace(/(?:\r?\n|\r)[ \t]*/g, ' ').trim());
        if (match) {
            lines.push({
                key: match[1].trim().toLowerCase(),
                value: Buffer.from(match[2].trim(), 'latin1').toString(),
            });
        }
    }
    return lines;
}

function structured(value: string): StructuredValue {
    const parsed = libmime.parseHeaderValue(value);
    return { value: (parsed.value || '').toLowerCase().trim(), params: parsed.params };
}

// No Content-Type header: infer from the disposition filename's extension, else by disposition.
function defaultContentType({ value, params }: StructuredValue): string {
    const extension = extname(params['filename'] ?? '').slice(1);
    if (extension) return libmime.detectMimeType(extension);
    return value === 'attachment' ? 'application/octet-stream' : 'text/plain';
}

function messageIdFormat(id: string): string {
    return `${id.startsWith('<') ? '' : '<'}${id}${id.endsWith('>') ? '' : '>'}`;
}

function parseAddresses(value: string): AddressObject {
    const list = decodeAddresses(addressparser(value));
    return { value: list, text: addressesText(list) };
}

function decodeAddresses(parsed: addressparser.AddressOrGroup[]): EmailAddress[] {
    const result: EmailAddress[] = [];
    const hidden: addressparser.AddressOrGroup[] = [];
    for (const entry of parsed) {
        if (!('group' in entry) && !entry.address && ENCODED_WORDS_ONLY.test(entry.name.trim())) {
            hidden.push(...addressparser(libmime.decodeWords(entry.name.trim())));
        } else {
            result.push(decodeAddress(entry));
        }
    }
    for (const entry of hidden) result.push(decodeAddress(entry));
    return result;
}

function decodeAddress(entry: addressparser.AddressOrGroup): EmailAddress {
    const name = libmime.decodeWords(entry.name.trim());
    if ('group' in entry) return { name, group: decodeAddresses(entry.group) };
    const at = entry.address.lastIndexOf('@');
    const unicodeDomain = /@xn--/.test(entry.address) ? domainToUnicode(entry.address.slice(at + 1)) : '';
    return { name, address: unicodeDomain ? entry.address.slice(0, at + 1) + unicodeDomain : entry.address };
}

function addressesText(list: EmailAddress[]): string {
    return list
        .map((entry) => {
            let str = entry.name ? `"${entry.name}"${entry.group ? ': ' : ''}` : '';
            if (entry.address) str += entry.name ? ` <${entry.address}>` : entry.address;
            if (entry.group) str += `${addressesText(entry.group)};`;
            return str;
        })
        .join(', ');
}
