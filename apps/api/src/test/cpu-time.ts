// A clock of the CPU time this process spends, for the tests that bound what a hostile input costs, such as a forged
// key at the far corner of a sheet. Wall-clock time grows with every other process on a loaded CI runner, and CPU time
// barely does, so a bound on it fails only when the code does more work.

// Starts the clock; the function it returns reads the milliseconds spent since.
export function cpuClock(): () => number {
    const start = process.cpuUsage();
    return () => {
        const used = process.cpuUsage(start);
        return (used.user + used.system) / 1000;
    };
}
