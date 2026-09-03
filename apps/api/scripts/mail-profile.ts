// Phase attribution for mail cold sync: fs read vs MIME parse vs sqlite insert.
// Companion to mail-bench.ts — see docs/MAIL.md § Performance design.
//
// Run from the repo root (so @workspace/* resolves):
//   N=10000 bun apps/api/scripts/mail-profile.ts
//
// Scratch data goes to $TMPDIR/eigen-mail-profile and is removed afterwards.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Email } from '@workspace/lib/types/mail';
import { LocalFilesystem } from '../src/lib/core/local-filesystem';
import { type DatabaseConfig, openLocalDatabase, type SchemaType } from '../src/lib/core/managed-database';
import type { Home } from '../src/lib/home/home';
import { parseEml } from '../src/lib/mail/mail-parse';
import MailDB from '../src/lib/mail/maildb';
import {
    applyFlagsFromFilename,
    buildMaildirFilename,
    createUniqueMessageId,
    getMailIDfromFileName,
} from '../src/lib/mail/mailutils';

const N = Number.parseInt(process.env['N'] ?? '10000', 10);
const ROOT = path.join(tmpdir(), 'eigen-mail-profile');
rmSync(ROOT, { recursive: true, force: true });
const CUR = path.join(ROOT, 'cur');
mkdirSync(CUR, { recursive: true });

// generate N cur/ files
let seed = 424242;
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
};
for (let i = 0; i < N; i++) {
    const body = `From: Sender ${i} <s${i}@seed.test>\r\nTo: me@seed.test\r\nSubject: [SEED] msg #${i}\r\nDate: Mon, 1 Jan 2025 10:00:00 +0000\r\nMessage-ID: <${createUniqueMessageId()}@seed.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLorem ipsum dolor sit amet, message ${i}. Padding padding padding.\r\n`;
    const size = Buffer.byteLength(body);
    writeFileSync(
        path.join(CUR, buildMaildirFilename(createUniqueMessageId(), { seen: rand() > 0.2, flagged: false }, size)),
        body,
    );
}

const storage = new LocalFilesystem(ROOT);
const t0 = performance.now();
const files = readdirSync(CUR).filter((f) => !f.startsWith('.'));
const tRead = performance.now() - t0;

// parse phase only
const parsed: Email[] = [];
const tp0 = performance.now();
for (const f of files) {
    const id = getMailIDfromFileName(f);
    const file = storage.file(path.join('cur', f));
    const p = await parseEml(id, '', file);
    applyFlagsFromFilename(p, f);
    p.filename = f;
    parsed.push(p);
}
const tParse = performance.now() - tp0;

// sqlite insert phase only
const fakeHome = {
    homeDir: ROOT,
    destructing: false,
    getLocalDatabase<S extends SchemaType>(config: DatabaseConfig<S>, relativePath: string) {
        return openLocalDatabase(config, path.join(ROOT, relativePath));
    },
} as unknown as Home;
const db = new MailDB(fakeHome);
await db.init();
const ti0 = performance.now();
for (const p of parsed) db.addEmail(p);
const tInsert = performance.now() - ti0;

const perMsg = (t: number) => ((t * 1000) / N).toFixed(1);
console.log(`\n=== cold-sync phase attribution (N=${N.toLocaleString()}) ===`);
console.log(`readdir(cur)      ${tRead.toFixed(0)} ms          (${perMsg(tRead)} µs/msg)`);
console.log(`parseEml (MIME)   ${(tParse / 1000).toFixed(1)} s   (${perMsg(tParse)} µs/msg)`);
console.log(`sqlite addEmail   ${(tInsert / 1000).toFixed(1)} s   (${perMsg(tInsert)} µs/msg)`);
const tot = tRead + tParse + tInsert;
console.log(`--------------------------------------------`);
console.log(`parse  share:  ${((100 * tParse) / tot).toFixed(1)}%`);
console.log(`sqlite share:  ${((100 * tInsert) / tot).toFixed(1)}%`);
console.log(`fs     share:  ${((100 * tRead) / tot).toFixed(1)}%`);
await db.destruct();
rmSync(ROOT, { recursive: true, force: true });
