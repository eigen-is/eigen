import { deflateRawSync } from 'node:zlib';

// A zip built field by field, so every field can lie: the hostile archives core/zip.ts must refuse.

export type RawPart = {
    name: string;
    body: Uint8Array;
    method: number;
    size: number;
    crc: number;
    flags?: number;
    zip64?: boolean;
    localName?: string;
    // An offset for the central entry alone: no local header is written for it.
    offset?: number;
};

const encoder = new TextEncoder();

export function deflated(name: string, data: Uint8Array | string): RawPart {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    return { name, body: deflateRawSync(bytes), method: 8, size: bytes.length, crc: Bun.hash.crc32(bytes) };
}

export function stored(name: string, data: Uint8Array | string): RawPart {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    return { name, body: bytes, method: 0, size: bytes.length, crc: Bun.hash.crc32(bytes) };
}

// `base` shifts every offset, as if the archive followed that many bytes. A ZIP64 end record is written on request or past 65,535 parts.
export function build(
    parts: RawPart[],
    options: { zip64End?: boolean; base?: number; comment?: Uint8Array } = {},
): Buffer {
    const base = options.base ?? 0;
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let at = 0;
    for (const part of parts) {
        const name = encoder.encode(part.name);
        const localName = encoder.encode(part.localName ?? part.name);
        const offset = part.offset ?? base + at;
        if (part.offset === undefined) {
            const local = new Uint8Array(30 + localName.length + (part.zip64 ? 20 : 0));
            const view = new DataView(local.buffer);
            view.setUint32(0, 0x04034b50, true);
            view.setUint16(4, part.zip64 ? 45 : 20, true);
            view.setUint16(6, part.flags ?? 0, true);
            view.setUint16(8, part.method, true);
            view.setUint16(12, 0x21, true);
            view.setUint32(14, part.crc, true);
            view.setUint32(18, part.zip64 ? 0xffffffff : part.body.length, true);
            view.setUint32(22, part.zip64 ? 0xffffffff : part.size, true);
            view.setUint16(26, localName.length, true);
            view.setUint16(28, part.zip64 ? 20 : 0, true);
            local.set(localName, 30);
            if (part.zip64) {
                const extra = 30 + localName.length;
                view.setUint16(extra, 1, true);
                view.setUint16(extra + 2, 16, true);
                view.setBigUint64(extra + 4, BigInt(part.size), true);
                view.setBigUint64(extra + 12, BigInt(part.body.length), true);
            }
            chunks.push(local, part.body);
            at += local.length + part.body.length;
        }
        const entry = new Uint8Array(46 + name.length + (part.zip64 ? 28 : 0));
        const view = new DataView(entry.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 45, true);
        view.setUint16(6, part.zip64 ? 45 : 20, true);
        view.setUint16(8, part.flags ?? 0, true);
        view.setUint16(10, part.method, true);
        view.setUint16(14, 0x21, true);
        view.setUint32(16, part.crc, true);
        view.setUint32(20, part.zip64 ? 0xffffffff : part.body.length, true);
        view.setUint32(24, part.zip64 ? 0xffffffff : part.size, true);
        view.setUint16(28, name.length, true);
        view.setUint16(30, part.zip64 ? 28 : 0, true);
        view.setUint32(42, part.zip64 ? 0xffffffff : offset, true);
        entry.set(name, 46);
        if (part.zip64) {
            const extra = 46 + name.length;
            view.setUint16(extra, 1, true);
            view.setUint16(extra + 2, 24, true);
            view.setBigUint64(extra + 4, BigInt(part.size), true);
            view.setBigUint64(extra + 12, BigInt(part.body.length), true);
            view.setBigUint64(extra + 20, BigInt(offset), true);
        }
        central.push(entry);
    }
    const directoryStart = base + at;
    const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
    const count = central.length;
    const tail: Uint8Array[] = [];
    const zip64 = options.zip64End || count > 0xffff;
    if (zip64) {
        const end64 = new Uint8Array(56 + 20);
        const view = new DataView(end64.buffer);
        view.setUint32(0, 0x06064b50, true);
        view.setBigUint64(4, 44n, true);
        view.setUint16(12, 45, true);
        view.setUint16(14, 45, true);
        view.setBigUint64(24, BigInt(count), true);
        view.setBigUint64(32, BigInt(count), true);
        view.setBigUint64(40, BigInt(directorySize), true);
        view.setBigUint64(48, BigInt(directoryStart), true);
        view.setUint32(56, 0x07064b50, true);
        view.setBigUint64(64, BigInt(directoryStart + directorySize), true);
        view.setUint32(72, 1, true);
        tail.push(end64);
    }
    const comment = options.comment ?? new Uint8Array(0);
    const end = new Uint8Array(22 + comment.length);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, zip64 ? 0xffff : count, true);
    view.setUint16(10, zip64 ? 0xffff : count, true);
    view.setUint32(12, zip64 ? 0xffffffff : directorySize, true);
    view.setUint32(16, zip64 ? 0xffffffff : directoryStart, true);
    view.setUint16(20, comment.length, true);
    end.set(comment, 22);
    tail.push(end);
    return Buffer.concat([...chunks, ...central, ...tail]);
}

// `bytes` zeros as one fixed-Huffman block: a literal, then matches of 258 at distance 1, 13 bits each.
// A GiB costs 6.5 MB and no GiB of memory to build, where zlib would need the GiB as input.
export function deflatedZeros(bytes: number): Uint8Array {
    const matches = Math.floor((bytes - 1) / 258);
    const literals = bytes - matches * 258;
    const out = new Uint8Array(Math.ceil((3 + 8 * literals + 13 * matches + 7) / 8));
    let bit = 0;
    // Huffman codes go most significant bit first, header fields least significant first.
    const code = (value: number, length: number) => {
        for (let i = length - 1; i >= 0; i--, bit++) if ((value >> i) & 1) out[bit >> 3] |= 1 << (bit & 7);
    };
    code(0b110, 3);
    for (let i = 0; i < literals; i++) code(0x30, 8);
    for (let i = 0; i < matches; i++) code(0b1100010100000, 13);
    code(0, 7);
    return out;
}
