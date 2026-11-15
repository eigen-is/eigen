// A check that `bun run check` runs, with the two rules that keep one owner's Home apart from another's in lib/. Code
// outside lib/home/ and the allowlist below may not name a function that hands out a Home, such as getHome() or
// openHome(): it receives its Home as a parameter or goes through the relay, such as sendToHome and getFromHomes. And
// a home-calls.ts, a domain's table of handlers that the relay loads, may import types only.

import { Glob } from 'bun';

// A `get-*.ts` resolver is the one place a route turns an ownerId into its domain object behind the access check.
// Add no other file: pass the Home from the route, or go through the domain's resolver.
const ALLOWED = new Set([
    'get-calendar.ts',
    'enforcement.ts',
    'mail.ts',
    'get-contacts.ts',
    'get-drive.ts',
    'caldav-router.ts',
]);

const namesHome: string[] = [];
const valueImports: string[] = [];

for await (const path of new Glob('**/*.ts').scan('apps/api/src/lib')) {
    // Bun.Glob yields the platform's separators, so a Windows path is normalized before it is compared.
    const normalized = path.replaceAll('\\', '/');
    const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
    const isTable = filename === 'home-calls.ts';
    const mayNameHome = normalized.startsWith('home/') || ALLOWED.has(filename);
    if (mayNameHome && !isTable) continue;

    const content = await Bun.file(`apps/api/src/lib/${path}`).text();
    // Each of these hands out another owner's Home.
    if (!mayNameHome && /\b(getHome|openHome|loadedHome|getTeamHome|getUserHome)\b/.test(content)) {
        namesHome.push(`apps/api/src/lib/${normalized}`);
    }
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

if (namesHome.length > 0 || valueImports.length > 0) process.exit(1);
