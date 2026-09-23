import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConfigureAnswers, chooseSubnet, configureEntries, type DockerNetwork } from '../../cli/configure';
import { readEnvFile } from '../../cli/env-file';

const CLI = join(import.meta.dir, '../../cli/index.ts');

const NETWORKS: DockerNetwork[] = [
    { Name: 'bridge', Labels: {}, IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
    {
        Name: 'other_eigen',
        Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.network': 'eigen' },
        IPAM: { Config: [{ Subnet: '172.20.0.0/24' }] },
    },
    {
        Name: 'my-eigen_eigen',
        Labels: { 'com.docker.compose.project': 'my-eigen', 'com.docker.compose.network': 'eigen' },
        IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] },
    },
    { Name: 'none', Labels: null, IPAM: { Config: null } },
];

const ANSWERS: ConfigureAnswers = {
    domain: 'eigen.example.org',
    mail: true,
    mailDomain: 'example.org',
    behindProxy: false,
    staticAddress: '127.0.0.1:8080',
    contactEmail: 'admin@example.org',
    relay: null,
    from: 'noreply@example.org',
    subnet: null,
};

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eigen-configure-'));
    dirs.push(dir);
    return dir;
}

type Env = Record<string, string | undefined>;

// An undefined value removes the variable, so a test can drop EIGEN_PROJECT or NO_COLOR.
function spawnEnv(dir: string, env: Env, networks: DockerNetwork[]): Record<string, string> {
    const networksFile = join(dir, 'networks.json');
    writeFileSync(networksFile, JSON.stringify(networks));
    const merged: Env = { ...process.env, EIGEN_DOCKER_NETWORKS: networksFile, EIGEN_PROJECT: 'my-eigen', ...env };
    return Object.fromEntries(
        Object.entries(merged).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    );
}

