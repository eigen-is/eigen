// Standalone mail-backend performance benchmark for MaildirStore.
//
// Measures cold sync / warm sync / incremental sync / list query / single mutations
// against a large maildir, WITHOUT touching the repo's data/ dir or the dev server.
// Produced the measured table in docs/MAIL.md § Performance design.
//
// Run from the repo root (so @workspace/* resolves):
//   INBOX=50000 ARCHIVE=50000 INCREMENTAL=1000 bun apps/api/scripts/mail-bench.ts
//
// Scratch data goes to $TMPDIR/eigen-mail-bench (override with BENCH_ROOT). The dir is
// wiped at the start of each run and left behind afterwards for inspection.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { type DatabaseConfig, openLocalDatabase, type SchemaType } from '../src/lib/core/managed-database';
import type { Home } from '../src/lib/home/home';
import type MailDB from '../src/lib/mail/maildb';
import { MaildirStore } from '../src/lib/mail/maildir-store';
import { buildMaildirFilename, createUniqueMessageId } from '../src/lib/mail/mailutils';

const BENCH_ROOT = process.env['BENCH_ROOT'] ?? path.join(tmpdir(), 'eigen-mail-bench');
const HOME_DIR = path.join(BENCH_ROOT, 'home');
const MAILDIR = path.join(HOME_DIR, 'eigen.mail', 'Maildir');

const INBOX = Number.parseInt(process.env['INBOX'] ?? '50000', 10);
const ARCHIVE = Number.parseInt(process.env['ARCHIVE'] ?? '50000', 10);
const INCREMENTAL = Number.parseInt(process.env['INCREMENTAL'] ?? '1000', 10);
const NEW_FRACTION = 0.15;

// ---- fresh workspace ----
rmSync(BENCH_ROOT, { recursive: true, force: true });
mkdirSync(HOME_DIR, { recursive: true });

// ---- minimal fake Home (only what MaildirStore + MailDB touch) ----
const fakeHome = {
    homeDir: HOME_DIR,
    destructing: false,
    getLocalDatabase<S extends SchemaType>(config: DatabaseConfig<S>, relativePath: string) {
        return openLocalDatabase(config, path.join(HOME_DIR, relativePath));
    },
} as unknown as Home;

const noopEvents = {
    received: () => {},
    flagsChanged: () => {},
    deleted: () => {},
};

// ---- RFC822 generation (mirrors seed-test-mail.ts) ----
let seed = 987654321;
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
};
const firstNames = ['Alex', 'Marloes', 'Sam', 'Priya', 'Jonas', 'Yuki', 'Fatima', 'Diego', 'Nora', 'Wei'];
const lastNames = ['Jansen', 'Okonkwo', 'Nakamura', 'Silva', 'Muller', 'Rossi', 'Andersson', 'Kowalski'];
const subjects = [
    'Invoice',
    'Meeting notes',
    'Re: proposal',
    'Weekly newsletter',
    'Deploy finished',
    'Reminder',
    'Your receipt',
    'Action required',
    'FYI',
    'Quarterly report',
];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const baseMs = 1_752_000_000_000;
const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)] as T;

function rfc822(i: number, mailbox: string, extAddr: string, to: string): string {
    const d = new Date(baseMs - Math.floor(rand() * 365 * 24 * 60 * 60 * 1000));
    const dateHdr = `${dows[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 +0000`;
    return (
        `From: ${extAddr}\r\n` +
        `To: ${to}\r\n` +
        `Subject: [SEED] ${pick(subjects)} #${i}\r\n` +
        `Date: ${dateHdr}\r\n` +
        `Message-ID: <seed-${i}-${createUniqueMessageId()}@seed.eigen.test>\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
        `Seeded ${mailbox === '' ? 'inbox' : mailbox.toLowerCase()} message ${i} for stress testing. ` +
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Delete all [SEED] mail when done.\r\n`
    );
}

