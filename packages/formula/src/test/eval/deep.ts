// Chains of cells whose formulas nest as deep as a formula may, in the shapes that use the most stack per level, and
// the way to compute each on a Node worker with a small stack. Bundled and run by Node, this file starts a worker
// per chain, so that every chain meets the engine's code before any of it was compiled, when its calls are largest.

import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { Cells } from '../recalc/support';
import { engineOf, valueAt } from '../recalc/support';

const LEVELS = 58;
const CELLS = 40;

const nested = (open: string, inner: string, close: string) => `${open.repeat(LEVELS)}${inner}${close.repeat(LEVELS)}`;

// Each formula reads the cell below it, `A`, from as deep inside itself as it can; `B` holds a 1 beside every cell.
export const DEEP: Readonly<Record<string, (a: string, b: string) => string>> = {
    'a lifted IF, 60 deep': (a) => `=${'IF({1,1},'.repeat(60)}${a}${')'.repeat(60)}+1`,
    'a lifted IF over a sum': (a, b) => `=SUM(${nested('IF({1,1},', `SUM(${a}:${b})`, ')')})`,
    'a lifted SWITCH over a lifted lookup': (a, b) =>
        `=SUM(${nested('SWITCH({1,1},2,0,', `SUM(VLOOKUP({9,9},${a}:${b},2))`, ')')})`,
    'a lifted XLOOKUP over a lifted lookup': (a, b) =>
        `=SUM(${nested('XLOOKUP({2,2},$B$1:$B$1,$B$1:$B$1,', `SUM(HLOOKUP({1,1},${a}:${b},1,FALSE))`, ')')})`,
    'a lifted IFS over an operator on references': (a) =>
        `=SUM(${nested('IFS({1,1},', `SUM(OFFSET(${a},{0,0},0)+1)`, ')')})`,
    'a lifted IFERROR over a SUBTOTAL of references': (a) =>
        `=SUM(${nested('IFERROR({1,1}/0,', `SUM(SUBTOTAL(9,OFFSET(${a},{0,0},0)))`, ')')})+1`,
    'IFS in its own test': (a) => `=${nested('IFS(', `${a}+0`, ',1)')}+1`,
    'operators in brackets': (a) => `=${nested('1+(', `${a}+0`, ')')}`,
    'minus signs': (a) => `=${nested('-', a, '')}+1`,
};

// The value of the first cell of a chain, or the name of what the recalc threw.
export function deepest(shape: string) {
    const cells: Record<string, string | number> = { B1: 1, [`A${CELLS + 2}`]: 1, [`B${CELLS + 2}`]: 1 };
    for (let row = 2; row < CELLS + 2; row += 1) {
        cells[`A${row}`] = DEEP[shape](`A${row + 1}`, `B${row + 1}`);
        cells[`B${row}`] = 1;
    }
    const typed: Cells = cells;
    const engine = engineOf({ s1: typed });
    try {
        engine.recalc(Number.POSITIVE_INFINITY);
    } catch (thrown) {
        return thrown instanceof Error ? thrown.name : 'thrown';
    }
    return valueAt(engine, 'A2');
}

function onWorker(shape: string, stackSizeMb: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: shape, resourceLimits: { stackSizeMb } });
        worker.on('message', resolve);
        worker.on('error', reject);
    });
}

if (!isMainThread) parentPort?.postMessage(deepest(String(workerData)));
else if (process.argv[2] === 'workers') {
    const answers: Record<string, unknown> = {};
    for (const shape of Object.keys(DEEP)) answers[shape] = await onWorker(shape, Number(process.argv[3]));
    console.log(JSON.stringify(answers));
}
