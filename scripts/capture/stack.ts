// A throwaway Eigen for the capture tool, beside the owner's own dev stack: it seeds the Tuimel demo world into a fresh
// data root, then runs the API and the vite of each app the scenes need on agent ports, 86xx and 36xx. Each server
// runs in its own process group, so stop() also ends the children bun and vite start. A signal stops it too, even
// while it is still starting.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PORTS } from '../../vite.shared.config';
import type { Stack } from './lib/scene';
import { CAPTURE_ROOT } from './record';

// The seeder's own default, set here so the API and the persona emails agree with it.
export const MAIL_DOMAIN = 'tuimel.example';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DATA_ROOT = join(CAPTURE_ROOT, 'data');
const LOG_DIR = join(CAPTURE_ROOT, 'logs');
const API_PORT = 8690;
const ANSWER_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 30_000;

const logOf = (name: string) => join(LOG_DIR, `${name}.log`);
const capturePort = (app: string) => 3600 + APP_PORTS[app] - 3000;
const appUrlFor = (app: string) => `http://localhost:${capturePort(app)}${app === 'index' ? '' : `/${app}`}`;

export async function startStack({ apps }: { apps: readonly string[] }): Promise<Stack> {
    const unknown = apps.filter((app) => !(app in APP_PORTS));
    if (unknown.length)
        throw new Error(`Unknown app ${unknown.join(', ')}. Apps: ${Object.keys(APP_PORTS).join(', ')}`);

    const apiUrl = `http://localhost:${API_PORT}`;
    const personaPassword = randomBytes(18).toString('base64url');
    const children: ChildProcess[] = [];
    const onSignal = () => {
        stop().finally(() => process.exit(130));
    };
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
        stopping ??= (async () => {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
            await Promise.all(children.map(stopGroup));
        })();
        return stopping;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        rmSync(CAPTURE_ROOT, { recursive: true, force: true });
        mkdirSync(LOG_DIR, { recursive: true });
        const env = { ...process.env, EIGEN_DATA_ROOT: DATA_ROOT, MAIL_DOMAIN, DOMAIN: MAIL_DOMAIN };

        console.log('Seeding the demo world…');
        const seeder = start('seed', ['bun', '--no-env-file', 'src/scripts/seed-demo.ts'], 'apps/api', {
            ...env,
            EIGEN_DEMO_ADMIN_PASSWORD: randomBytes(18).toString('base64url'),
            EIGEN_DEMO_PERSONA_PASSWORD: personaPassword,
        });
        children.push(seeder);
        const code = await new Promise((resolve) => seeder.once('exit', resolve));
        if (code !== 0) throw new Error(`The seeder exited with ${code}; see ${logOf('seed')}`);

        const appUrls = Object.fromEntries(
            Object.keys(APP_PORTS).map((app) => [`VITE_APP_${app.toUpperCase()}_URL`, appUrlFor(app)]),
        );
        const api = start('api', ['bun', '--no-env-file', 'src/index.ts'], 'apps/api', {
            ...env,
            ...appUrls,
            EIGEN_API_PORT: String(API_PORT),
            API_URL: apiUrl,
        });
        children.push(api);
        const waits = [waitForAnswer('api', api, `${apiUrl}/p/config`)];
        for (const app of apps) {
            const vite = start(
                app,
                ['bunx', '--bun', 'vite', '--port', String(capturePort(app)), '--strictPort'],
                `apps/${app}`,
                { ...process.env, ...appUrls, VITE_API_HOST: apiUrl },
            );
            children.push(vite);
            waits.push(waitForAnswer(app, vite, `${appUrlFor(app)}/`));
        }
        console.log(`Starting the API and ${apps.join(', ')}…`);
        await Promise.all(waits);
    } catch (err) {
        await stop();
        throw err;
    }
    return { apiUrl, personaPassword, appUrl: appUrlFor, stop };
}

function start(name: string, cmd: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
    const log = openSync(logOf(name), 'a');
    const [command, ...args] = cmd;
    return spawn(command, args, { cwd: join(REPO_ROOT, cwd), env, detached: true, stdio: ['ignore', log, log] });
}

async function waitForAnswer(name: string, child: ChildProcess, url: string): Promise<void> {
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${name} exited with ${child.exitCode}; see ${logOf(name)}`);
        const answered = await fetch(url).then(
            () => true,
            () => false,
        );
        if (answered) return;
        await Bun.sleep(250);
    }
    throw new Error(`${name} did not answer at ${url} within ${ANSWER_TIMEOUT_MS / 1000} s; see ${logOf(name)}`);
}

// A negative pid signals the whole group. A group whose last process is gone throws ESRCH.
async function stopGroup(child: ChildProcess): Promise<void> {
    const { pid } = child;
    if (pid === undefined) return;
    const signal = (sig: NodeJS.Signals | 0): boolean => {
        try {
            process.kill(-pid, sig);
            return true;
        } catch {
            return false;
        }
    };
    if (!signal('SIGTERM')) return;
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (signal(0)) {
        if (Date.now() > deadline) signal('SIGKILL');
        await Bun.sleep(100);
    }
}