const USER_EMAIL = 'bench@eigen.test';
function mailboxDir(mailbox: string): string {
    return mailbox === '' ? MAILDIR : path.join(MAILDIR, `.${mailbox}`);
}
function ensureMailbox(mailbox: string) {
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(path.join(mailboxDir(mailbox), sub), { recursive: true });
}

let gid = 0;
function generate(mailbox: string, n: number, onlyNew = false) {
    ensureMailbox(mailbox);
    const curDir = path.join(mailboxDir(mailbox), 'cur');
    const newDir = path.join(mailboxDir(mailbox), 'new');
    for (let k = 0; k < n; k++) {
        gid++;
        const extAddr = `${pick(firstNames)} ${pick(lastNames)} <seed${gid}@seed.eigen.test>`;
        const body = rfc822(gid, mailbox, extAddr, USER_EMAIL);
        const size = Buffer.byteLength(body);
        const uid = createUniqueMessageId();
        if (onlyNew || rand() < NEW_FRACTION) {
            writeFileSync(path.join(newDir, `${uid},S=${size}`), body);
        } else {
            const flags = { seen: rand() > 0.2, flagged: rand() < 0.08, draft: false };
            writeFileSync(path.join(curDir, buildMaildirFilename(uid, flags, size)), body);
        }
    }
}

// ---- timing helpers ----
const ms = (f: () => Promise<void> | void) => {
    const t = performance.now();
    const r = f();
    if (r instanceof Promise) return r.then(() => performance.now() - t);
    return Promise.resolve(performance.now() - t);
};
const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (n: number) => n.toLocaleString('en-US');

// ============================ RUN ============================
console.log(`\n=== eigen mail backend benchmark ===`);
console.log(`Inbox target: ${fmt(INBOX)}   Archive target: ${fmt(ARCHIVE)}   incremental: ${fmt(INCREMENTAL)}`);
console.log(`Bench root: ${BENCH_ROOT}\n`);

const results: Record<string, string> = {};

// Init store (creates standard mailbox dirs + fresh mail.db)
const store = new MaildirStore(fakeHome);
// Reach past `private` for the internals the benchmark times directly.
const internals = store as unknown as { syncMailbox(mailbox: string): Promise<void>; db: MailDB };
await store.init(noopEvents);

// 1) Generate (timed separately, not a result)
const genT = await ms(() => {
    generate('', INBOX);
    generate('Archive', ARCHIVE);
});
const total = INBOX + ARCHIVE;
console.log(
    `[gen] wrote ${fmt(total)} files in ${(genT / 1000).toFixed(1)}s  (${fmt(Math.round(total / (genT / 1000)))} files/s)\n`,
);

// 2) Cold sync (full index of both mailboxes)
const coldInbox = await ms(() => internals.syncMailbox(''));
const coldArchive = await ms(() => internals.syncMailbox('Archive'));
const coldTotal = coldInbox + coldArchive;
results[`cold-sync (${fmt(total)}, both)`] =
    `${(coldTotal / 1000).toFixed(1)}s  |  ${fmt(Math.round(total / (coldTotal / 1000)))} msg/s`;
console.log(
    `[cold] inbox ${(coldInbox / 1000).toFixed(1)}s  archive ${(coldArchive / 1000).toFixed(1)}s  total ${(coldTotal / 1000).toFixed(1)}s  (${fmt(Math.round(total / (coldTotal / 1000)))} msg/s)`,
);

const dbCount = internals.db.getEmailsCount('') + internals.db.getEmailsCount('Archive');
console.log(
    `[cold] indexed rows: inbox ${fmt(internals.db.getEmailsCount(''))}  archive ${fmt(internals.db.getEmailsCount('Archive'))}  (total ${fmt(dbCount)})\n`,
);

