import iconv from 'iconv-lite';
import libmime from 'libmime';
import libqp from 'libqp';
import type { PartHeaders } from './headers';

export function decodeTransfer(body: Buffer, encoding: string): Buffer {
    if (encoding === 'base64') return Buffer.from(body.toString('latin1'), 'base64');
    if (encoding === 'quoted-printable') return libqp.decode(body.toString('latin1'));
    return body;
}

// Text bodies: transfer decoding, format=flowed unwrapping, charset to string, CRLF to LF.
export function decodeText(body: Buffer, headers: PartHeaders): string {
    let bytes = decodeTransfer(body, headers.transferEncoding);
    const { params } = headers.contentType;
    if (params['format']?.toLowerCase().trim() === 'flowed') {
        const delSp = params['delsp']?.toLowerCase().trim() === 'yes';
        bytes = Buffer.from(libmime.decodeFlowed(bytes.toString('latin1'), delSp), 'latin1');
    }
    return decodeCharset(bytes, params['charset'] || 'utf-8').replace(/\r?\n/g, '\n');
}

function decodeCharset(bytes: Buffer, charset: string): string {
    const label = charset.trim().toLowerCase();
    if (['ascii', 'usascii', 'utf8'].includes(label.replace(/[^a-z0-9]+/g, ''))) return bytes.toString();
    // iconv-lite lacks the JIS family; Bun's TextDecoder covers it.
    if (/^jis|^iso-?2022-?jp|^eucjp/.test(label)) {
        return new TextDecoder(label.startsWith('eucjp') ? 'euc-jp' : 'iso-2022-jp').decode(bytes);
    }
    return iconv.encodingExists(label) ? iconv.decode(bytes, label) : bytes.toString();
}
