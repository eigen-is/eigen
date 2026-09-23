import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { parseBackupStamp } from '@workspace/lib/validation';
import type { ControlStatus } from '../lib/config/server-status';
import { callControl } from './control-socket';
import { newestSnapshots, SNAPSHOT_NAME } from './snapshot';
import { createUi, type Glyph, glyphLine } from './ui';

type Row = { level: Glyph; label: string; value: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_WARN_DAYS = 14;

export const STATUS_OPTIONS = {
    services: { type: 'string' },
    update: { type: 'string' },
    'mail-queue': { type: 'string' },
    snapshots: { type: 'string' },
} as const;
export const STATUS_USAGE = `Usage: status [--services=…] [--update=…] [--mail-queue=…] [--snapshots=…]

Reports on the running server with what ./eigen status gathers from Docker and the host.`;

// With Eigen down there is no socket to ask, so the report stops at what the launcher knows.
export async function status(flags: {
    services?: string;
    update?: string;
    'mail-queue'?: string;
    snapshots?: string;
}): Promise<void> {
    const services = (flags.services ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [service = '', state = '', health = ''] = line.split('\t');
            return { service, state, health };
        });
    const { update, 'mail-queue': queue } = flags;
    const snapshot = newestSnapshots((flags.snapshots ?? '').split('\n'))[0];

    const report = (api: ControlStatus | null) => {
        const build: Row[] = api
            ? [{ level: 'ok', label: 'Version', value: `${api.version}${api.commit ? ` (${api.commit})` : ''}` }]
            : [];
        if (update === 'current') build.push({ level: 'ok', label: 'Update', value: 'up to date' });
        else if (update?.startsWith('available ')) {
            const newer = update.slice('available '.length);
            const commits = /^\d+$/.test(newer) ? Number(newer) : 0;
            build.push({
                level: 'warn',
                label: 'Update',
                value: commits
                    ? `${commits} new commit${commits === 1 ? '' : 's'}; ./eigen update installs them`
                    : `Eigen ${newer} is out; ./eigen update installs it`,
            });
        } else if (update) build.push({ level: 'warn', label: 'Update', value: 'could not check' });
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

        const groups = SNAPSHOT_NAME.exec(snapshot ?? '')?.groups;
        const snapshotAt = groups && parseBackupStamp(groups);
        const data: Row[] = [
            snapshotAt
                ? { level: 'ok', label: 'Last snapshot', value: `${snapshot}, ${formatTimeAgo(snapshotAt)}` }
                : { level: 'warn', label: 'Last snapshot', value: 'none yet; ./eigen backup makes one' },
        ];
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
                    rows
                        .map(({ level, label, value }) => glyphLine(level, `${label.padEnd(width)}${value}`))
                        .join('\n'),
                )
                .join(`\n${glyphLine('bar', '')}\n`),
        );
    };

    const ui = await createUi(true);
    const apiRunning = services.some(({ service, state }) => service === 'eigen-api' && state === 'running');
    const res = await callControl('/status', (message, next) => {
        report(null);
        return apiRunning
            ? ui.fail(message, next)
            : ui.fail('Eigen is not running.', 'Run ./eigen logs eigen-api to see why.');
    });
    if (!res.ok) {
        report(null);
        ui.fail(await res.text(), 'Run ./eigen logs eigen-api to see what went wrong.');
    }
    report(await res.json());
}
