// Stress-test mail seeder: writes fake messages straight into a user's on-disk maildir,
// distributed across ALL standard mailboxes (Inbox / Sent / Drafts / Trash / Junk / Archive).
//
// Why: to load a real account with a large, believable mailbox for stress-testing the mail
// UI (list virtualization, search, keyboard shortcuts, per-mailbox counts) without going
// through SMTP/the delivery endpoint (which is rate-limited and only targets the Inbox).
//
// How it works: messages are written as raw RFC822 files directly into each mailbox's
// maildir. Inbox/Junk/Trash/Archive get an external `From` addressed to the user; Sent/Drafts
// get the user's own address as `From` (believable outgoing mail). A fraction land in `new/`
// (unseen) and the rest in `cur/` with realistic flags (mostly Seen, some Flagged; Drafts get
// the Draft flag). Every subject is prefixed `[SEED]` and every external address ends in
// `@seed.eigen.test`, so the whole set is trivially filterable and deletable afterwards.
//
// Usage:
//   bun run apps/api/src/scripts/seed-test-mail.ts                       # 10000 mails, first user
//   bun run apps/api/src/scripts/seed-test-mail.ts --count=50000         # custom count
//   bun run apps/api/src/scripts/seed-test-mail.ts --user=<userId>       # target a specific user
//   bun run apps/api/src/scripts/seed-test-mail.ts --count=2000 --user=<userId>
//   EIGEN_DATA_ROOT=/abs/path bun run apps/api/src/scripts/seed-test-mail.ts   # non-default data dir
//
// The target account picks it up on the next mailbox sync (open the app / reload). To clean up
// later, delete the `[SEED]` messages in the UI, or remove the seeded files from the maildir.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS, STANDARD_MAILBOXES } from '../lib/core/constants';
import { buildMaildirFilename, createUniqueMessageId } from '../lib/mail/mailutils';

// Data root: honour EIGEN_DATA_ROOT (as the server does), else the repo's ./data resolved from
// this file's location so the script works regardless of the cwd it's launched from.
const DATA_ROOT = process.env['EIGEN_DATA_ROOT'] || path.resolve(import.meta.dir, '../../../../data');

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        count: { type: 'string' },
        user: { type: 'string' },
    },
});
const count = values.count ? Number.parseInt(values.count, 10) : 10_000;
if (!Number.isFinite(count) || count <= 0) {
    console.error(`Invalid --count "${values.count}"`);
    process.exit(1);
}

// Resolve the target user (id + email + name) from the auth DB.
const usersDbPath = path.join(DATA_ROOT, 'server', 'users3.db');
if (!existsSync(usersDbPath)) {
    console.error(`users3.db not found at ${usersDbPath}. Set EIGEN_DATA_ROOT or run from the repo.`);
    process.exit(1);
}
const db = new Database(usersDbPath, { readonly: true });
type UserRow = { id: string; email: string; name: string | null };
const resolved = values.user
    ? (db.query('SELECT id, email, name FROM user WHERE id = ?').get(values.user) as UserRow | null)
    : (db.query('SELECT id, email, name FROM user ORDER BY created_at ASC LIMIT 1').get() as UserRow | null);
db.close();
if (!resolved) {
    console.error(values.user ? `No user with id ${values.user}` : 'No users found in users3.db');
    process.exit(1);
}
// A non-null local so the narrowing survives into the nested rfc822() closure below.
const account: UserRow = resolved;
if (!values.user) console.log(`No --user given — seeding the first account: ${account.email} (${account.id})`);
const userFrom = `${(account.name || account.email).replace(/[<>]/g, '')} <${account.email}>`;

// Maildir root for the user: <data>/home/<id>/eigen.mail/Maildir  (Inbox = root; others = .<Name>).
const maildirRoot = path.join(DATA_ROOT, 'home', account.id, PATHS.MAIL.ROOT, PATHS.MAIL.MAILDIR);
const mailboxDir = (mailbox: string) => (mailbox === '' ? maildirRoot : path.join(maildirRoot, `.${mailbox}`));

// Relative weights for how the messages spread across mailboxes (Inbox heaviest, like a real account).
const WEIGHTS: Record<string, number> = { '': 45, Archive: 25, Sent: 15, Junk: 6, Trash: 6, Drafts: 3 };
const NEW_FRACTION = 0.15; // share written to new/ (unseen) rather than cur/

