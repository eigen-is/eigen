// Compares what two pieces of work cost, for the API and package tests that bound a cost nothing of ours can count,
// such as a layout at n words against the same layout at n/16. A runner's speed cancels out of a ratio of two runs
// in one process, where a number of milliseconds would measure the runner too. The test asserts on the ratio.
// An async run's reading holds all CPU this thread spends while the run awaits.

declare global {
    namespace NodeJS {
        // Bun has it; the Node types this repo installs predate it.
        interface Process {
            threadCpuUsage(previous?: CpuUsage): CpuUsage;
        }
    }
}

// The setup runs before each turn, outside the reading, so a run may mutate its input.
type CostSide<T> = { setup: () => T | Promise<T>; run: (input: T) => unknown } | { setup?: never; run: () => unknown };

const TURNS = 3;
// Below this the reading is mostly the clock's grain and the scheduler.
const BASELINE_FLOOR_MS = 10;

// Runs the two sides in alternating turns and divides their fastest readings, so a collector pause in one turn
// fails nothing. The clock is this thread's CPU time, which neither other processes nor a Worker move.
export async function costRatio<G, B>(guarded: CostSide<G>, baseline: CostSide<B>): Promise<number> {
    let [guardedMs, baselineMs] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    for (let turn = 0; turn < TURNS; turn++) {
        guardedMs = Math.min(guardedMs, await cpuMsOf(guarded));
        baselineMs = Math.min(baselineMs, await cpuMsOf(baseline));
    }
    if (baselineMs < BASELINE_FLOOR_MS) {
        throw new Error(
            `costRatio: the baseline's fastest turn took ${baselineMs.toFixed(2)} ms of thread CPU, under the ${BASELINE_FLOOR_MS} ms a ratio needs; give it a larger input or more rounds`,
        );
    }
    return guardedMs / baselineMs;
}

async function cpuMsOf<T>(side: CostSide<T>): Promise<number> {
    const run = side.setup ? side.run.bind(undefined, await side.setup()) : side.run;
    const start = process.threadCpuUsage();
    await run();
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
}
