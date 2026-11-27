import { describe, expect, spyOn, test } from 'bun:test';
import { countCalls } from './count-calls';

const tree = {
    leaves: (n: number): number[] => Array.from({ length: n }, (_, i) => i),
    sum: (n: number): number => tree.leaves(n).reduce((total, leaf) => total + leaf, 0),
};

class Tally {
    public constructor(private readonly step: number) {}
    public add(total: number): number {
        return total + this.step;
    }
}

describe('countCalls', () => {
    test('counts several functions together, weighs a call by what it returns, and each call does its work', async () => {
        const weight = await countCalls(
            100,
            (count) => {
                count(spyOn(tree, 'leaves'), (_, leaves) => leaves.length);
                count(spyOn(Tally.prototype, 'add'));
            },
            async () => {
                await Bun.sleep(1);
                expect([tree.sum(3), tree.sum(4), new Tally(2).add(1)]).toEqual([3, 6, 3]);
            },
        );
        expect(weight).toBe(8);
    });

    test('the call past the maximum throws, and the spies are restored', async () => {
        const { leaves } = tree;
        await expect(
            countCalls(
                2,
                (count) => count(spyOn(tree, 'leaves')),
                () => [1, 2, 3].map(tree.sum),
            ),
        ).rejects.toThrow('the counted calls passed 2');
        expect(tree.leaves).toBe(leaves);
    });
});
