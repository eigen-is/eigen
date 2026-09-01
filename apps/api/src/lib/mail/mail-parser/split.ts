import { type PartHeaders, parseHeaders } from './headers';

// Both caps reject the parse with a plain Error; the fuzz suite pins "reject, never hang".
const MAX_HEAD_SIZE = 1024 * 1024;
const MAX_CHILD_NODES = 1000;

export type MimePart = {
    parent: MimePart | null;
    headers: PartHeaders;
    contentType: string;
    children: MimePart[];
    // Raw, still transfer-encoded bytes; meaningless for multipart containers.
    body: Buffer;
    // Inline message/rfc822 whose single child is the embedded message itself.
    embedsMessage: boolean;
};

export function splitMime(bytes: Buffer): MimePart {
    let pos = 0;
    let count = 0;

    // Next line including its terminator, without consuming it; the unterminated tail is a line too.
    const peekLine = (): Buffer | null => {
        if (pos >= bytes.length) return null;
        const newline = bytes.indexOf(0x0a, pos);
        return bytes.subarray(pos, newline === -1 ? bytes.length : newline + 1);
    };

    const readPart = (parent: MimePart | null, parentBoundary: Buffer | null): MimePart => {
        if (++count > MAX_CHILD_NODES) throw new Error('Max allowed child nodes exceeded');

        const headStart = pos;
        let line: Buffer | null;
        let cut = false;
        while ((line = peekLine()) !== null) {
            if (matchBoundary(line, parentBoundary)) {
                cut = true;
                break;
            }
            pos += line.length;
            if (isBlankLine(line)) break;
        }
        if (pos - headStart > MAX_HEAD_SIZE) throw new Error('Max header size for a MIME node exceeded');

        const headers = parseHeaders(bytes.subarray(headStart, pos));
        const contentType = headers.contentType.value || (parent ? '' : 'text/plain');
        const part: MimePart = {
            parent,
            headers,
            contentType,
            children: [],
            body: Buffer.alloc(0),
            embedsMessage: false,
        };
        // A header block cut short by a boundary line never got its body separator: not a part. Only the
        // root's return value is read, and nothing can cut the root.
        if (cut) return part;
        parent?.children.push(part);

        if (contentType === 'message/rfc822' && isInlineMessage(headers)) {
            part.embedsMessage = true;
            readPart(part, parentBoundary);
            return part;
        }

        const boundaryParam = headers.contentType.params['boundary'];
        if (contentType.startsWith('multipart/') && boundaryParam) {
            readChildren(part, Buffer.from(boundaryParam), parentBoundary);
            return part;
        }

        const bodyStart = pos;
        while ((line = peekLine()) !== null && !matchBoundary(line, parentBoundary)) pos += line.length;
        // A body closed by a boundary line gives up the line break that precedes the boundary.
        part.body = bytes.subarray(bodyStart, line === null ? pos : stripLineBreak(bodyStart, pos));
        return part;
    };

    // Body of a multipart: preamble, children on each delimiter, epilogue after the closing delimiter.
    // Stops at the parent's boundary line so the caller can act on it.
    const readChildren = (part: MimePart, boundary: Buffer, parentBoundary: Buffer | null): void => {
        let line: Buffer | null;
        while ((line = peekLine()) !== null) {
            const own = matchBoundary(line, boundary);
            if (!own && matchBoundary(line, parentBoundary)) return;
            pos += line.length;
            if (own === 1) readPart(part, boundary);
        }
    };

    const stripLineBreak = (start: number, end: number): number => {
        if (end > start && bytes[end - 1] === 0x0a) {
            end--;
            if (end > start && bytes[end - 1] === 0x0d) end--;
        }
        return end;
    };

    return readPart(null, null);
}

function isBlankLine(line: Buffer): boolean {
    return (line.length === 1 && line[0] === 0x0a) || (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a);
}

function isInlineMessage(headers: PartHeaders): boolean {
    const encoding = headers.transferEncoding;
    return (
        (!encoding || encoding === '7bit' || encoding === '8bit' || encoding === 'binary') &&
        headers.contentDisposition.value === 'inline'
    );
}

// 1 = delimiter (a new part follows), 2 = closing delimiter, false = not a boundary line. A stray leading
// line break is tolerated: only a real CRLF is a 2-byte prefix, a lone CR is a 1-byte prefix (the #14 fix).
// No transport padding is accepted after the boundary.
function matchBoundary(line: Buffer, boundary: Buffer | null): 1 | 2 | false {
    if (!boundary) return false;
    let start = 0;
    if (line[0] === 0x0d || line[0] === 0x0a) start = line[0] === 0x0d && line[1] === 0x0a ? 2 : 1;
    if (line.length < 4 || line[start] !== 0x2d || line[start + 1] !== 0x2d) return false;
    if (line.length < boundary.length + 3 + start || line.length > boundary.length + 6 + start) return false;
    if (!line.subarray(start + 2, start + 2 + boundary.length).equals(boundary)) return false;

    let tail = 0;
    for (let i = boundary.length + 2 + start; i < line.length; i++) {
        const c = line[i];
        if (tail === 0 && (c === 0x0d || c === 0x0a)) return 1;
        if (tail === 0 && c !== 0x2d) return false;
        if (tail === 1 && c !== 0x2d) return false;
        if (tail === 2 && c !== 0x0d && c !== 0x0a) return false;
        if (tail === 3 && c !== 0x0a) return false;
        tail++;
    }
    return 2;
}
