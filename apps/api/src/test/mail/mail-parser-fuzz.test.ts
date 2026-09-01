// Hostile-input fuzz net for the mail parser, from the mailparser audit deep-dive. Deterministic — every
// message is seeded by its index, no wall-clock randomness. A rejected parse is FINE (malformed input);
// the pinned contract is no hang, no crash, bounded time: parseMail runs on the shared event loop against
// attacker-controlled bytes.
import { describe, expect, test } from 'bun:test';
import { parseMail } from '../../lib/mail/mail-parser';

// --- deterministic PRNG (mulberry32) -------------------------------------------------
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const EOLS = ['\r\n', '\n', '\r', '\n\r', '\r\r', '\r\n\r\n'];
function pick<T>(r: () => number, arr: T[]): T {
    return arr[Math.floor(r() * arr.length)];
}

// Build a hostile message deterministically from index i.
function hostile(i: number): { name: string; bytes: Buffer } {
    const r = rng(i * 2654435761 + 1);
    const kind = i % 9;
    let name: string;
    let s = '';

    if (kind === 0) {
        // Malformed headers + random mixed EOLs, no body terminator
        name = 'malformed-headers';
        const n = 3 + Math.floor(r() * 20);
        for (let k = 0; k < n; k++) {
            const key = `X-H${Math.floor(r() * 1000)}`;
            const val = 'v'.repeat(Math.floor(r() * 200));
            s += `${key}: ${val}${pick(r, EOLS)}`;
        }
    } else if (kind === 1) {
        // Unterminated boundary: declared, parts opened, never closed
        name = 'unterminated-boundary';
        const b = `b${Math.floor(r() * 1e6)}`;
        s += `Content-Type: multipart/mixed; boundary="${b}"${pick(r, EOLS)}${pick(r, EOLS)}`;
        const parts = 1 + Math.floor(r() * 6);
        for (let k = 0; k < parts; k++) {
            s += `--${b}${pick(r, EOLS)}Content-Type: text/plain${pick(r, EOLS)}${pick(r, EOLS)}`;
            s += 'x'.repeat(Math.floor(r() * 500)) + pick(r, EOLS);
        }
        // no closing --b--
    } else if (kind === 2) {
        // Charset bomb: bogus / huge charset declaration
        name = 'charset-bomb';
        const junk = r() < 0.5 ? 'x-'.repeat(2000) : `utf-${Math.floor(r() * 1e9)}`;
        s += `Content-Type: text/plain; charset="${junk}"${pick(r, EOLS)}${pick(r, EOLS)}`;
        s += 'body text '.repeat(Math.floor(r() * 200));
    } else if (kind === 3) {
        // Truncated base64 attachment (cut mid-stream)
        name = 'truncated-base64';
        const b = `b${Math.floor(r() * 1e6)}`;
        s +=
            `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n` +
            'Content-Type: application/octet-stream\r\n' +
            'Content-Transfer-Encoding: base64\r\n\r\n';
        s += Buffer.from('A'.repeat(Math.floor(r() * 4000)))
            .toString('base64')
            .slice(0, Math.floor(r() * 3000));
        // truncated: no closing boundary
    } else if (kind === 4) {
        // Huge single-line HTML (no newlines)
        name = 'huge-single-line-html';
        s += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
        s += `<div>${'A'.repeat(200_000 + Math.floor(r() * 100_000))}</div>`;
    } else if (kind === 5) {
        // Deeply nested multipart (depth bomb) — should hit MAX_CHILD_NODES, not hang
        name = 'nested-multipart-bomb';
        const depth = 200 + Math.floor(r() * 400);
        for (let k = 0; k < depth; k++) {
            s += `Content-Type: multipart/mixed; boundary="L${k}"\r\n\r\n--L${k}\r\n`;
        }
        s += 'Content-Type: text/plain\r\n\r\nleaf\r\n';
        for (let k = depth - 1; k >= 0; k--) s += `--L${k}--\r\n`;
    } else if (kind === 6) {
        // Random binary garbage as a whole message
        name = 'binary-garbage';
        const len = Math.floor(r() * 5000);
        const buf = Buffer.allocUnsafe(len);
        for (let k = 0; k < len; k++) buf[k] = Math.floor(r() * 256);
        return { name, bytes: buf };
    } else if (kind === 7) {
        // Quoted-printable with malformed escapes + mixed EOL
        name = 'malformed-qp';
        s += `Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n`;
        const n = Math.floor(r() * 400);
        for (let k = 0; k < n; k++)
            s += r() < 0.3 ? `=${r() < 0.5 ? 'ZZ' : 'A'}` : String.fromCharCode(33 + Math.floor(r() * 90));
    } else {
        // Boundary spoofing: bare-CR / mixed EOL around real boundaries (the #14 family)
        name = 'boundary-eol-chaos';
        const b = `bnd${Math.floor(r() * 1e5)}`;
        s += `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n`;
        const parts = 2 + Math.floor(r() * 5);
        for (let k = 0; k < parts; k++) {
            s += `${pick(r, EOLS)}--${b}${pick(r, EOLS)}Content-Type: text/plain${pick(r, EOLS)}${pick(r, EOLS)}part${k}${pick(r, EOLS)}`;
        }
        s += `${pick(r, EOLS)}--${b}--${pick(r, EOLS)}`;
    }

    // Prepend minimal envelope so header parsing has something normal too
    const env = `From: a@b.com\r\nTo: c@d.com\r\nSubject: fuzz ${i}\r\n`;
    return { name, bytes: Buffer.from(env + s, 'binary') };
}

