import { styleText } from 'node:util';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { ControlStatus } from '../lib/control/control';
import { callControl } from './control-socket';
import { createUi } from './ui';

type Row = { level: 'ok' | 'warn' | 'bad'; label: string; value: string };

const GLYPHS = { ok: ['green', '◇'], warn: ['yellow', '▲'], bad: ['red', '■'] } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_WARN_DAYS = 14;

// The launcher gathers what only Docker knows (services, pending update, mail queue) and passes it in env.
export async function status(): Promise<void> {
    const ui = await createUi(true);
    const res = await callControl('/status', ui.fail);
    if (!res.ok) ui.fail(await res.text(), './eigen logs eigen-api shows what went wrong.');
    const api: ControlStatus = await res.json();

    const services = (process.env['EIGEN_STATUS_SERVICES'] ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [service = '', state = '', health = ''] = line.split('\t');
            return { service, state, health };
        });
    const update = process.env['EIGEN_STATUS_UPDATE'];
    const queue = process.env['EIGEN_STATUS_MAIL_QUEUE'];

    const build: Row[] = [
        { level: 'ok', label: 'Version', value: `${api.version}${api.commit ? ` (${api.commit})` : ''}` },
    ];
    if (update === 'current') build.push({ level: 'ok', label: 'Update', value: 'up to date' });
    else if (update?.startsWith('available')) {
        const commits = Number(update.split(' ')[1]);
        build.push({
            level: 'warn',
            label: 'Update',
            value: commits
                ? `${commits} new commit${commits === 1 ? '' : 's'}; ./eigen update installs them`
                : 'a new release is out; ./eigen update installs it',
        });
    } else if (update) build.push({ level: 'warn', label: 'Update', value: 'could not check' });
    if (api.setupRequired) {
        build.push({ level: 'warn', label: 'Setup', value: 'not finished; ./eigen setup prints the setup link' });
    }

    const running = services.map(
        ({ service, state, health }): Row => ({
            level: state !== 'running' || health === 'unhealthy' ? 'bad' : health === 'starting' ? 'warn' : 'ok',
            label: service,
            value: state === 'missing' ? 'not created' : `${state}${health ? `, ${health}` : ''}`,
        }),
    );

    const data: Row[] = [
        {
            level: api.diskFree < api.diskTotal / 10 ? 'warn' : 'ok',
            label: 'Disk',
            value: `${formatFileSize(api.diskFree, 1)} free of ${formatFileSize(api.diskTotal, 1)}`,
        },
        api.lastSnapshot
            ? {
                  level: 'ok',
                  label: 'Last snapshot',
                  value: `${api.lastSnapshot.name}, ${formatTimeAgo(api.lastSnapshot.createdAt)}`,
              }
            : { level: 'warn', label: 'Last snapshot', value: 'none yet; ./eigen backup makes one' },
    ];
    if (api.certExpiresAt) {
        const days = Math.floor((new Date(api.certExpiresAt).getTime() - Date.now()) / DAY_MS);
        const until = formatDate(api.certExpiresAt);
        data.push(
            days < 0
                ? { level: 'bad', label: 'Certificate', value: `expired on ${until}; ./eigen logs caddy shows why` }
                : {
                      level: days < CERT_WARN_DAYS ? 'warn' : 'ok',
                      label: 'Certificate',
                      value: `valid until ${until}, ${days} day${days === 1 ? '' : 's'} left`,
                  },
        );
    } else if (api.domain === 'localhost') {
        data.push({ level: 'ok', label: 'Certificate', value: "Caddy's local one, for localhost" });
    } else if (services.some(({ service }) => service === 'caddy')) {
        data.push({ level: 'warn', label: 'Certificate', value: 'not issued yet; ./eigen logs caddy shows why' });
    } else {
        data.push({ level: 'ok', label: 'Certificate', value: 'managed by your own web server' });
    }
    if (queue) {
        const waiting = Number(queue.match(/in (\d+) Requests?\./)?.[1] ?? 0);
        data.push(
            waiting
                ? { level: 'warn', label: 'Mail queue', value: `${waiting} message${waiting === 1 ? '' : 's'} waiting` }
                : { level: 'ok', label: 'Mail queue', value: 'empty' },
        );
    } else if (services.some(({ service, state }) => service === 'postfix' && state === 'running')) {
        data.push({ level: 'warn', label: 'Mail queue', value: 'could not be read; ./eigen logs postfix shows why' });
    } else if (api.mailEnabled) {
        data.push({ level: 'warn', label: 'Mail queue', value: 'unknown; postfix is not running' });
    }

    const sections = [build, running, data].filter((rows) => rows.length);
    const width = Math.max(...sections.flat().map(({ label }) => label.length)) + 2;
    // Bun's styleText ignores NO_COLOR, so the check is made here.
    const color = process.stdout.isTTY && !process.env['NO_COLOR'];
    const lines = sections.map((rows) =>
        rows
            .map(({ level, label, value }) => {
                const text = `${label.padEnd(width)}${value}`;
                const [hue, glyph] = GLYPHS[level];
                return color ? `${styleText(hue, glyph)}  ${text}` : text;
            })
            .join('\n'),
    );
    console.log(lines.join(color ? `\n${styleText('gray', '│')}\n` : '\n\n'));
}
