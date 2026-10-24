import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    generateNKeysBetween,
    type NewVectorElement,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    serializeFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { writePptx } from '../../lib/export/slides/pptx/to-pptx';
import { classifyPptx, runRoundtrip } from '../../scripts/pptx-audit';
import { PIXEL_PNG } from '../fixtures/pptx';

// The pptx writer's gate: what it compares, and that a writer that moves, changes or drops anything fails it.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-audit-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const WRITER = fileURLToPath(new URL('../../lib/export/slides/pptx/to-pptx.ts', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/pptx-audit.ts', import.meta.url));

const ELEMENTS: NewVectorElement[] = [
    {
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 400,
        height: 200,
        angle: 15,
        fill: serializeFill({ type: 'solid', color: '#ff8800', style: 'solid' }),
        strokeColor: '#222222',
        strokeWidth: 4,
        corners: 'straight',
    },
    {
        type: 'richtext',
        x: 600,
        y: 100,
        width: 600,
        height: 200,
        angle: 0,
        html: '<p>Plain <strong>bold</strong></p>',
        fontSize: 40,
        color: '#333333',
    },
    { type: 'image', x: 1300, y: 100, width: 300, height: 300, angle: 0, mediaName: 'pixel.png', objectFit: 'fill' },
];

// A deck of one slide named Agenda, as the editor stores one, written by our writer.
function deck(): Uint8Array {
    const doc = new Y.Doc();
    writeFrameInDoc(doc, { id: 'f1', index: 'a0', name: 'Agenda', width: 1920, height: 1080, background: '' });
    const keys = generateNKeysBetween(null, null, ELEMENTS.length);
    for (const [i, element] of ELEMENTS.entries())
        writeElementInDoc(doc, { ...element, frameId: 'f1' }, keys[i], SLIDES_STYLE_DEFAULTS, `el-${i}`);
    const media = [{ name: 'pixel.png', contentType: 'image/png', data: toTransferableBuffer(PIXEL_PNG.slice()) }];
    return writePptx(readVectorFromDoc(doc), { title: 'Round trip', media });
}

async function corpus(name: string, files: Record<string, Uint8Array | string>): Promise<string> {
    const dir = path.join(scratch, name);
    for (const [file, bytes] of Object.entries(files)) await Bun.write(path.join(dir, file), bytes);
    return dir;
}

// Its own directory: Bun's resolver keeps a listing of a directory it loaded a module from.
async function writer(name: string, source: string): Promise<string> {
    const module = path.join(fs.mkdtempSync(path.join(scratch, 'writer-')), `${name}.ts`);
    await Bun.write(module, source);
    return module;
}