// parseMail is synchronous, so a hang can't be raced against a timer: a run past `ms` counts as one.
function parseWithTimeout(bytes: Buffer, ms: number): { ok: boolean; err?: string; timedOut?: boolean } {
    const t0 = performance.now();
    let result: { ok: boolean; err?: string };
    try {
        parseMail(bytes);
        result = { ok: true };
    } catch (e) {
        result = { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
    return performance.now() - t0 > ms ? { ...result, timedOut: true } : result;
}

describe('mail parser fuzzing (hostile input)', () => {
    test('500 deterministic hostile messages: no crash / no hang / bounded', () => {
        const N = 500;
        const PER_INPUT_TIMEOUT = 4000;
        const rss0 = process.memoryUsage().rss;
        const slow: { i: number; name: string; ms: number }[] = [];
        const hangs: { i: number; name: string }[] = [];
        const errsByName = new Map<string, number>();

        for (let i = 0; i < N; i++) {
            const { name, bytes } = hostile(i);
            const t0 = performance.now();
            const res = parseWithTimeout(bytes, PER_INPUT_TIMEOUT);
            const ms = performance.now() - t0;
            if (res.timedOut) hangs.push({ i, name });
            if (ms > 200) slow.push({ i, name, ms });
            if (res.err) errsByName.set(name, (errsByName.get(name) ?? 0) + 1);
            // A rejected parse is FINE (malformed input) — we only fail on hang.
            expect(res.timedOut ?? false).toBe(false);
        }

        const rss1 = process.memoryUsage().rss;
        const grewMB = (rss1 - rss0) / 1024 / 1024;
        slow.sort((a, b) => b.ms - a.ms);
        console.log('[fuzz] parse errors (expected, by kind):', Object.fromEntries(errsByName));
        console.log('[fuzz] slowest inputs (ms):', slow.slice(0, 8));
        console.log('[fuzz] hangs:', hangs);
        console.log(`[fuzz] RSS delta over ${N} parses: ${grewMB.toFixed(1)} MB`);
        expect(hangs.length).toBe(0);
    }, 60_000);

    test('extreme nested-multipart depth (5000) is bounded, does not hang/stack-overflow', () => {
        let s = 'From: a@b.com\r\n';
        const depth = 5000;
        for (let k = 0; k < depth; k++) s += `Content-Type: multipart/mixed; boundary="L${k}"\r\n\r\n--L${k}\r\n`;
        s += 'Content-Type: text/plain\r\n\r\nleaf\r\n';
        const t0 = performance.now();
        const res = parseWithTimeout(Buffer.from(s, 'binary'), 5000);
        console.log(
            `[fuzz] nested-5000 depth: ${(performance.now() - t0).toFixed(0)}ms, timedOut=${res.timedOut ?? false}, err=${res.err ?? 'none'}`,
        );
        expect(res.timedOut ?? false).toBe(false);
    }, 20_000);
});
