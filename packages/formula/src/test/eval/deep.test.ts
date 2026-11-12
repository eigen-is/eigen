import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEEP, deepest } from './deep';

// Bun gives a worker the stack of the main thread whatever it is asked for, so the small stack is Node's.
test.skipIf(Bun.which('node') === null)(
    'the deepest formulas compute on a Node worker with half a megabyte of stack',
    async () => {
        const folder = mkdtempSync(join(tmpdir(), 'formula-deep-'));
        try {
            const built = await Bun.build({
                entrypoints: [join(import.meta.dir, 'deep.ts')],
                target: 'node',
                outdir: folder,
            });
            expect(built.success).toBe(true);
            const run = Bun.spawnSync(['node', built.outputs[0].path, 'workers', '0.5']);
            expect(run.stderr.toString()).toBe('');
            const answers: unknown = JSON.parse(run.stdout.toString());
            const expected: Record<string, unknown> = {};
            for (const shape of Object.keys(DEEP)) {
                expected[shape] = deepest(shape);
                expect(typeof expected[shape]).toBe('number');
            }
            expect(answers).toEqual(expected);
        } finally {
            rmSync(folder, { recursive: true });
        }
    },
    60000,
);
