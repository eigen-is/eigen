// Streaming multipart/form-data parser, derived from @mjackson/multipart-parser (MIT
// © Michael Jackson) but reshaped to yield part bodies incrementally as events instead
// of buffering each part in memory. Supports exactly what our upload routes need:
// browser/fetch-generated multipart bodies read from a web ReadableStream on Bun.

import {
    createPartialTailSearch,
    createSearch,
    type PartialTailSearchFunction,
    type SearchFunction,
} from './buffer-search';

export class MultipartParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MultipartParseError';
    }
}

export class MaxFileSizeExceededError extends MultipartParseError {
    constructor(maxFileSize: number) {
        super(`File size exceeds maximum allowed size of ${maxFileSize} bytes`);
        this.name = 'MaxFileSizeExceededError';
    }
}

export type MultipartEvent =
    | { type: 'part'; name?: string; filename?: string; mediaType?: string }
    | { type: 'chunk'; data: Uint8Array }
    | { type: 'end'; size: number };

const MAX_HEADER_SIZE = 8 * 1024;
// RFC 2046 caps a boundary at 70 chars. Enforced so the search needle stays short
// and its skip table (keyed on needle length) can never wrap to a 0 skip → infinite loop.
const MAX_BOUNDARY_LENGTH = 70;

const StateStart = 0;
const StateAfterBoundary = 1;
const StateHeader = 2;
const StateBody = 3;
const StateDone = 4;

const findDoubleNewline = createSearch('\r\n\r\n');
const decoder = new TextDecoder();

// Extract a parameter from a Content-Disposition value, honoring quoted strings
// with backslash escapes (`filename="we \"love\" quotes.txt"`).
const NAME_PARAM = /(?:^|;)\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/i;
const FILENAME_PARAM = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/i;

function dispositionParam(value: string, param: RegExp): string | undefined {
    const match = param.exec(value);
    if (!match) return undefined;
    return match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
}

function parsePartHeader(header: Uint8Array): Extract<MultipartEvent, { type: 'part' }> {
    const event: Extract<MultipartEvent, { type: 'part' }> = { type: 'part' };

    for (const line of decoder.decode(header).split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const headerName = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (headerName === 'content-disposition') {
            event.name = dispositionParam(value, NAME_PARAM);
            event.filename = dispositionParam(value, FILENAME_PARAM);
        } else if (headerName === 'content-type') {
            event.mediaType = value.split(';')[0].trim().toLowerCase() || undefined;
        }
    }

    return event;
}

class MultipartParser {
    readonly #maxFileSize: number;
    readonly #openingBoundary: Uint8Array;
    readonly #findBoundary: SearchFunction;
    readonly #findPartialTailBoundary: PartialTailSearchFunction;
    readonly #boundaryLength: number;

    #state = StateStart;
    #buffer: Uint8Array | null = null;
    #partSize = 0;

    constructor(boundary: string, maxFileSize: number) {
        if (boundary.length > MAX_BOUNDARY_LENGTH) {
            throw new MultipartParseError(
                `Multipart boundary exceeds the maximum length of ${MAX_BOUNDARY_LENGTH} characters`,
            );
        }
        this.#maxFileSize = maxFileSize;
        this.#openingBoundary = new TextEncoder().encode(`--${boundary}`);
        this.#findBoundary = createSearch(`\r\n--${boundary}`);
        this.#findPartialTailBoundary = createPartialTailSearch(`\r\n--${boundary}`);
        this.#boundaryLength = 4 + boundary.length;
    }