// 3) Warm no-op sync (nothing changed) — median of 3, on Inbox
const warm: number[] = [];
for (let i = 0; i < 3; i++) warm.push(await ms(() => internals.syncMailbox('')));
results[`warm no-op sync (${fmt(INBOX)} inbox)`] =
    `${median(warm).toFixed(1)} ms  (runs: ${warm.map((x) => x.toFixed(0)).join('/')})`;
console.log(`[warm] no-op inbox sync median ${median(warm).toFixed(1)} ms`);

// 4) Incremental sync (add N new mails to inbox new/, re-sync)
generate('', INCREMENTAL, true);
const incT = await ms(() => internals.syncMailbox(''));
results[`incremental sync (+${fmt(INCREMENTAL)} new)`] =
    `${incT.toFixed(0)} ms  (${fmt(Math.round(INCREMENTAL / (incT / 1000)))} new-msg/s)`;
console.log(
    `[incr] +${fmt(INCREMENTAL)} new synced in ${incT.toFixed(0)} ms  (inbox now ${fmt(internals.db.getEmailsCount(''))})\n`,
);

// 5) List query (the DB read behind GET list) + payload size — median of 3
const listTimes: number[] = [];
let listRows: EmailSummary[] = [];
for (let i = 0; i < 3; i++) {
    const t = performance.now();
    listRows = internals.db.getAllEmails('');
    listTimes.push(performance.now() - t);
}
const payload = Buffer.byteLength(JSON.stringify(listRows));
results[`list query getAllEmails (${fmt(INBOX)})`] = `${median(listTimes).toFixed(1)} ms  |  ${listRows.length} rows`;
results[`list JSON payload (${fmt(INBOX)} inbox)`] =
    `${(payload / 1024 / 1024).toFixed(2)} MB  (${(payload / listRows.length).toFixed(0)} B/row)`;
console.log(`[list] getAllEmails('') median ${median(listTimes).toFixed(1)} ms, ${fmt(listRows.length)} rows`);
console.log(
    `[list] JSON.stringify payload ${(payload / 1024 / 1024).toFixed(2)} MB  (${(payload / listRows.length).toFixed(0)} B/row)`,
);
// listMessages() (what the route ACTUALLY calls) = syncMailbox + one keyset page read
const listMsgFull = await ms(async () => {
    await store.listMessages('', { limit: 200 });
});
results['listMessages() page (route path)'] = `${listMsgFull.toFixed(0)} ms  (includes a no-op sync)`;
console.log(`[list] listMessages('') route path ${listMsgFull.toFixed(0)} ms (sync + page read)\n`);

// 6) Single mutations at full DB size — median of 3 each
const moveTimes: number[] = [];
const flagTimes: number[] = [];
for (let i = 0; i < 3; i++) {
    const victims = internals.db.getAllEmails('');
    const id = victims[victims.length - 1 - i]!.id;
    moveTimes.push(await ms(() => store.move(id, 'Archive')));
}
for (let i = 0; i < 3; i++) {
    const rows = internals.db.getAllEmails('');
    const row = rows[i]!;
    flagTimes.push(await ms(() => store.setFlags(row.id, { seen: !row.isRead })));
}
results['single move (archive) @full'] =
    `${median(moveTimes).toFixed(1)} ms  (runs: ${moveTimes.map((x) => x.toFixed(1)).join('/')})`;
results['single setFlags @full'] =
    `${median(flagTimes).toFixed(1)} ms  (runs: ${flagTimes.map((x) => x.toFixed(1)).join('/')})`;
console.log(
    `[mut] move median ${median(moveTimes).toFixed(1)} ms   setFlags median ${median(flagTimes).toFixed(1)} ms\n`,
);

// ---- results table ----
console.log('======================= RESULTS =======================');
const w = Math.max(...Object.keys(results).map((k) => k.length));
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(w)}  |  ${v}`);
console.log('=======================================================');
console.log(`\nNote: incremental sync time ≈ storeLock hold time (doSyncMailbox runs under the lock).`);

await store.destruct();