async function runConfigure(dir: string, args: string[], input?: string, env: Env = {}, networks = NETWORKS) {
    const proc = Bun.spawn([process.execPath, CLI, 'configure', ...args], {
        cwd: dir,
        env: spawnEnv(dir, env, networks),
        stdin: input === undefined ? 'ignore' : new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

// Runs in a pseudo-terminal; `keys` is typed once `when` appears in the output.
async function runInTerminal(dir: string, args: string[], env: Env, answer?: { when: string; keys: string }) {
    let output = '';
    let pending = answer;
    const decoder = new TextDecoder();
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    const proc = Bun.spawn([process.execPath, CLI, 'configure', ...args], {
        cwd: dir,
        env: spawnEnv(dir, env, NETWORKS),
        terminal: {
            data: (terminal, data) => {
                output += decoder.decode(data);
                if (pending && output.includes(pending.when)) {
                    terminal.write(pending.keys);
                    pending = undefined;
                }
            },
            exit: () => resolve(),
        },
    });
    const [code] = await Promise.all([proc.exited, closed]);
    proc.terminal?.close();
    return { output, code };
}

describe('configure entries', () => {
    test('hosting mail on the bundled Caddy writes the mail profile and the relay for postfix', () => {
        const entries = configureEntries(new Map(), {
            ...ANSWERS,
            relay: { host: 'smtp.relay.test', port: '2525', user: 'u', password: 'p' },
        });
        expect(entries.get('COMPOSE_PROFILES')).toBe('edge,mail');
        expect(entries.get('MAIL_ENABLED')).toBe('1');
        expect(entries.get('SMTP_RELAY_HOST')).toBe('smtp.relay.test');
        expect(entries.get('SMTP_RELAY_PORT')).toBe('2525');
        expect(entries.has('SMTP_HOST')).toBe(false);
        expect(entries.get('API_URL')).toBe('https://eigen.example.org');
        expect(entries.get('VITE_APP_DOCS_URL')).toBe('/docs');
        expect(entries.has('SMTP_FROM')).toBe(false);
    });

    test('mail off writes MAIL_ENABLED=0, the API relay keys and no mail profile', () => {
        const existing = new Map([
            ['COMPOSE_PROFILES', 'static,mail'],
            ['SMTP_RELAY_HOST', 'old.relay.test'],
            ['SMTP_RELAY_PASSWORD', 'old'],
        ]);
        const entries = configureEntries(existing, {
            ...ANSWERS,
            mail: false,
            behindProxy: true,
            staticAddress: '127.0.0.1:18080',
            relay: { host: 'smtp.relay.test', port: '587', user: 'u', password: 'p$w' },
            from: 'Eigen <noreply@example.org>',
        });
        expect(entries.get('COMPOSE_PROFILES')).toBe('static');
        expect(entries.get('MAIL_ENABLED')).toBe('0');
        expect(entries.get('SMTP_HOST')).toBe('smtp.relay.test');
        expect(entries.get('SMTP_PORT')).toBe('587');
        expect(entries.get('SMTP_USER')).toBe('u');
        expect(entries.get('SMTP_PASSWORD')).toBe('p$w');
        expect(entries.get('EIGEN_STATIC_PORT')).toBe('18080');
        expect(entries.get('SMTP_FROM')).toBe('Eigen <noreply@example.org>');
        expect([...entries.keys()].some((key) => key.startsWith('SMTP_RELAY_'))).toBe(false);
    });

    test('turning mail back on drops the API relay keys so mail goes through postfix again', () => {
        const existing = new Map([
            ['MAIL_ENABLED', '0'],
            ['SMTP_HOST', 'smtp.relay.test'],
            ['SMTP_PORT', '587'],
        ]);
        const entries = configureEntries(existing, ANSWERS);
        expect(entries.get('MAIL_ENABLED')).toBe('1');
        expect(entries.has('SMTP_HOST')).toBe(false);
        expect(entries.has('SMTP_PORT')).toBe(false);
    });

    test('keeps every key it does not own, and a chosen subnet pins the unbound address', () => {
        const existing = new Map([
            ['EIGEN_DEMO', '1'],
            ['QUEUE_ALERT_THRESHOLD', '50'],
            ['EIGEN_API_IMAGE', 'ghcr.io/eigen-is/eigen-api@sha256:abc'],
            ['SMTP_SECURE', '1'],
        ]);
        const entries = configureEntries(existing, { ...ANSWERS, subnet: '172.31.0.0/24' });
        for (const [key, value] of existing) expect(entries.get(key)).toBe(value);
        expect(entries.get('EIGEN_SUBNET')).toBe('172.31.0.0/24');
        expect(entries.get('EIGEN_UNBOUND_IP')).toBe('172.31.0.254');
    });

    test('removing the relay blanks only its host', () => {
        const existing = new Map([
            ['SMTP_RELAY_HOST', 'smtp.relay.test'],
            ['SMTP_RELAY_USER', 'u'],
            ['SMTP_RELAY_PASSWORD', 'p'],
        ]);
        const entries = configureEntries(existing, ANSWERS);
        expect(entries.get('SMTP_RELAY_HOST')).toBe('');
        expect(entries.get('SMTP_RELAY_USER')).toBe('u');
        expect(entries.get('SMTP_RELAY_PASSWORD')).toBe('p');
    });

    test('a relay without a user adds no user or password lines', () => {
        const entries = configureEntries(
            new Map([
                ['MAIL_ENABLED', '0'],
                ['SMTP_PASSWORD', 'old'],
            ]),
            { ...ANSWERS, mail: false, relay: { host: 'smtp.relay.test', port: '25', user: '', password: '' } },
        );
        expect(entries.get('SMTP_HOST')).toBe('smtp.relay.test');
        expect(entries.has('SMTP_USER')).toBe(false);
        expect(entries.get('SMTP_PASSWORD')).toBe('');
    });

    test('the default sender leaves an empty SMTP_FROM alone', () => {
        expect(configureEntries(new Map([['SMTP_FROM', '']]), ANSWERS).get('SMTP_FROM')).toBe('');
    });
});

describe('subnet choice', () => {
    test('reuses the live network of this Compose project', () => {
        expect(chooseSubnet(NETWORKS, 'my-eigen')).toBe('172.31.0.0/24');
    });

    test('a fresh install skips subnets another network already uses', () => {
        expect(chooseSubnet(NETWORKS, 'fresh')).toBe('172.30.0.0/24');
        expect(chooseSubnet([], 'fresh')).toBe('172.20.0.0/24');
    });
});

describe('configure command', () => {
    const PIPED = [
        'eigen.example.org',
        'y',
        'example.org',
        'n',
        'admin@example.org',
        'smtp.relay.test:2525',
        'relayuser',
        `pa$$word 'q"`,
        'Eigen <noreply@example.org>',
        '',
    ].join('\n');

    test('a flag-driven run writes the same file as the equivalent piped run, mode 0600', async () => {
        const piped = tempDir();
        const flagged = tempDir();
        const pipedRun = await runConfigure(piped, [], PIPED);
        expect(pipedRun.stderr).toBe('');
        expect(pipedRun.code).toBe(0);
        const flagRun = await runConfigure(
            flagged,
            [
                '--domain',
                'eigen.example.org',
                '--mail',
                '--mail-domain',
                'example.org',
                '--no-proxy',
                '--contact-email',
                'admin@example.org',
                '--relay',
                'smtp.relay.test:2525',
                '--relay-user',
                'relayuser',
                '--relay-password-env',
                'RELAY_PASSWORD',
                '--from',
                'Eigen <noreply@example.org>',
            ],
            undefined,
            { RELAY_PASSWORD: `pa$$word 'q"` },
        );
        expect(flagRun.code).toBe(0);
        const written = readFileSync(join(piped, '.env.production'), 'utf8');
        expect(readFileSync(join(flagged, '.env.production'), 'utf8')).toBe(written);
        expect(written).toContain(`SMTP_RELAY_PASSWORD="pa$$$$word 'q\\""\n`);
        expect(written).toContain('EIGEN_SUBNET=172.31.0.0/24\n');
        expect(statSync(join(piped, '.env.production')).mode & 0o777).toBe(0o600);
    });

    test('a missing answer in a non-interactive run names the flag and writes nothing', async () => {
        const dir = tempDir();
        const eof = await runConfigure(dir, ['--domain', 'eigen.example.org']);
        expect(eof.code).toBe(1);
        expect(eof.stderr).toContain('--mail');
        const yes = await runConfigure(dir, ['--yes']);
        expect(yes.code).toBe(1);
        expect(yes.stderr).toContain('--domain');
        expect(existsSync(join(dir, '.env.production'))).toBe(false);
    });

    test('a proxy answer writes the snippets for the chosen address', async () => {
        const dir = tempDir();
        const run = await runConfigure(dir, [
            '--yes',
            '--domain',
            'eigen.example.org',
            '--no-mail',
            '--no-relay',
            '--proxy',
            '0.0.0.0:18080',
            '--contact-email',
            'admin@example.org',
        ]);
        expect(run.code).toBe(0);
        expect(run.stdout).toContain('Two-factor codes by email');
        expect(readFileSync(join(dir, 'eigen.nginx.conf'), 'utf8')).toContain('proxy_pass http://127.0.0.1:18080;');
        expect(readFileSync(join(dir, 'eigen.Caddyfile'), 'utf8')).toContain('reverse_proxy 127.0.0.1:18080');
        expect(readFileSync(join(dir, 'eigen.apache.conf'), 'utf8')).toContain('http://127.0.0.1:18080/');
        const env = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(env).toContain('COMPOSE_PROFILES=static\n');
        expect(env).toContain('EIGEN_STATIC_HOST=0.0.0.0\n');
        expect(run.stdout).not.toContain('_dmarc');
    });

    test('a backfill only appends the keys a file lacks', async () => {
        const original = [
            'PRODUCTION=1',
            '',
            'DOMAIN=eigen.example.org',
            'MAIL_DOMAIN=example.org',
            'COMPOSE_PROFILES=edge,mail',
            '',
            'API_URL=https://old.example.org',
            '# a hand-written note',
            'VITE_API_HOST=/eigen',
            'SMTP_RELAY_HOST=smtp-relay.brevo.com',
            'SMTP_RELAY_PORT=587',
            'SMTP_RELAY_USER="relay user"',
            'SMTP_RELAY_PASSWORD=pa$$word',
            'TRUSTED_NETWORKS=127.0.0.0/8,::1,172.20.0.0/24',
            'EIGEN_DEMO=1',
            "CUSTOM='keep $me'",
            '',
        ].join('\n');
        const dir = tempDir();
        writeFileSync(join(dir, '.env.production'), original);
        const run = await runConfigure(dir, ['--backfill'], undefined, {
            EIGEN_PINS: 'EIGEN_VERSION=0.2.99',
        });
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout.trim().split('\n')).toHaveLength(1);
        const written = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(written.startsWith(original)).toBe(true);
        for (const line of [
            'ACME_EMAIL=admin@example.org',
            'MAIL_ENABLED=1',
            'EIGEN_STATIC_HOST=127.0.0.1',
            'VITE_APP_DOCS_URL=/docs',
            'EIGEN_VERSION=0.2.99',
        ]) {
            expect(written).toContain(`\n${line}\n`);
        }
        expect(written).not.toContain('EIGEN_SUBNET');

        const again = await runConfigure(dir, ['--backfill'], undefined, { EIGEN_PINS: 'EIGEN_VERSION=0.2.99' });
        expect(again.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(written);
    });

    test('a backfill refuses a file without DOMAIN and writes nothing', async () => {
        const dir = tempDir();
        const original = 'EIGEN_REGISTRY=ghcr.io/eigen-is\nEIGEN_VERSION=0.2.99\n';
        writeFileSync(join(dir, '.env.production'), original);
        const run = await runConfigure(dir, ['--backfill']);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('DOMAIN');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(original);
    });

    const INSTALLED = [
        'DOMAIN=eigen.example.org',
        'MAIL_DOMAIN=example.org',
        'ACME_EMAIL=admin@example.org',
        'COMPOSE_PROFILES=edge,mail',
        '',
    ].join('\n');

    test('--yes keeps an empty SMTP_FROM as it is', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, '.env.production'), `${INSTALLED}SMTP_FROM=\n`);
        const run = await runConfigure(dir, ['--yes']);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toContain('\nSMTP_FROM=\n');
    });

    test('--from is checked by the parser the mailer uses', async () => {
        const base = ['--yes', '--domain', 'eigen.example.org', '--no-proxy', '--contact-email', 'admin@example.org'];
        const dir = tempDir();
        const comment = await runConfigure(dir, [...base, '--from', 'noreply@example.org (Eigen)']);
        expect(comment.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toContain("SMTP_FROM='noreply@example.org (Eigen)'");
        const two = await runConfigure(tempDir(), [...base, '--from', 'Eigen <a@example.org>, b@example.org']);
        expect(two.code).toBe(1);
        expect(two.stderr).toContain('--from');
    });

    test('EIGEN_PINS writes the release pins the launcher resolved, and nothing else', async () => {
        const dir = tempDir();
        const flags = [
            '--yes',
            '--domain',
            'eigen.example.org',
            '--no-mail',
            '--no-relay',
            '--no-proxy',
            '--contact-email',
            'admin@example.org',
        ];
        const bad = await runConfigure(dir, flags, undefined, { EIGEN_PINS: 'DOMAIN=evil.example.org' });
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain('EIGEN_PINS');
        expect(existsSync(join(dir, '.env.production'))).toBe(false);
        const digest = 'localhost:5055/eigen-is/eigen-api@sha256:abc';
        const run = await runConfigure(dir, flags, undefined, {
            EIGEN_PINS: `EIGEN_VERSION=0.2.99 EIGEN_API_IMAGE=${digest}`,
        });
        expect(run.code).toBe(0);
        const env = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(env).toContain('EIGEN_VERSION=0.2.99\n');
        expect(env).toContain(`EIGEN_API_IMAGE=${digest}\n`);
        expect(env).toContain('DOMAIN=eigen.example.org\n');
    });

    test('a rerun keeps the live network of the Compose project, however the project is named', async () => {
        const live: DockerNetwork[] = [
            {
                Name: 'eigen_eigen',
                Labels: { 'com.docker.compose.project': 'eigen', 'com.docker.compose.network': 'eigen' },
                IPAM: { Config: [{ Subnet: '172.20.0.0/24' }] },
            },
        ];
        const byEnv = tempDir();
        writeFileSync(join(byEnv, '.env.production'), INSTALLED);
        expect((await runConfigure(byEnv, ['--yes'], undefined, { EIGEN_PROJECT: 'eigen' }, live)).code).toBe(0);
        expect(readFileSync(join(byEnv, '.env.production'), 'utf8')).not.toContain('EIGEN_SUBNET');

        const byFile = tempDir();
        writeFileSync(join(byFile, '.env.production'), `${INSTALLED}COMPOSE_PROJECT_NAME=eigen\n`);
        expect((await runConfigure(byFile, ['--yes'], undefined, { EIGEN_PROJECT: undefined }, live)).code).toBe(0);
        expect(readFileSync(join(byFile, '.env.production'), 'utf8')).not.toContain('EIGEN_SUBNET');

        const unnamed = tempDir();
        writeFileSync(join(unnamed, '.env.production'), INSTALLED);
        const run = await runConfigure(unnamed, ['--yes'], undefined, { EIGEN_PROJECT: undefined }, live);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('EIGEN_PROJECT');
        expect(readFileSync(join(unnamed, '.env.production'), 'utf8')).toBe(INSTALLED);
    });

    test('a piped answer of - clears an answer that has a default', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, '.env.production'), `${INSTALLED}SMTP_RELAY_HOST=smtp.relay.test\n`);
        const run = await runConfigure(dir, [], ['', '', '', '', '', '-', '', ''].join('\n'));
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout).toContain('[smtp.relay.test:587, - for none]');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toContain('\nSMTP_RELAY_HOST=\n');
    });

    test('a piped - clears any optional answer, and a bare - is no relay host', async () => {
        const fresh = tempDir();
        const answers = ['eigen.example.org', 'y', 'example.org', 'n', 'admin@example.org', '-', '', ''];
        const run = await runConfigure(fresh, [], answers.join('\n'));
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(readFileSync(join(fresh, '.env.production'), 'utf8')).not.toContain('SMTP_RELAY_HOST');

        const user = tempDir();
        writeFileSync(
            join(user, '.env.production'),
            `${INSTALLED}SMTP_RELAY_HOST=smtp.relay.test\nSMTP_RELAY_USER=u\nSMTP_RELAY_PASSWORD=p\n`,
        );
        const cleared = await runConfigure(user, [], ['', '', '', '', '', '', '-', '', ''].join('\n'));
        expect(cleared.stderr).toBe('');
        expect(cleared.code).toBe(0);
        expect(readFileSync(join(user, '.env.production'), 'utf8')).toContain('\nSMTP_RELAY_USER=\n');

        const flag = await runConfigure(tempDir(), [
            '--yes',
            '--domain',
            'eigen.example.org',
            '--no-proxy',
            '--contact-email',
            'admin@example.org',
            '--relay',
            '-',
        ]);
        expect(flag.code).toBe(1);
        expect(flag.stderr).toContain('--relay');
        expect(flag.stderr).not.toContain('leave it empty');
    });

    test('the placeholders of .env.example are no defaults', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, '.env.production'), readFileSync(join(import.meta.dir, '../../../../../.env.example')));
        const run = await runConfigure(dir, [], ['eigen.example.org', '', '', '', '', '', '', ''].join('\n'));
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        const env = readEnvFile(join(dir, '.env.production'));
        expect(env.get('MAIL_DOMAIN')).toBe('example.org');
        expect(env.get('ACME_EMAIL')).toBe('admin@example.org');
    });

    test('the usage explains -', async () => {
        const run = await runConfigure(tempDir(), ['--help']);
        expect(run.stdout).toContain('- clears');
    });

    test('the terminal password refusal says --yes keeps the current password', async () => {
        const dir = tempDir();
        writeFileSync(
            join(dir, '.env.production'),
            `${INSTALLED}SMTP_RELAY_HOST=smtp.relay.test\nSMTP_RELAY_USER=u\nSMTP_RELAY_PASSWORD=p\n`,
        );
        const run = await runInTerminal(
            dir,
            ['--domain', 'eigen.example.org'],
            {},
            { when: '?', keys: '\r\r\r\r\r\r' },
        );
        expect(run.code).toBe(1);
        expect(run.output).toContain('--yes');
    });

    test('a plain run on a terminal refuses to ask for a password it would echo', async () => {
        const dir = tempDir();
        const run = await runInTerminal(
            dir,
            [
                '--domain',
                'eigen.example.org',
                '--mail',
                '--mail-domain',
                'example.org',
                '--no-proxy',
                '--contact-email',
                'admin@example.org',
                '--relay',
                'smtp.relay.test:2525',
                '--relay-user',
                'relayuser',
                '--from',
                'noreply@example.org',
            ],
            {},
            { when: 'Relay password', keys: 'secret\r' },
        );
        expect(run.code).toBe(1);
        expect(run.output).toContain('--relay-password-env');
        expect(run.output).not.toContain('secret');
        expect(existsSync(join(dir, '.env.production'))).toBe(false);
    });

    test('the interactive run honors NO_COLOR', async () => {
        const CYAN = '\x1b[36m';
        const cancel = { when: 'Web address', keys: '\x03' };
        const plain = await runInTerminal(tempDir(), [], { NO_COLOR: '1' }, cancel);
        expect(plain.code).toBe(130);
        expect(plain.output).toContain('Web address');
        expect(plain.output).not.toContain(CYAN);
        const colored = await runInTerminal(tempDir(), [], { NO_COLOR: undefined }, { ...cancel });
        expect(colored.code).toBe(130);
        expect(colored.output).toContain(CYAN);
    });
});