    *write(chunk: Uint8Array): Generator<MultipartEvent, void, unknown> {
        // Epilogue after the closing boundary is ignored per RFC 2046.
        if (this.#state === StateDone) return;

        if (this.#buffer !== null) {
            const joined = new Uint8Array(this.#buffer.length + chunk.length);
            joined.set(this.#buffer, 0);
            joined.set(chunk, this.#buffer.length);
            chunk = joined;
            this.#buffer = null;
        }

        const chunkLength = chunk.length;
        let index = 0;

        // Retained bytes below use slice() not subarray(): #buffer is held across the
        // await between chunks, so it must own its bytes, not view the network buffer.
        while (true) {
            if (this.#state === StateBody) {
                if (chunkLength - index < this.#boundaryLength) {
                    this.#buffer = chunk.slice(index);
                    break;
                }

                const boundaryIndex = this.#findBoundary(chunk, index);

                if (boundaryIndex === -1) {
                    // No boundary; hold back a potential partial boundary at the chunk's tail
                    // and emit the rest of the body bytes.
                    const partialTailIndex = this.#findPartialTailBoundary(chunk);
                    const bodyEnd = partialTailIndex === -1 ? chunkLength : partialTailIndex;
                    if (bodyEnd > index) yield this.#chunkEvent(chunk.subarray(index, bodyEnd));
                    if (partialTailIndex !== -1) this.#buffer = chunk.slice(partialTailIndex);
                    break;
                }

                if (boundaryIndex > index) yield this.#chunkEvent(chunk.subarray(index, boundaryIndex));
                yield { type: 'end', size: this.#partSize };

                index = boundaryIndex + this.#boundaryLength;
                this.#state = StateAfterBoundary;
            }

            if (this.#state === StateAfterBoundary) {
                if (chunkLength - index < 2) {
                    this.#buffer = chunk.slice(index);
                    break;
                }

                if (chunk[index] === 45 && chunk[index + 1] === 45) {
                    this.#state = StateDone;
                    break;
                }

                index += 2; // Skip \r\n after the boundary
                this.#state = StateHeader;
            }

            if (this.#state === StateHeader) {
                if (chunkLength - index < 4) {
                    this.#buffer = chunk.slice(index);
                    break;
                }

                const headerEndIndex = findDoubleNewline(chunk, index);

                if ((headerEndIndex === -1 ? chunkLength : headerEndIndex) - index > MAX_HEADER_SIZE) {
                    throw new MultipartParseError('Part header exceeds maximum size');
                }
                if (headerEndIndex === -1) {
                    this.#buffer = chunk.slice(index);
                    break;
                }

                yield parsePartHeader(chunk.subarray(index, headerEndIndex));
                this.#partSize = 0;

                index = headerEndIndex + 4; // Skip \r\n\r\n
                this.#state = StateBody;
                continue;
            }

            if (this.#state === StateStart) {
                if (chunkLength < this.#openingBoundary.length) {
                    this.#buffer = chunk.slice();
                    break;
                }
                if (!this.#openingBoundary.every((byte, i) => chunk[i] === byte)) {
                    throw new MultipartParseError('Invalid multipart stream: missing initial boundary');
                }

                index = this.#openingBoundary.length;
                this.#state = StateAfterBoundary;
            }
        }
    }

    #chunkEvent(data: Uint8Array): MultipartEvent {
        if (this.#partSize + data.length > this.#maxFileSize) {
            throw new MaxFileSizeExceededError(this.#maxFileSize);
        }
        this.#partSize += data.length;
        return { type: 'chunk', data };
    }

    finish(): void {
        if (this.#state !== StateDone) {
            throw new MultipartParseError('Multipart stream not finished');
        }
    }
}

function getMultipartBoundary(contentType: string): string | null {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    return match ? (match[1] ?? match[2]) : null;
}

// Parse a multipart request body as a flat stream of events: a `part` event with the
// parsed headers, `chunk` events with body bytes as they arrive on the wire, then an
// `end` event with the part's total size. Chunk data is a view into the network buffer:
// consume it before the next iteration, copy it to keep it.
export async function* parseMultipartRequest(
    request: Request,
    options: { maxFileSize: number },
): AsyncGenerator<MultipartEvent, void, unknown> {
    const contentType = request.headers.get('content-type');
    if (!contentType?.startsWith('multipart/')) {
        throw new MultipartParseError('Request is not a multipart request');
    }
    const boundary = getMultipartBoundary(contentType);
    if (!boundary) {
        throw new MultipartParseError('Invalid Content-Type header: missing boundary');
    }
    if (!request.body) {
        throw new MultipartParseError('Request body is empty');
    }

    const parser = new MultipartParser(boundary, options.maxFileSize);
    for await (const chunk of request.body) {
        yield* parser.write(chunk);
    }
    parser.finish();
}
