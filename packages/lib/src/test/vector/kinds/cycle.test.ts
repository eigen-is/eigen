import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ELEMENT_FIELDS } from '../../../vector/kinds';

// The runtime back-edges inside vector/: geometry ↔ kinds (kind.ts takes geometry's box primitives while
// geometry dispatches through the registry), geometry ↔ elbow-pins, geometry ↔ elbow-route,
// elbow-heading ↔ kinds (arrow.ts reads the heading helpers), and elbow-route → elbow-heading →
// geometry → elbow-route. ELEMENT_FIELDS is built during module evaluation off the imported kinds, so an
// entry order that evaluates kinds/index.ts while a kind binding is still in its TDZ would yield a short
// table — which is why each order gets its OWN PROCESS. Two awaited imports in one test process prove
// nothing: the second only reads Bun's already-populated module registry.

const VECTOR_DIR = join(import.meta.dir, '../../../vector');

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

describe('the vector engine survives either entry order', () => {
    test('geometry as the process entry still builds the full field table', async () => {
        expect(await elementFieldsFromEntry('geometry.ts')).toEqual([...ELEMENT_FIELDS]);
    });

    test('kinds as the process entry builds the same table', async () => {
        expect(await elementFieldsFromEntry('kinds/index.ts')).toEqual([...ELEMENT_FIELDS]);
    });
});
