import { existsSync, readFileSync } from 'node:fs';

// Linux carries the spawner's high-water mark into a child's maxRSS across exec; VmHWM is the process's own.
export function peakRss(): number {
    const status = existsSync('/proc/self/status') ? readFileSync('/proc/self/status', 'utf8') : '';
    return Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? process.resourceUsage().maxRSS) * 1024;
}
