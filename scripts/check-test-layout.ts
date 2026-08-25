// Enforce the test layout: every workspace keeps its tests in <workspace>/src/test/,
// and every workspace that has tests can actually run them.
//
// The second check matters as much as the first — `bun --filter '*' test` silently skips
// a workspace with no test script, so a test file there would never run and `bun run check`
// would still pass. See docs/TESTING.md.

import { Glob } from 'bun';

const WORKSPACE_GLOBS = ['apps/*', 'packages/*'];

const workspaces: string[] = [];
for (const pattern of WORKSPACE_GLOBS) {
    const [parent] = pattern.split('/');
    for await (const entry of new Glob('*/package.json').scan(parent)) {
        workspaces.push(`${parent}/${entry.replaceAll('\\', '/').split('/')[0]}`);
    }
}
workspaces.sort();

const stray: string[] = [];
const unrunnable: string[] = [];

for (const workspace of workspaces) {
    let hasTests = false;

    for await (const entry of new Glob('**/*.test.{ts,tsx}').scan(workspace)) {
        const path = entry.replaceAll('\\', '/');
        if (path.startsWith('node_modules/')) continue;
        if (path.startsWith('src/test/')) {
            hasTests = true;
            continue;
        }
        stray.push(`${workspace}/${path}`);
        hasTests = true;
    }

    if (!hasTests) continue;
    const pkg = await Bun.file(`${workspace}/package.json`).json();
    if (!pkg.scripts?.test) unrunnable.push(workspace);
}

if (stray.length > 0) {
    console.error('ERROR: test files must live in <workspace>/src/test/\n');
    for (const path of stray) console.error(`  ${path}`);
    console.error('\nSee docs/TESTING.md for the layout rule.');
}

if (unrunnable.length > 0) {
    console.error('\nERROR: workspace has tests but no "test" script — they would never run\n');
    for (const workspace of unrunnable) console.error(`  ${workspace}`);
    console.error('\nAdd "test": "bun test" to its package.json.');
}

if (stray.length > 0 || unrunnable.length > 0) process.exit(1);
