import type { parseArgs } from 'node:util';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { parseBackupStamp } from '@workspace/lib/validation';
import type { ControlStatus } from '../lib/config/server-status';
import { callControl } from './control-socket';
import { VERSION, VERSION_PATTERN } from './install';
import { newestSnapshots, SNAPSHOT_NAME } from './snapshot';
import { createUi, type Glyph, glyphLine } from './ui';

type Row = { level: Glyph; label: string; value: string };
type Service = { service: string; state: string; health: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_WARN_DAYS = 14;

// --latest is the newest release of a release install, or on a channel the commit of its newest build; --new-commits is
// how far a checkout is behind: empty when the check failed, left out when it could not run. --files is the build the
// launcher and Compose files were last written from, passed only while it is not the one .env.production pins: an
// update that failed halfway is not finished.
export const STATUS_OPTIONS = {
    services: { type: 'string' },
    latest: { type: 'string' },
    'new-commits': { type: 'string' },
    'mail-queue': { type: 'string' },
    snapshots: { type: 'string' },
    'snapshots-kb': { type: 'string' },
    files: { type: 'string' },
} as const;
export const STATUS_USAGE = `Usage: status [--services=…] [--latest=…] [--new-commits=…] [--mail-queue=…] [--snapshots=…]
              [--snapshots-kb=…] [--files=…]

Reports on the running server with what ./eigen status gathers from Docker and the host.`;

type StatusFlags = ReturnType<typeof parseArgs<{ options: typeof STATUS_OPTIONS }>>['values'];

// Without the API, the report holds what the launcher knows.
function printReport(flags: StatusFlags, services: Service[], api: ControlStatus | null): void {
    const { latest, 'new-commits': commits, 'mail-queue': queue, files } = flags;
    // The CLI runs in an api image: the running one, or the one .env.production pins.
    const channel = process.env['EIGEN_CHANNEL'];
    const commit = process.env['EIGEN_COMMIT'];
    const build: Row[] = api
        ? [
              {
                  level: 'ok',
                  label: 'Version',
                  value: `${api.version}${api.commit ? ` (${api.commit})` : ''}${channel ? ` on ${channel}` : ''}`,
              },
          ]
        : [];
    if (files) {
        build.push({
            level: 'warn',
            label: 'Update',
            value: `files of ${files}, running ${VERSION}${commit ? ` (${commit})` : ''}: run ./eigen update`,
        });
    } else if (
        commits === '' ||
        latest === '' ||
        // Bun.semver.order throws on what is not a version.
        (latest && !channel && !VERSION_PATTERN.test(latest))
    ) {
        build.push({ level: 'warn', label: 'Update', value: 'could not check' });
    } else if (channel && latest && latest !== commit) {
        build.push({
            level: 'warn',
            label: 'Update',
            value: `a new build of ${channel} is out (${latest}); ./eigen update installs it`,
        });
    } else if (!channel && latest && Bun.semver.order(latest, VERSION) > 0) {
        build.push({ level: 'warn', label: 'Update', value: `Eigen ${latest} is out; ./eigen update installs it` });
    } else if (commits && commits !== '0') {
        const one = commits === '1';
        build.push({
            level: 'warn',
            label: 'Update',
            value: `${commits} new commit${one ? '' : 's'}; ./eigen update installs ${one ? 'it' : 'them'}`,
        });
    } else if (latest || commits) build.push({ level: 'ok', label: 'Update', value: 'up to date' });
    if (api?.setupRequired) {
        build.push({ level: 'warn', label: 'Setup', value: 'not finished; ./eigen setup prints the setup link' });
    }

    const running = services.map(
        ({ service, state, health }): Row => ({
            level: state !== 'running' || health === 'unhealthy' ? 'bad' : health === 'starting' ? 'warn' : 'ok',
            label: service,
            value: state === 'missing' ? 'not created' : `${state}${health ? `, ${health}` : ''}`,
        }),
    );

    const snapshots = newestSnapshots((flags.snapshots ?? '').split('\n'));
    const [snapshot = ''] = snapshots;
    const groups = SNAPSHOT_NAME.exec(snapshot)?.groups;
    const snapshotAt = groups && parseBackupStamp(groups);
    const data: Row[] = [
        snapshotAt
            ? { level: 'ok', label: 'Last snapshot', value: `${snapshot}, ${formatTimeAgo(snapshotAt)}` }
            : { level: 'warn', label: 'Last snapshot', value: 'none yet; ./eigen backup makes one' },
    ];
    const kb = Number(flags['snapshots-kb']);
    if (snapshots.length && kb) {
        data.push({
            level: 'ok',
            label: 'Snapshots',
            value: `${snapshots.length} in snapshots/, ${formatFileSize(kb * 1024, 1)} on disk`,
        });
    }
    if (api) {
        data.unshift({
            level: api.diskFree < api.diskTotal / 10 ? 'warn' : 'ok',
            label: 'Disk',
            value: `${formatFileSize(api.diskFree, 1)} free of ${formatFileSize(api.diskTotal, 1)}`,
        });
        if (api.certExpiresAt) {
            const days = Math.floor((new Date(api.certExpiresAt).getTime() - Date.now()) / DAY_MS);
            const until = formatDate(api.certExpiresAt);
            data.push(
                days < 0
                    ? {
                          level: 'bad',
                          label: 'Certificate',
                          value: `expired on ${until}; ./eigen logs caddy shows why`,
                      }
                    : {
                          level: days < CERT_WARN_DAYS ? 'warn' : 'ok',
                          label: 'Certificate',
                          value: `valid until ${until}, ${days} day${days === 1 ? '' : 's'} left`,
                      },
            );
        } else if (api.domain === 'localhost') {
            data.push({ level: 'ok', label: 'Certificate', value: "Caddy's local one, for localhost" });
        } else if (services.some(({ service }) => service === 'caddy')) {
            data.push({
                level: 'warn',
                label: 'Certificate',
                value: 'not issued yet; ./eigen logs caddy shows why',
            });
        } else {
            data.push({ level: 'ok', label: 'Certificate', value: 'managed by your own web server' });
        }
    }
    if (queue) {
        const waiting = Number(queue.match(/in (\d+) Requests?\./)?.[1] ?? 0);
        data.push(
            waiting
                ? {
                      level: 'warn',
                      label: 'Mail queue',
                      value: `${waiting} message${waiting === 1 ? '' : 's'} waiting`,
                  }
                : { level: 'ok', label: 'Mail queue', value: 'empty' },
        );
    } else if (services.some(({ service, state }) => service === 'postfix' && state === 'running')) {
        data.push({
            level: 'warn',
            label: 'Mail queue',
            value: 'could not be read; ./eigen logs postfix shows why',
        });
    } else if (api?.mailEnabled) {
        data.push({ level: 'warn', label: 'Mail queue', value: 'unknown; postfix is not running' });
    }

    const sections = [build, running, data].filter((rows) => rows.length);
    const width = Math.max(...sections.flat().map(({ label }) => label.length)) + 2;
    console.log(
        sections
            .map((rows) =>
                rows.map(({ level, label, value }) => glyphLine(level, `${label.padEnd(width)}${value}`)).join('\n'),
            )
            .join(`\n${glyphLine('bar', '')}\n`),
    );
}

// The launcher runs this in the API container while eigen-api runs, and on its own when it does not.
export async function status(flags: StatusFlags): Promise<void> {
    const services = (flags.services ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line): Service => {
            const [service = '', state = '', health = ''] = line.split('\t');
            return { service, state, health };
        })
        // Compose lists them in a different order from run to run.
        .sort((a, b) => a.service.localeCompare(b.service));
    const ui = await createUi(true);
    if (!services.some(({ service, state }) => service === 'eigen-api' && state === 'running')) {
        printReport(flags, services, null);
        ui.fail('Eigen is not running.', 'Run ./eigen logs eigen-api to see why.');
    }
    const res = await callControl('/status', (message, next) => {
        printReport(flags, services, null);
        return ui.fail(message, next);
    });
    if (!res.ok) {
        printReport(flags, services, null);
        ui.fail(await res.text(), 'Run ./eigen logs eigen-api to see what went wrong.');
    }
    printReport(flags, services, await res.json());
}
