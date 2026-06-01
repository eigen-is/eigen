// Filename-safe ISO: `:` and `.` stripped so the name is portable across
// filesystems and S3 consoles, and sorts lexicographically.
const FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

export function formatSnapshotTimestamp(d: Date): string {
    return `${d.toISOString().replace(/[:.]/g, '-')}.db`;
}

export function parseSnapshotTimestamp(name: string): Date | null {
    const m = FORMAT.exec(name);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, ms] = m;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
}
