// Counts the calls a test's run makes to functions of our own, for the tests that bound an amount of work, such as the
// tables a read reads or the children an XML lookup scans. Each counted call still does its work, and the call that
// takes the count past the maximum throws, so a regression fails at once instead of running for minutes. The test
// asserts on the count handed back, which also catches a throw the code under test swallowed.

import type { Mock } from 'bun:test';

// Counts the calls through one spy; each adds its weight, one unless the test weighs it.
export type Count = <A extends unknown[], R>(
    spy: Mock<(...args: A) => R>,
    weigh?: (args: NoInfer<A>, result: NoInfer<R>) => number,
) => void;

export async function countCalls(max: number, counted: (count: Count) => void, run: () => unknown): Promise<number> {
    let total = 0;
    const spies: Mock<() => unknown>[] = [];
    try {
        counted((spy, weigh = () => 1) => {
            const original = spy.getMockImplementation();
            if (!original) throw new Error('countCalls counts a spyOn, which calls through');
            spies.push(spy);
            spy.mockImplementation(function (this: unknown, ...args) {
                const result = original.apply(this, args);
                total += weigh(args, result);
                if (total > max) throw new Error(`the counted calls passed ${max}`);
                return result;
            });
        });
        await run();
        return total;
    } finally {
        for (const spy of spies) spy.mockRestore();
    }
}
