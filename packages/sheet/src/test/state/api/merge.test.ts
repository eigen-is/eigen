import { describe, expect, test } from 'bun:test';
import { range } from 'es-toolkit/compat';
import { cancelMerge, mergeCells } from '../../../state/api/merge';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/merge', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 1], [0, 1], 0, 0),
        }) as Context;

    test('mergeCells and cancelMerge', async () => {
        const testMergeCellsAll = (r0: number, c0: number, r1: number, c1: number, mergeMode: string) => {
            const ranges = [{ row: [r0, r1], column: [c0, c1] }];
            const ctx = getContext();
            const expectedValue = (r: number, c: number, Mode: string) => {
                switch (Mode) {
                    case 'merge-all':
                        return {
                            r: r0,
                            c: c0,
                            rs: r === r0 && c === c0 ? r1 - r0 + 1 : undefined,
                            cs: r === r0 && c === c0 ? c1 - c0 + 1 : undefined,
                        };
                    case 'merge-horizontal':
                        return {
                            r,
                            c: c0,
                            rs: c === c0 ? 1 : undefined,
                            cs: c === c0 ? c1 - c0 + 1 : undefined,
                        };
                    case 'merge-vertical':
                        return {
                            r: r0,
                            c,
                            rs: r === r0 ? r1 - r0 + 1 : undefined,
                            cs: r === r0 ? 1 : undefined,
                        };
                    default:
                        return undefined;
                }
            };
            mergeCells(ctx, ranges, mergeMode);
            range(r0, r1 + 1).forEach((r) => {
                range(c0, c1 + 1).forEach((c) => {
                    expect(ctx.sheets[0]?.data?.[r]?.[c]?.mc).toEqual(expectedValue(r, c, mergeMode));
                });
            });
            cancelMerge(ctx, ranges);
            range(r0, r1 + 1).forEach((r) => {
                range(c0, c1 + 1).forEach((c) => {
                    expect(ctx.sheets[0]?.data?.[r]?.[c]?.mc).toEqual(undefined);
                });
            });
        };
        const testRangeList = [
            [0, 0, 1, 1, 'merge-all'],
            [0, 0, 1, 1, 'merge-vertical'],
            [0, 0, 1, 1, 'merge-horizontal'],
            [0, 0, 3, 1, 'merge-all'],
            [0, 0, 3, 1, 'merge-vertical'],
            [0, 0, 3, 3, 'merge-horizontal'],
            [2, 1, 3, 1, 'merge-all'],
            [2, 1, 3, 1, 'merge-vertical'],
            [2, 1, 3, 1, 'merge-horizontal'],
            [1, 2, 3, 3, 'merge-all'],
            [1, 2, 3, 3, 'merge-vertical'],
            [1, 2, 3, 3, 'merge-horizontal'],
        ];
        testRangeList.forEach((k) => {
            testMergeCellsAll(k[0] as number, k[1] as number, k[2] as number, k[3] as number, k[4] as string);
        });
    });
});
