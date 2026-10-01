import { existsSync } from 'node:fs';
import type { parseArgs } from 'node:util';
import { roomShortfall } from '../lib/backup/paths';
import { DATA, VERSION_PATTERN } from './install';
import { createUi } from './ui';
import { hasBreaking, notesSince } from './update-check';

// The ./eigen update of Eigen 0.3.0 asks this image whether to save a full or a light snapshot before it switches,
// then saves it with its own image. It runs as root on the install folder (-w /install).
const SNAPSHOTS = 'snapshots';

export const SNAPSHOT_OPTIONS = {
    check: { type: 'boolean' },
    light: { type: 'boolean' },
    from: { type: 'string' },
} as const;
export const SNAPSHOT_USAGE = `Usage: snapshot --check [--light] [--from <version>]

Run by the ./eigen update of Eigen 0.3.0: checks that ${SNAPSHOTS}/ has room for a snapshot of data/, and prints
kind=full or kind=light. It saves nothing: ./eigen backup makes backups.

  --light            A light snapshot, unless a release since <version> has breaking changes
  --from <version>   The version the update starts from`;

export async function snapshot(
    flags: ReturnType<typeof parseArgs<{ options: typeof SNAPSHOT_OPTIONS }>>['values'],
): Promise<void> {
    const ui = await createUi(true);
    if (!flags.check) ui.fail('Eigen saves no snapshots any more.', 'Run ./eigen backup, which makes a backup.');
    const from = flags.from;
    if (from !== undefined && !VERSION_PATTERN.test(from)) {
        ui.fail('--from takes a version, like 0.2.0.', 'Run it through ./eigen update.');
    }
    if (!existsSync(DATA)) ui.fail('There is no data/ here.', 'Run ./eigen update in the install folder.');
    const kind = flags.light && !(from && hasBreaking(notesSince(from))) ? 'light' : 'full';
    // What data/ takes on disk, as du counts it: the most either kind of snapshot of it can take.
    const du = Bun.spawn(['du', '-sk', DATA], { stdout: 'pipe', stderr: 'ignore' });
    const [listed] = await Promise.all([new Response(du.stdout).text(), du.exited]);
    const needed = Number.parseInt(listed, 10) * 1024;
    const shortfall = roomShortfall(
        `The ${kind} snapshot`,
        needed,
        existsSync(SNAPSHOTS) ? SNAPSHOTS : '.',
        `${SNAPSHOTS}/`,
    );
    if (shortfall) ui.fail(`${shortfall}.`, `Free space on that disk, or delete old snapshots from ${SNAPSHOTS}/.`);
    console.log(`kind=${kind}`);
}
