// A clock of the CPU time this process spends, for the tests that bound what a hostile input costs in milliseconds,
// such as a recurrence rule too costly to expand. Other processes don't move it, but on a loaded machine
// the same work costs more than twice the CPU time, so such a bound needs a wide margin; a count or a ratio needs none.

// Starts the clock; the function it returns reads the milliseconds spent since.
export function cpuClock(): () => number {
    const start = process.cpuUsage();
    return () => {
        const used = process.cpuUsage(start);
        return (used.user + used.system) / 1000;
    };
}
