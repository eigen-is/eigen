// A check that `bun run check` runs, with four rules that keep one owner's Home apart from another's. In lib/, code
// outside lib/home/ and its allowlist may not name a function that hands out a Home, such as getHome(); a home-calls.ts
// may import types only; and only listed files may name getSharedDrive. In routes/ and the CalDAV router, a call that
// opens a Home or a drive passes params.ownerId or user.id, or is listed. It reads text, so it cannot follow a value
// through a helper, an alias or a shadowed name: a wrapper that takes an ownerId is listed once, its callers unchecked.

import { Glob } from 'bun';

// Paths under lib/. A domain's `get-*.ts` resolver turns a route's ownerId into its domain object behind the access
// check; the others are older files pending a refactor. Add no other: pass the Home from the route, or use a resolver.
const ALLOWED = new Set([
    'calendar/get-calendar.ts',
    'contacts/get-contacts.ts',
    'drive/get-drive.ts',
    'config/enforcement.ts',
    'mail/mail.ts',
    'caldav/caldav-router.ts',
]);

// getSharedDrive opens another owner's drive under the signed-in user's permission, outside the relay.
const SHARED_DRIVE_FILES = new Set([
    'drive/get-drive.ts', // defines it
    'drive/index.ts', // the barrel
    'drive/shared-drive.ts', // a comment names it
    'drive/drive.ts', // a comment names it
    // Routed: the WebDAV router hands them the URL's owner and the signed-in user.
    'webdav/propfind.ts',
    'webdav/proppatch.ts',
    'webdav/locks.ts',
    'webdav/resource.ts',
    'webdav/move-copy.ts',
    'drive/import-source.ts', // import from another owner's drive
    'mail/mail.ts', // attach from a drive, save an attachment to one
    'mail/access-grants.ts', // share a file on send
]);

// A file and the first argument it passes that is neither the URL's owner nor the signed-in user.
const OTHER_OWNER_CALLS = new Set([
    'routes/drive.ts: body.targetOwnerId', // a copy's target drive, under the user's own access
    'routes/collab.ts: ownerId', // the socket's URL owner, destructured from ws.data.params
    'routes/backup.ts: ownerId', // an admin's restore warms the Home it just wrote
]);

// `\s*` reads across a line break, so a call the formatter wrapped is checked too.
const OWNER_CALL = /\b(getHome|getTeamHome|getUserHome|getSharedDrive)\(\s*([^,)]*)/g;

const namesHome: string[] = [];
const valueImports: string[] = [];
const namesSharedDrive: string[] = [];
const otherOwnerCalls: string[] = [];

for await (const path of new Glob('**/*.ts').scan('apps/api/src/lib')) {
    // Bun.Glob yields the platform's separators, so a Windows path is normalized before it is compared.
    const normalized = path.replaceAll('\\', '/');
    const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
    const isTable = filename === 'home-calls.ts';
    const mayNameHome = normalized.startsWith('home/') || ALLOWED.has(normalized);
    const content = await Bun.file(`apps/api/src/lib/${path}`).text();

    // Each of these hands out another owner's Home.
    if (!mayNameHome && /\b(getHome|openHome|loadedHome|getTeamHome|getUserHome)\b/.test(content)) {
        namesHome.push(`apps/api/src/lib/${normalized}`);
    }
    if (!SHARED_DRIVE_FILES.has(normalized) && /\bgetSharedDrive\b/.test(content)) {
        namesSharedDrive.push(`apps/api/src/lib/${normalized}`);
    }
    if (normalized === 'caldav/caldav-router.ts') checkOwnerCalls(`lib/${normalized}`, content);
    // The relay spreads each table while it loads. A table that loaded a module leading back to the relay would make
    // the relay run first and read the table before it exists.
    if (isTable) {
        for (const line of content.split('\n')) {
            const statement = line.trim();
            const loadsModule =
                (statement.startsWith('import ') && !statement.startsWith('import type ')) ||
                (/^export .* from /.test(statement) && !statement.startsWith('export type ')) ||
                statement.includes('require(');
            if (loadsModule) valueImports.push(`apps/api/src/lib/${normalized}: ${statement}`);
        }
    }
}

for await (const path of new Glob('**/*.ts').scan('apps/api/src/routes')) {
    const normalized = path.replaceAll('\\', '/');
    checkOwnerCalls(`routes/${normalized}`, await Bun.file(`apps/api/src/routes/${path}`).text());
}

function checkOwnerCalls(file: string, content: string): void {
    for (const match of content.matchAll(OWNER_CALL)) {
        const argument = match[2].trim();
        if (argument === 'params.ownerId' || argument === 'user.id') continue;
        if (OTHER_OWNER_CALLS.has(`${file}: ${argument}`)) continue;
        const line = content.slice(0, match.index).split('\n').length;
        otherOwnerCalls.push(`apps/api/src/${file}:${line}: ${match[1]} is passed ${argument}`);
    }
}

if (namesHome.length > 0) {
    console.error(
        'ERROR: lib/ outside lib/home/ may not name getHome, openHome, loadedHome, getTeamHome or getUserHome (use home-relay or pass Home as a parameter)\n',
    );
    for (const file of namesHome) console.error(`  ${file}`);
    console.error('\nSee docs/SCALABILITY.md for the home relay pattern.\n');
}

if (valueImports.length > 0) {
    console.error(
        'ERROR: a home-calls.ts may have only `import type` lines (its handlers call methods on the Home they are given)\n',
    );
    for (const line of valueImports) console.error(`  ${line}`);
}

if (namesSharedDrive.length > 0) {
    console.error(
        "ERROR: lib/ may name getSharedDrive only in a file on SHARED_DRIVE_FILES (take the Drive as a parameter; a new entry is the owner's call)\n",
    );
    for (const file of namesSharedDrive) console.error(`  ${file}`);
}

if (otherOwnerCalls.length > 0) {
    console.error(
        'ERROR: in routes/ and the CalDAV router, getHome, getTeamHome, getUserHome and getSharedDrive take params.ownerId or user.id (pass one of them, or ask the owner to list the file and argument on OTHER_OWNER_CALLS)\n',
    );
    for (const call of otherOwnerCalls) console.error(`  ${call}`);
}

if (namesHome.length + valueImports.length + namesSharedDrive.length + otherOwnerCalls.length > 0) process.exit(1);
