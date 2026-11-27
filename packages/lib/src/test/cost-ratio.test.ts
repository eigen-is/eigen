import { describe, expect, test } from 'bun:test';
import { costRatio } from './cost-ratio';

// About 20 ms of CPU on a fast machine, twice the helper's floor.
const BASE = 16_000_000;

function linear(n: number): number {
    let hash = 0;
    for (let i = 0; i < n; i++) hash = Math.imul(hash ^ i, 16777619);
    return hash;
}

function quadratic(n: number): number {
    let hash = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) hash = Math.imul(hash ^ j, 16777619);
    return hash;
}

describe('costRatio', () => {
    test('a linear cost at n against n/16 reads near 16', async () => {
        const { ratio } = await costRatio({ run: () => linear(16 * BASE) }, { run: () => linear(BASE) });
        expect(ratio).toBeGreaterThan(8);
        expect(ratio).toBeLessThan(32);
    });

    test('a quadratic cost at n against n/4 reads near 16, four times what a linear one does', async () => {
        const n = 20_000;
        const { ratio } = await costRatio({ run: () => quadratic(n) }, { run: () => quadratic(n / 4) });
        expect(ratio).toBeGreaterThan(8);
    });

    test('a slow setup is not counted', async () => {
        const { ratio } = await costRatio(
            { setup: () => linear(8 * BASE), run: () => linear(BASE) },
            { run: () => linear(BASE) },
        );
        expect(ratio).toBeLessThan(2);
    });

    test('the setup hands its result to the run, and the turns alternate', async () => {
        const order: string[] = [];
        const turn = (side: string) => {
            order.push(side);
            linear(BASE);
        };
        await costRatio({ setup: () => 'guarded', run: turn }, { run: () => turn('baseline') }, 2);
        expect(order).toEqual(['guarded', 'baseline', 'guarded', 'baseline']);
    });

    test('an async run is awaited', async () => {
        const { baselineMs } = await costRatio(
            { run: () => linear(BASE) },
            {
                run: async () => {
                    await Bun.sleep(1);
                    linear(BASE);
                },
            },
        );
        expect(baselineMs).toBeGreaterThan(10);
    });

    test('a baseline under 10 ms of CPU throws and names its reading', async () => {
        await expect(costRatio({ run: () => linear(BASE) }, { run: () => linear(1000) })).rejects.toThrow(
            /baseline's fastest turn took \d+\.\d+ ms of thread CPU, under the 10 ms/,
        );
    });
});
