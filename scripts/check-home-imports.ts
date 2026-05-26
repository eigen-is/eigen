// Enforce that getHome() is only imported in routes and home-relay.ts.
// Lib code must receive Home as a parameter or use relay pull*/sendToHome functions.

import { Glob } from 'bun';

// Pre-existing files pending refactor to receive Home as parameter.
// Do NOT add new files here — pass Home from the route instead.
const ALLOWED = new Set([
    'get-calendar.ts',
    'enforcement.ts',
    'mail.ts',
    'contacts.ts',
    'get-drive.ts',
    'caldav-router.ts',
    'reconciliation.ts',
]);

const glob = new Glob('**/*.ts');
const violations: string[] = [];

for await (const path of glob.scan('apps/api/src/lib')) {
    // Bun.Glob yields platform-native separators on Windows — normalise so the basename
    // extraction and the home/ prefix check work regardless of platform.
    const normalized = path.replaceAll('\\', '/');
    const filename = normalized.split('/').pop()!;
    if (normalized.startsWith('home/')) continue;
    if (ALLOWED.has(filename)) continue;

    const content = await Bun.file(`apps/api/src/lib/${path}`).text();
    if (content.includes('getHome')) {
        violations.push(`apps/api/src/lib/${normalized}`);
    }
}

if (violations.length > 0) {
    console.error('ERROR: getHome() must not be imported in lib/ (use home-relay or pass Home as parameter)\n');
    for (const v of violations) console.error(`  ${v}`);
    console.error('\nSee docs/SCALABILITY.md for the home relay pattern.');
    process.exit(1);
}
