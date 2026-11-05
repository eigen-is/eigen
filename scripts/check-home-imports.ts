// A check that `bun run check` runs: lib/ code outside lib/home/ and the allowlist below may not name a function
// that hands out a Home, such as getHome() or openHome(). Lib code receives its Home as a parameter or goes through
// the relay's pull*/sendToHome functions.

import { Glob } from 'bun';

// The `get-*.ts` resolvers are the allowed shape by design: one per domain, the single place a route turns
// an ownerId into its domain object behind the access check. The rest are pre-existing and pending refactor.
// Do NOT add new files here — pass Home from the route, or go through the domain's resolver.
const ALLOWED = new Set([
    'get-calendar.ts',
    'enforcement.ts',
    'mail.ts',
    'get-contacts.ts',
    'get-drive.ts',
    'caldav-router.ts',
]);

const glob = new Glob('**/*.ts');
const violations: string[] = [];

for await (const path of glob.scan('apps/api/src/lib')) {
    // Bun.Glob yields platform-native separators on Windows — normalize so the basename
    // extraction and the home/ prefix check work regardless of platform.
    const normalized = path.replaceAll('\\', '/');
    const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (normalized.startsWith('home/')) continue;
    if (ALLOWED.has(filename)) continue;

    const content = await Bun.file(`apps/api/src/lib/${path}`).text();
    // Each of these hands out another owner's Home.
    if (/\b(getHome|openHome|loadedHome|getTeamHome|getUserHome)\b/.test(content)) {
        violations.push(`apps/api/src/lib/${normalized}`);
    }
}

if (violations.length > 0) {
    console.error(
        'ERROR: getHome(), openHome() and loadedHome() must not be imported in lib/ (use home-relay or pass Home as parameter)\n',
    );
    for (const v of violations) console.error(`  ${v}`);
    console.error('\nSee docs/SCALABILITY.md for the home relay pattern.');
    process.exit(1);
}