const firstNames = [
    'Alex',
    'Marloes',
    'Sam',
    'Priya',
    'Jonas',
    'Yuki',
    'Fatima',
    'Diego',
    'Nora',
    'Wei',
    'Tomas',
    'Ingrid',
];
const lastNames = [
    'Jansen',
    'Okonkwo',
    'Nakamura',
    'Silva',
    'Muller',
    'Rossi',
    'Andersson',
    'Kowalski',
    'Delacroix',
    'Haddad',
];
const subjects = [
    'Invoice',
    'Meeting notes',
    'Re: proposal',
    'Weekly newsletter',
    'Deploy finished',
    'Standup summary',
    'Reminder',
    'Your receipt',
    'Action required',
    'FYI',
    'Re: Re: budget',
    'Design review',
    'Ticket updated',
    'Payment confirmation',
    'New comment',
    'Quarterly report',
    'Welcome aboard',
    'Password reset',
    'Your order shipped',
];

// Deterministic-ish PRNG so re-runs vary but a single run is reproducible-shaped (no Math.random import needed).
let seed = 1234567;
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000; // 2^31 divisor keeps the range [0, 1) so pick() never indexes past the end
};
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];

// Weighted mailbox chooser.
const weightedMailboxes: string[] = [];
for (const [mb, w] of Object.entries(WEIGHTS)) for (let i = 0; i < w; i++) weightedMailboxes.push(mb);

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const baseMs = 1_752_000_000_000; // fixed anchor (~mid-2025) — Date.now() is fine here but a constant keeps dates stable

function rfc822(i: number, mailbox: string, extAddr: string): string {
    const outgoing = mailbox === 'Sent' || mailbox === 'Drafts';
    const from = outgoing ? userFrom : extAddr;
    const to = outgoing ? extAddr : account.email;
    // Spread dates over the past ~year.
    const d = new Date(baseMs - Math.floor(rand() * 365 * 24 * 60 * 60 * 1000));
    const dateHdr = `${dows[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 +0000`;
    return (
        `From: ${from}\r\n` +
        `To: ${to}\r\n` +
        `Subject: [SEED] ${pick(subjects)} #${i}\r\n` +
        `Date: ${dateHdr}\r\n` +
        `Message-ID: <seed-${i}-${createUniqueMessageId()}@seed.eigen.test>\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
        `Seeded ${mailbox === '' ? 'inbox' : mailbox.toLowerCase()} message ${i} for stress testing. ` +
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Delete all [SEED] mail when done.\r\n`
    );
}

// Make sure new/cur/tmp exist for every mailbox we touch.
const ensured = new Set<string>();
function ensureMailbox(mailbox: string) {
    if (ensured.has(mailbox)) return;
    const dir = mailboxDir(mailbox);
    for (const sub of [PATHS.MAIL.NEW, PATHS.MAIL.CUR, PATHS.MAIL.TMP])
        mkdirSync(path.join(dir, sub), { recursive: true });
    ensured.add(mailbox);
}

const perMailbox: Record<string, number> = {};
const t0 = Date.now();
for (let i = 1; i <= count; i++) {
    const mailbox = pick(weightedMailboxes);
    ensureMailbox(mailbox);
    const extAddr = `${pick(firstNames)} ${pick(lastNames)} <seed${i}@seed.eigen.test>`;
    const body = rfc822(i, mailbox, extAddr);
    const size = Buffer.byteLength(body);
    const uid = createUniqueMessageId();

    const toNew = rand() < NEW_FRACTION;
    let dir: string;
    let filename: string;
    if (toNew) {
        // new/ files carry no ":2," info section — the store promotes them to cur/ on sync.
        dir = path.join(mailboxDir(mailbox), PATHS.MAIL.NEW);
        filename = `${uid},S=${size}`;
    } else {
        // cur/ files carry flags: mostly Seen; ~8% Flagged; Drafts get the Draft flag.
        const flags = { seen: rand() > 0.2, flagged: rand() < 0.08, draft: mailbox === 'Drafts' };
        dir = path.join(mailboxDir(mailbox), PATHS.MAIL.CUR);
        filename = buildMaildirFilename(uid, flags, size);
    }
    writeFileSync(path.join(dir, filename), body);
    perMailbox[mailbox] = (perMailbox[mailbox] ?? 0) + 1;
}

const label = (mb: string) => (mb === '' ? 'Inbox' : mb);
console.log(`Seeded ${count} messages for ${account.email} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const mb of STANDARD_MAILBOXES) console.log(`  ${label(mb).padEnd(8)} ${perMailbox[mb] ?? 0}`);
console.log('Open the account (or reload) to sync them in. Clean up later by deleting the [SEED] mail.');
