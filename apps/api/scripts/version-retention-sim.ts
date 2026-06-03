// Shows which version snapshots the system keeps for a given editing pattern, using
// the REAL retention (selectSnapshotsToPrune + DEFAULT_RETENTION). Handy for tuning
// the bucket counts. Models the trigger as one snapshot per 30s auto-sync tick while
// editing (continuous editing crosses writesPerSnapshot=100 every tick).
//
// Run: bun apps/api/scripts/version-retention-sim.ts

import { DEFAULT_RETENTION, selectSnapshotsToPrune } from '../src/lib/versioning/retention';
import { formatSnapshotTimestamp, parseSnapshotTimestamp } from '../src/lib/versioning/timestamp';

type Snap = { id: string; name: string };
const START = Date.parse('2026-06-01T09:00:00.000Z');

function editingTimeline(days: number, sessionHours: number, tickMs: number): number[] {
    const ts: number[] = [];
    for (let day = 0; day < days; day++) {
        const dayStart = START + day * 86_400_000;
        for (let t = tickMs; t <= sessionHours * 3_600_000; t += tickMs) ts.push(dayStart + t);
    }
    return ts;
}

// Mirror Mount.snapshotContainerDataDb: append a snapshot, then prune (excluding the
// just-written copy) with the real retention function.
function simulate(timeline: number[]): Snap[] {
    let stored: Snap[] = [];
    timeline.forEach((t, i) => {
        const snap: Snap = { id: `s${i}`, name: formatSnapshotTimestamp(new Date(t)) };
        stored.push(snap);
        const prune = new Set(
            selectSnapshotsToPrune(
                stored.filter((s) => s.id !== snap.id),
                DEFAULT_RETENTION,
            ).map((s) => s.id),
        );
        stored = stored.filter((s) => !prune.has(s.id));
    });
    return stored;
}

function fmt(name: string): string {
    const d = parseSnapshotTimestamp(name)!;
    const p = (n: number) => String(n).padStart(2, '0');
    return `Jun ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

for (const days of [3, 10]) {
    const timeline = editingTimeline(days, 4, 30_000);
    const stored = simulate(timeline);
    console.log(
        `\n${days} days, 4h/day continuous (snapshot every 30s): ${timeline.length} created → ${stored.length} stored`,
    );
    for (const s of [...stored].sort((a, b) => a.name.localeCompare(b.name))) console.log(`   ${fmt(s.name)}`);
}
