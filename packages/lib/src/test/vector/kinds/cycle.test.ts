import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ELEMENT_FIELDS } from '../../../vector/kinds';

// Every module of the vector engine must load first in a fresh process. A module that sits on an import
// cycle and runs its body before a module it needs has finished throws a TDZ ReferenceError there, and
// only on that entry order.
//
// The registry builds ELEMENT_FIELDS while it evaluates, so each entry runs in a process of its own. Two
// imports in one test process prove nothing: the second only reads Bun's module registry, which the first
// already filled.

const VECTOR_DIR = join(import.meta.dir, '../../../vector');

const KIND_MODULES = readdirSync(join(VECTOR_DIR, 'kinds'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `kinds/${file}`);

async function elementFieldsFromEntry(entry: string): Promise<string[]> {
    const script = `await import(${JSON.stringify(join(VECTOR_DIR, entry))});
const kinds = await import(${JSON.stringify(join(VECTOR_DIR, 'kinds/index.ts'))});
console.log(JSON.stringify(kinds.ELEMENT_FIELDS));`;
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(err).toBe('');
    expect(code).toBe(0);
    return JSON.parse(out);
}

describe('every vector module loads first and builds the full field table', () => {
    const entries = [
        'geometry.ts',
        'binding.ts',
        'heading.ts',
        'elbow-heading.ts',
        'elbow-route.ts',
        'elbow-pins.ts',
        'index.ts',
        ...KIND_MODULES,
        '../charts/index.ts',
        '../docs/eigendoc/index.ts',
    ];
    test.each(entries)('%s as the process entry', async (entry) => {
        expect(await elementFieldsFromEntry(entry)).toEqual([...ELEMENT_FIELDS]);
    });
});
