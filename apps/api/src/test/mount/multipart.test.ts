import { describe, expect, test } from 'bun:test';
import {
    MaxFileSizeExceededError,
    type MultipartEvent,
    MultipartParseError,
    parseMultipartRequest,
} from '../../lib/multipart';

const BOUNDARY = 'test-boundary-7MA4YWxkTrZu0gW';
const enc = new TextEncoder();

function filePart(name: string, filename: string, mediaType: string, body: string | Uint8Array): Uint8Array {
    const header =
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${mediaType}\r\n\r\n`;
    const bytes = typeof body === 'string' ? enc.encode(body) : body;
    const out = new Uint8Array(header.length + bytes.length + 2);
    out.set(enc.encode(header), 0);
    out.set(bytes, header.length);
    out.set(enc.encode('\r\n'), header.length + bytes.length);
    return out;
}

function fieldPart(name: string, value: string): Uint8Array {
    return enc.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function closer(): Uint8Array {
    return enc.encode(`--${BOUNDARY}--\r\n`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
    return Buffer.concat(parts);
}

function requestOf(chunks: Uint8Array[], contentType = `multipart/form-data; boundary=${BOUNDARY}`): Request {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
    return new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
    });
}

async function collect(request: Request, maxFileSize = 10 * 1024 * 1024): Promise<MultipartEvent[]> {
    const events: MultipartEvent[] = [];
    for await (const ev of parseMultipartRequest(request, { maxFileSize })) {
        // Copy chunk data: the parser may reuse/overwrite views after the consumer returns.
        events.push(ev.type === 'chunk' ? { type: 'chunk', data: ev.data.slice() } : ev);
    }
    return events;
}

function bodyOf(events: MultipartEvent[]): Uint8Array {
    return concat(...events.filter((e) => e.type === 'chunk').map((e) => e.data));
}

describe('multipart parser', () => {
    test('yields part, chunk, end events for a single file part', async () => {
        const message = concat(filePart('file', 'hello.txt', 'text/plain', 'hello world'), closer());
        const events = await collect(requestOf([message]));

        expect(events[0]).toEqual({ type: 'part', name: 'file', filename: 'hello.txt', mediaType: 'text/plain' });
        expect(events.at(-1)).toEqual({ type: 'end', size: 11 });
        expect(new TextDecoder().decode(bodyOf(events))).toBe('hello world');
    });

    test('field part has no filename and reassembles as text', async () => {
        const message = concat(fieldPart('subject', 'Hello there'), closer());
        const events = await collect(requestOf([message]));

        expect(events[0]).toEqual({ type: 'part', name: 'subject', filename: undefined, mediaType: undefined });
        expect(new TextDecoder().decode(bodyOf(events))).toBe('Hello there');
        expect(events.at(-1)).toEqual({ type: 'end', size: 11 });
    });

    test('yields multiple parts in order', async () => {
        const message = concat(
            fieldPart('to', 'a@b.c'),
            filePart('file', 'a.bin', 'application/octet-stream', new Uint8Array([0, 1, 2])),
            filePart('file', 'b.txt', 'text/plain', 'second'),
            closer(),
        );
        const events = await collect(requestOf([message]));
        const parts = events.filter((e) => e.type === 'part');

        expect(parts.map((p) => p.filename)).toEqual([undefined, 'a.bin', 'b.txt']);
        expect(events.filter((e) => e.type === 'end').map((e) => e.size)).toEqual([5, 3, 6]);
    });

    test('streams chunks before the request body completes', async () => {
        // Feed the head of a part but keep the stream open; the parser must yield
        // the part header and body bytes without waiting for the closing boundary.
        const head = concat(filePart('file', 'big.bin', 'application/octet-stream', 'x'.repeat(64 * 1024)));
        let releaseTail: () => void = () => {};
        const tailGate = new Promise<void>((r) => {
            releaseTail = r;
        });

        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(head);
                await tailGate;
                controller.enqueue(closer());
                controller.close();
            },
        });
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
            body,
        });

        const events: MultipartEvent[] = [];
        let seenBytes = 0;
        for await (const ev of parseMultipartRequest(request, { maxFileSize: 10 * 1024 * 1024 })) {
            events.push(ev);
            if (ev.type === 'chunk') seenBytes += ev.data.length;
            // Most of the part body must arrive while the stream is still open. The parser
            // may hold back a potential partial boundary tail, never more than that.
            if (seenBytes >= 60 * 1024) releaseTail();
        }

        expect(seenBytes).toBe(64 * 1024);
        expect(events.at(-1)).toEqual({ type: 'end', size: 64 * 1024 });
    });

    test('handles a boundary split across chunk borders', async () => {
        const message = concat(filePart('file', 'a.txt', 'text/plain', 'abcdef'), closer());
        // Split inside the closing boundary sequence to force the partial-tail path.
        const splitAt = message.length - closer().length - 4;
        const events = await collect(requestOf([message.subarray(0, splitAt), message.subarray(splitAt)]));

        expect(new TextDecoder().decode(bodyOf(events))).toBe('abcdef');
        expect(events.at(-1)).toEqual({ type: 'end', size: 6 });
    });

    test('parses a message fed byte by byte', async () => {
        const message = concat(fieldPart('k', 'v'), filePart('file', 'a.txt', 'text/plain', 'byte by byte'), closer());
        const chunks = Array.from(message, (byte) => new Uint8Array([byte]));
        const events = await collect(requestOf(chunks));

        const ends = events.filter((e) => e.type === 'end');
        expect(ends.map((e) => e.size)).toEqual([1, 12]);
        expect(new TextDecoder().decode(bodyOf(events).subarray(1))).toBe('byte by byte');
    });

    test('throws MaxFileSizeExceededError as soon as the limit is exceeded', async () => {
        // The stream never closes; the parser must abort mid-stream, not at the end.
        const head = filePart('file', 'big.bin', 'application/octet-stream', 'x'.repeat(4096));
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(head);
                // Stream stays open: no close(), no closing boundary.
            },
        });
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
            body,
        });

        await expect(collect(request, 1024)).rejects.toBeInstanceOf(MaxFileSizeExceededError);
    });

    test('parses quoted filenames with escaped quotes and special characters', async () => {
        const message = concat(
            enc.encode(
                `--${BOUNDARY}\r\n` +
                    `Content-Disposition: form-data; name="file"; filename="we \\"love\\" ünïcode;.txt"\r\n` +
                    `Content-Type: text/plain\r\n\r\nx\r\n`,
            ),
            closer(),
        );
        const events = await collect(requestOf([message]));

        expect(events[0]).toEqual({
            type: 'part',
            name: 'file',
            filename: 'we "love" ünïcode;.txt',
            mediaType: 'text/plain',
        });
    });

    test('handles an empty file part', async () => {
        const message = concat(filePart('file', 'empty.txt', 'text/plain', ''), closer());
        const events = await collect(requestOf([message]));

        expect(events[0]).toMatchObject({ type: 'part', filename: 'empty.txt' });
        expect(events.at(-1)).toEqual({ type: 'end', size: 0 });
        expect(bodyOf(events).length).toBe(0);
    });

    test('ignores epilogue bytes arriving in separate chunks after the final boundary', async () => {
        const message = concat(filePart('file', 'a.txt', 'text/plain', 'data'), enc.encode(`--${BOUNDARY}--`));
        const events = await collect(requestOf([message, enc.encode('\r\n'), enc.encode('epilogue junk')]));

        expect(new TextDecoder().decode(bodyOf(events))).toBe('data');
        expect(events.at(-1)).toEqual({ type: 'end', size: 4 });
    });

    test('round-trips a platform-serialized FormData body', async () => {
        const form = new FormData();
        form.append('field', 'value');
        form.append('file', new File(['file content here'], 'roundtrip.txt', { type: 'text/plain' }));
        const original = new Request('http://localhost/upload', { method: 'POST', body: form });
        // Re-wrap so the parser sees a plain streamed body, as in production.
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': original.headers.get('content-type')! },
            body: original.body,
        });

        const events = await collect(request);
        const parts = events.filter((e) => e.type === 'part');

        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatchObject({ name: 'field', filename: undefined });
        expect(parts[1]).toMatchObject({ name: 'file', filename: 'roundtrip.txt', mediaType: 'text/plain' });
        expect(events.filter((e) => e.type === 'end').at(-1)?.size).toBe('file content here'.length);
    });

    test('rejects a request without a multipart content type', async () => {
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        await expect(collect(request)).rejects.toBeInstanceOf(MultipartParseError);
    });

    test('parses a message with a 252-char boundary without hanging', async () => {
        // A 252-char boundary makes the \r\n--boundary needle 256 bytes. A Uint8Array skip
        // table would wrap its default to 0 and spin the body search forever; the Uint32Array
        // table keeps the skip intact so the search terminates and the part parses normally.
        const long = 'b'.repeat(252);
        const message = enc.encode(
            `--${long}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n` +
                `${'x'.repeat(4096)}\r\n--${long}--\r\n`,
        );
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${long}` },
            body: message,
        });
        const events = await collect(request);
        expect(events[0]).toMatchObject({ type: 'part', filename: 'a.txt' });
        expect(events.at(-1)).toEqual({ type: 'end', size: 4096 });
        expect(new TextDecoder().decode(bodyOf(events))).toBe('x'.repeat(4096));
    });

    test('rejects a multipart content type without a boundary', async () => {
        const request = new Request('http://localhost/upload', {
            method: 'POST',
            headers: { 'content-type': 'multipart/form-data' },
            body: 'x',
        });
        await expect(collect(request)).rejects.toBeInstanceOf(MultipartParseError);
    });

    test('rejects a stream that does not start with the boundary', async () => {
        const request = requestOf([enc.encode('this is not multipart data at all, definitely long enough')]);
        await expect(collect(request)).rejects.toBeInstanceOf(MultipartParseError);
    });

    test('rejects a truncated stream with no closing boundary', async () => {
        const message = filePart('file', 'a.txt', 'text/plain', 'truncated');
        await expect(collect(requestOf([message]))).rejects.toBeInstanceOf(MultipartParseError);
    });

    test('rejects an oversized part header', async () => {
        const huge = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${'a'.repeat(64 * 1024)}"\r\n\r\nx\r\n`;
        await expect(collect(requestOf([enc.encode(huge)]))).rejects.toBeInstanceOf(MultipartParseError);
    });
});