describe('round trip', () => {
    test('our writer brings the deck back, every box to the EMU; a refused file is skipped', async () => {
        const dir = await corpus('roundtrip', { 'deck.pptx': deck(), 'bad.pptx': 'no zip' });
        const out = path.join(scratch, 'out-roundtrip');
        const meta = await runRoundtrip({ corpora: [dir], out, timeoutMs: 30_000 });
        expect(meta.outcomes).toEqual({ ok: 1, skipped: 1, crash: 0, timeout: 0, memory: 0 });
        expect([meta.pass, meta.unlisted, meta.listed]).toEqual([
            true,
            { differences: 0, files: 0 },
            { differences: 0, files: 0 },
        ]);
        expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toContain(
            '**Round trip pass: 2 files, 1 imported and written back, 1 skipped, 0 crashes, 0 cut; 0 unlisted differences in 0 files, 0 listed in 0.**',
        );
    }, 60_000);

    test('--dump keeps the bytes our writer wrote, under the file key, and refuses a dir another run filled', async () => {
        const dir = await corpus('dumped', { 'deck.pptx': deck(), 'bad.pptx': 'no zip' });
        const dump = path.join(scratch, 'dump');
        await runRoundtrip({ corpora: [dir], out: path.join(scratch, 'out-dumped'), dump, timeoutMs: 30_000 });
        expect(fs.readdirSync(path.join(dump, 'dumped'))).toEqual(['deck.pptx.pptx']);
        expect(new TextDecoder().decode(fs.readFileSync(path.join(dump, 'dumped/deck.pptx.pptx')).subarray(0, 2))).toBe(
            'PK',
        );
        await expect(runRoundtrip({ corpora: [dir], out: path.join(scratch, 'out-dumped'), dump })).rejects.toThrow(
            `${dump} is not empty`,
        );
    }, 60_000);

    test('a writer that moves a box, changes a run and drops a picture fails the gate', async () => {
        const dir = await corpus('mutated', { 'deck.pptx': deck() });
        const planted = await writer(
            'planted',
            `import { writePptx as write } from ${JSON.stringify(WRITER)};
            export function writePptx(scene, options) {
                const elements = scene.elements
                    .filter((element) => element.type !== 'image')
                    .map((element) =>
                        element.type === 'rectangle'
                            ? { ...element, x: element.x + 1 }
                            : element.type === 'richtext'
                              ? { ...element, html: element.html.replace('Plain', 'Changed') }
                              : element,
                    );
                return write({ ...scene, elements }, options);
            }`,
        );
        const out = path.join(scratch, 'out-mutated');
        const run = Bun.spawnSync([process.execPath, SCRIPT, 'roundtrip', dir, '--out', out, '--writer', planted]);
        expect(run.exitCode).toBe(1);
        expect(run.stdout.toString()).toContain(
            '\nRound trip FAIL: 1 files, 1 imported and written back, 0 skipped, 0 crashes, 0 cut; 2 unlisted differences in 1 files',
        );
        // The changed text and the dropped picture are one stretch of elements: text pairs an element with its copy.
        const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
        expect(summary).toContain(
            '| mutated/deck.pptx | rectangle x | **unlisted** | 1 | slide 1 #0: 476250 → 481013 |',
        );
        expect(summary).toContain('| elements | **unlisted** | 1 | 1 |');
    }, 60_000);

    test('a writer that throws is a crash, at its stage', async () => {
        const dir = await corpus('throws', { 'deck.pptx': deck() });
        const planted = await writer('throws', 'export function writePptx() { throw new Error("writer broke"); }');
        const out = path.join(scratch, 'out-throws');
        const meta = await runRoundtrip({ corpora: [dir], out, writer: planted, timeoutMs: 30_000 });
        expect([meta.pass, meta.outcomes.crash]).toEqual([false, 1]);
        const result = JSON.parse(fs.readFileSync(path.join(out, 'files/throws/deck.pptx.json'), 'utf8'));
        expect([result.outcome, result.stage, result.error.split('\n')[0]]).toEqual([
            'crash',
            'export',
            'Error: writer broke',
        ]);
    }, 60_000);

    test("a box that comes back within its EMU is the same box; a text box's text as the canvas lays it out is the same text", () => {
        const scene = (x: number, html: string) => {
            const doc = new Y.Doc();
            writeFrameInDoc(doc, { id: 'f1', index: 'a0', name: '', width: 1920, height: 1080, background: '' });
            writeElementInDoc(
                doc,
                { type: 'richtext', x, y: 0, width: 100, height: 100, angle: 0, html, frameId: 'f1' },
                'a0',
                SLIDES_STYLE_DEFAULTS,
                'el-0',
            );
            return { scene: readVectorFromDoc(doc), media: [], pictures: new Map() };
        };
        const groups = (x: number, html: string) =>
            classifyPptx({ a: scene(10, '<p>Text</p>'), b: scene(x, html), prepared: new Map() }).map(
                ({ kind, listed }) => [kind, listed],
            );
        expect(groups(10.00001, '<p>Text </p>')).toEqual([['text as the canvas lays it out', true]]);
        expect(groups(11, '<p>Other</p>')).toEqual([
            ['richtext x', false],
            ['richtext html', false],
        ]);
    });
});
