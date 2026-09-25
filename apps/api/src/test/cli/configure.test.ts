import { afterAll, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    chownSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConfigureAnswers, chooseSubnet, configureEntries, type DockerNetwork } from '../../cli/configure';
import { readEnvFile } from '../../cli/env-file';
import { type CliEnv, runCli, runCliInTerminal } from '../cli-test-helpers';

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

// As the launcher runs it: with the host's network list and the Compose project.
function configureEnv(dir: string, env: CliEnv, networks: DockerNetwork[]): CliEnv {
    const networksFile = join(dir, 'networks.json');
    writeFileSync(networksFile, JSON.stringify(networks));
    return { EIGEN_DOCKER_NETWORKS: networksFile, EIGEN_PROJECT: 'my-eigen', ...env };
}

function runConfigure(dir: string, args: string[], input?: string, env: CliEnv = {}, networks = NETWORKS) {
    return runCli(['configure', ...args], { cwd: dir, input, env: configureEnv(dir, env, networks) });
}

function runInTerminal(dir: string, args: string[], env: CliEnv, answers: { when: string; keys: string }[]) {
    return runCliInTerminal(['configure', ...args], { cwd: dir, env: configureEnv(dir, env, NETWORKS) }, answers);
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
    });

    test('mail off writes MAIL_ENABLED=0, the same relay keys and no mail profile', () => {
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
        });
        expect(entries.get('COMPOSE_PROFILES')).toBe('static');
        expect(entries.get('MAIL_ENABLED')).toBe('0');
        expect(entries.get('SMTP_RELAY_HOST')).toBe('smtp.relay.test');
        expect(entries.get('SMTP_RELAY_PORT')).toBe('587');
        expect(entries.get('SMTP_RELAY_USER')).toBe('u');
        expect(entries.get('SMTP_RELAY_PASSWORD')).toBe('p$w');
        expect(entries.get('EIGEN_STATIC_PORT')).toBe('18080');
        expect(entries.has('SMTP_HOST')).toBe(false);
        expect(entries.get('MAIL_DOMAIN')).toBe('example.org');
    });

    test('switching mail on or off leaves the relay lines as they are', () => {
        const existing = new Map([
            ['MAIL_ENABLED', '0'],
            ['SMTP_RELAY_HOST', 'smtp.relay.test'],
            ['SMTP_RELAY_PORT', '587'],
        ]);
        const entries = configureEntries(existing, {
            ...ANSWERS,
            relay: { host: 'smtp.relay.test', port: '587', user: '', password: '' },
        });
        expect(entries.get('MAIL_ENABLED')).toBe('1');
        expect(entries.get('SMTP_RELAY_HOST')).toBe('smtp.relay.test');
        expect(entries.get('SMTP_RELAY_PORT')).toBe('587');
    });

    test('keeps every key it does not own, and a chosen subnet pins the unbound address', () => {
        const existing = new Map([
            ['EIGEN_DEMO', '1'],
            ['QUEUE_ALERT_THRESHOLD', '50'],
            ['EIGEN_API_IMAGE', 'ghcr.io/eigen-is/eigen/api@sha256:abc'],
            ['SMTP_SECURE', '1'],
        ]);
        const entries = configureEntries(existing, { ...ANSWERS, subnet: '172.31.0.0/24' });
        for (const [key, value] of existing) expect(entries.get(key)).toBe(value);
        expect(entries.get('EIGEN_SUBNET')).toBe('172.31.0.0/24');
        expect(entries.get('EIGEN_UNBOUND_IP')).toBe('172.31.0.254');
    });

    test('without hosted mail, and without a chosen subnet, both keys are written, since Compose requires them', () => {
        const entries = configureEntries(new Map(), { ...ANSWERS, mail: false, subnet: '172.31.0.0/24' });
        expect(entries.get('EIGEN_SUBNET')).toBe('172.31.0.0/24');
        expect(entries.get('EIGEN_UNBOUND_IP')).toBe('172.31.0.254');
        const fallback = configureEntries(new Map(), ANSWERS);
        expect(fallback.get('EIGEN_SUBNET')).toBe('172.20.0.0/24');
        expect(fallback.get('EIGEN_UNBOUND_IP')).toBe('172.20.0.254');
    });

    test('removing the relay drops its lines, password included', () => {
        const existing = new Map([
            ['SMTP_RELAY_HOST', 'smtp.relay.test'],
            ['SMTP_RELAY_PORT', '587'],
            ['SMTP_RELAY_USER', 'u'],
            ['SMTP_RELAY_PASSWORD', 'p'],
        ]);
        const entries = configureEntries(existing, ANSWERS);
        expect([...entries.keys()].filter((key) => key.startsWith('SMTP_RELAY_'))).toEqual([]);
    });

    test('a relay without a user keeps no user or password lines', () => {
        const entries = configureEntries(new Map([['SMTP_RELAY_PASSWORD', 'old']]), {
            ...ANSWERS,
            mail: false,
            relay: { host: 'smtp.relay.test', port: '25', user: '', password: '' },
        });
        expect(entries.get('SMTP_RELAY_HOST')).toBe('smtp.relay.test');
        expect(entries.has('SMTP_RELAY_USER')).toBe(false);
        expect(entries.has('SMTP_RELAY_PASSWORD')).toBe(false);
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

    test('a host with several stacks still gets a free subnet', () => {
        const taken = ['172.20.0.0/24', '172.30.0.0/24', '172.31.0.0/24', '10.20.0.0/24'].map((subnet, index) => ({
            Name: `stack${index}_eigen`,
            Labels: null,
            IPAM: { Config: [{ Subnet: subnet }] },
        }));
        expect(chooseSubnet(taken, 'fresh')).toBe('10.21.0.0/24');
    });

    test('a host where every candidate is taken is told to set EIGEN_SUBNET, and nothing is written', async () => {
        const dir = tempDir();
        const everything = [{ Name: 'wide', Labels: null, IPAM: { Config: [{ Subnet: '0.0.0.0/0' }] } }];
        const flags = ['--yes', '--domain', 'eigen.example.org', '--no-proxy', '--contact-email', 'admin@example.org'];
        const run = await runConfigure(dir, flags, undefined, {}, everything);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('Set EIGEN_SUBNET in .env.production to a free /24');
        expect(existsSync(join(dir, '.env.production'))).toBe(false);
    });
});

describe('configure command', () => {
    const PIPED = [
        'eigen.example.org',
        'example.org',
        '1',
        'admin@example.org',
        'y',
        'smtp.relay.test:2525',
        'relayuser',
        `pa$$word 'q"`,
        '',
    ].join('\n');

    test('a flag-driven run writes the same file as the equivalent piped run, mode 0600', async () => {
        const piped = tempDir();
        const flagged = tempDir();
        const pipedRun = await runConfigure(piped, [], PIPED);
        expect(pipedRun.stderr).toBe('');
        expect(pipedRun.code).toBe(0);
        expect(pipedRun.stdout).not.toContain('The web address people open');
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
        expect(run.stdout).toContain('Eigen sends no email');
        const nginx = readFileSync(join(dir, 'eigen.nginx.conf'), 'utf8');
        const caddy = readFileSync(join(dir, 'eigen.Caddyfile'), 'utf8');
        const apache = readFileSync(join(dir, 'eigen.apache.conf'), 'utf8');
        expect(nginx).toContain('proxy_pass http://127.0.0.1:18080;');
        expect(nginx).toContain('server_name eigen.example.org;');
        expect(caddy).toContain('reverse_proxy 127.0.0.1:18080');
        expect(caddy).toContain('eigen.example.org {');
        expect(apache).toContain('http://127.0.0.1:18080/');
        expect(apache).toContain('/etc/letsencrypt/live/eigen.example.org/privkey.pem');
        expect(nginx + caddy + apache).not.toContain('{{');
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
        // ./eigen update passes no network list: a backfill writes the subnet an install without one runs on.
        const update = { EIGEN_VERSION: '0.2.99', EIGEN_DOCKER_NETWORKS: undefined };
        const run = await runConfigure(dir, ['--backfill'], undefined, update);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout.trim().split('\n')).toEqual([
            '┌  Configure Eigen',
            expect.stringContaining('└  .env.production: set '),
        ]);
        const written = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(written.startsWith(original)).toBe(true);
        for (const line of [
            'ACME_EMAIL=admin@example.org',
            'MAIL_ENABLED=1',
            'EIGEN_STATIC_HOST=127.0.0.1',
            'VITE_APP_DOCS_URL=/docs',
            'EIGEN_VERSION=0.2.99',
            'EIGEN_SUBNET=172.20.0.0/24',
            'EIGEN_UNBOUND_IP=172.20.0.254',
        ]) {
            expect(written).toContain(`\n${line}\n`);
        }

        const again = await runConfigure(dir, ['--backfill'], undefined, update);
        expect(again.code).toBe(0);
        expect(again.stdout).toContain('Configuration unchanged.');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(written);
    });

    test('a backfill refuses a file without DOMAIN and writes nothing', async () => {
        const dir = tempDir();
        const original = 'EIGEN_REGISTRY=ghcr.io/eigen-is/eigen\nEIGEN_VERSION=0.2.99\n';
        writeFileSync(join(dir, '.env.production'), original);
        const run = await runConfigure(dir, ['--backfill']);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('DOMAIN');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(original);
    });

    // Root in the container rewrites the operator's file; only root can change an owner, so this runs as root alone.
    test.skipIf(process.getuid?.() !== 0)('run as root, it gives the env file the install folder owner', async () => {
        const dir = tempDir();
        chownSync(dir, 1234, 1235);
        const env = join(dir, '.env.production');
        writeFileSync(env, 'DOMAIN=eigen.example.org\nMAIL_DOMAIN=example.org\n', { mode: 0o600 });
        expect((await runConfigure(dir, ['--backfill'], undefined, { EIGEN_DOCKER_NETWORKS: undefined })).code).toBe(0);
        expect(readFileSync(env, 'utf8')).toContain('\nMAIL_ENABLED=1\n');
        expect([statSync(env).uid, statSync(env).gid]).toEqual([1234, 1235]);

        const fresh = tempDir();
        chownSync(fresh, 1236, 1237);
        const flags = ['--yes', '--domain', 'eigen.example.org', '--no-proxy', '--contact-email', 'admin@example.org'];
        expect((await runConfigure(fresh, flags)).code).toBe(0);
        const created = statSync(join(fresh, '.env.production'));
        expect([created.uid, created.gid]).toEqual([1236, 1237]);
    });

    const INSTALLED = [
        'DOMAIN=eigen.example.org',
        'MAIL_DOMAIN=example.org',
        'ACME_EMAIL=admin@example.org',
        'COMPOSE_PROFILES=edge,mail',
        '',
    ].join('\n');

    // The API's own config.json, as the wizard leaves it.
    const setUp = (dir: string) => {
        mkdirSync(join(dir, 'data/server'), { recursive: true });
        writeFileSync(
            join(dir, 'data/server/config.json'),
            JSON.stringify({ setupCompleted: true, mailDomain: 'example.org' }),
        );
    };

    test('once set up, the mail domain is stated, not asked, and the same --mail-domain changes nothing', async () => {
        const dir = tempDir();
        setUp(dir);
        writeFileSync(join(dir, '.env.production'), INSTALLED);
        expect((await runConfigure(dir, ['--yes'])).code).toBe(0);
        const written = readFileSync(join(dir, '.env.production'), 'utf8');
        const run = await runConfigure(dir, [], ['', '', '', '', '', ''].join('\n'));
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout).toContain('Mail domain: example.org');
        expect(run.stdout).not.toContain('Which mail domain');
        const same = await runConfigure(dir, ['--yes', '--mail-domain', 'Example.org']);
        expect(same.code).toBe(0);
        expect(same.stdout).toContain('Configuration unchanged.');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(written);
    });

    test('once set up, a different --mail-domain is refused with the reason, and nothing is written', async () => {
        const dir = tempDir();
        setUp(dir);
        writeFileSync(join(dir, '.env.production'), INSTALLED);
        const run = await runConfigure(dir, ['--yes', '--mail-domain', 'example.com']);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('every account here is on example.org');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(INSTALLED);
    });

    test('once set up, the recorded mail domain wins over a stale MAIL_DOMAIN in the env file', async () => {
        const dir = tempDir();
        setUp(dir);
        writeFileSync(join(dir, '.env.production'), INSTALLED.replace('MAIL_DOMAIN=example.org', 'MAIL_DOMAIN='));
        const run = await runConfigure(dir, ['--yes', '--mail-domain', 'example.org']);
        expect(run.code).toBe(0);
        expect(readEnvFile(join(dir, '.env.production')).get('MAIL_DOMAIN')).toBe('example.org');
        writeFileSync(
            join(dir, '.env.production'),
            INSTALLED.replace('MAIL_DOMAIN=example.org', 'MAIL_DOMAIN=example.com'),
        );
        const stale = await runConfigure(dir, ['--yes', '--mail-domain', 'example.com']);
        expect(stale.code).toBe(1);
        expect(stale.stderr).toContain('every account here is on example.org');
    });

    test('a config.json without a recorded mail domain leaves the mail domain a question', async () => {
        const dir = tempDir();
        mkdirSync(join(dir, 'data/server'), { recursive: true });
        writeFileSync(join(dir, 'data/server/config.json'), JSON.stringify({ setupCompleted: true }));
        writeFileSync(join(dir, '.env.production'), INSTALLED);
        const run = await runConfigure(dir, ['--yes', '--mail-domain', 'example.com']);
        expect(run.code).toBe(0);
        expect(readEnvFile(join(dir, '.env.production')).get('MAIL_DOMAIN')).toBe('example.com');
    });

    // Root reads any file, so the unreadable folder exists only for another user.
    test.skipIf(process.getuid?.() === 0)('an unreadable data folder leaves the mail domain a question', async () => {
        const dir = tempDir();
        setUp(dir);
        chmodSync(join(dir, 'data/server'), 0o000);
        try {
            writeFileSync(join(dir, '.env.production'), INSTALLED);
            const run = await runConfigure(dir, ['--yes', '--mail-domain', 'example.com']);
            expect(run.code).toBe(0);
            expect(readEnvFile(join(dir, '.env.production')).get('MAIL_DOMAIN')).toBe('example.com');
        } finally {
            chmodSync(join(dir, 'data/server'), 0o755);
        }
    });

    test('writes the release pins the launcher passes as variables', async () => {
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
        const digest = 'localhost:5055/eigen-is/eigen/api@sha256:abc';
        const resolver = 'localhost:5055/eigen-is/eigen/unbound@sha256:def';
        const run = await runConfigure(dir, flags, undefined, {
            EIGEN_VERSION: '0.2.99',
            EIGEN_API_IMAGE: digest,
            EIGEN_UNBOUND_IMAGE: resolver,
            EIGEN_REGISTRY: 'localhost:5055/eigen-is/eigen',
        });
        expect(run.code).toBe(0);
        const env = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(env).toContain('EIGEN_VERSION=0.2.99\n');
        expect(env).toContain(`EIGEN_API_IMAGE=${digest}\n`);
        expect(env).toContain(`EIGEN_UNBOUND_IMAGE=${resolver}\n`);
        expect(env).toContain('EIGEN_REGISTRY=localhost:5055/eigen-is/eigen\n');
        expect(env).toContain('DOMAIN=eigen.example.org\n');
    });

    test('a local build writes no release pins, though the image sets EIGEN_REGISTRY', async () => {
        const dir = tempDir();
        const run = await runConfigure(
            dir,
            ['--yes', '--domain', 'eigen.example.org', '--no-proxy', '--contact-email', 'admin@example.org'],
            undefined,
            { EIGEN_REGISTRY: 'ghcr.io/eigen-is/eigen', EIGEN_VERSION: undefined },
        );
        expect(run.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).not.toContain('EIGEN_REGISTRY');
    });

    test('a run without the network list takes the default subnet and needs no Docker', async () => {
        const dir = tempDir();
        const run = await runConfigure(
            dir,
            ['--yes', '--domain', 'eigen.example.org', '--no-proxy', '--contact-email', 'admin@example.org'],
            undefined,
            { EIGEN_DOCKER_NETWORKS: undefined, EIGEN_PROJECT: undefined, PATH: '/nonexistent' },
        );
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toContain('\nEIGEN_SUBNET=172.20.0.0/24\n');
    });

    test('a rerun that changes no answer says so and prints nothing else', async () => {
        const dir = tempDir();
        const flags = ['--yes', '--domain', 'eigen.example.org', '--no-mail', '--proxy', '127.0.0.1:18080'];
        expect((await runConfigure(dir, flags)).code).toBe(0);
        const inode = statSync(join(dir, '.env.production')).ino;
        const rerun = await runConfigure(dir, flags);
        expect(rerun.code).toBe(0);
        expect(rerun.stdout).toContain('Configuration unchanged.');
        for (const box of ['No relay', 'Point your web server', 'DNS records']) expect(rerun.stdout).not.toContain(box);
        expect(statSync(join(dir, '.env.production')).ino).toBe(inode);
    });

    test('a flag-driven run prints its intro, notes and outro as glyph lines', async () => {
        const run = await runConfigure(tempDir(), [
            '--yes',
            '--domain',
            'localhost',
            '--no-mail',
            '--no-relay',
            '--no-proxy',
            '--contact-email',
            'admin@example.org',
        ]);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe(
            [
                '┌  Configure Eigen',
                '│',
                '◇  No relay',
                '│  Eigen sends no email. Run ./eigen setup again to add a relay.',
                '└  Configuration saved.',
                '',
            ].join('\n'),
        );
    });

    test('a local trial gets no DNS records', async () => {
        const base = ['--yes', '--mail', '--no-relay', '--no-proxy', '--contact-email', 'admin@example.org'];
        for (const domain of ['localhost', 'eigen.localhost']) {
            const run = await runConfigure(tempDir(), [
                ...base,
                '--domain',
                domain,
                '--mail-domain',
                'eigen.localhost',
            ]);
            expect(run.code).toBe(0);
            expect(run.stdout).not.toContain('DNS records');
        }
        const real = await runConfigure(tempDir(), [...base, '--domain', 'eigen.example.org']);
        expect(real.stdout).toContain('DNS records');
    });

    test('the web address is called one thing in the question, the flag and the refusal', async () => {
        const run = await runConfigure(tempDir(), ['--yes', '--domain', 'https//x']);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('web address, like eigen.example.com');
        expect((await runConfigure(tempDir(), ['--help'])).stdout.toLowerCase()).toContain(
            'web address, like eigen.example.com',
        );
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
        expect(readFileSync(join(byEnv, '.env.production'), 'utf8')).toContain('\nEIGEN_SUBNET=172.20.0.0/24\n');

        const byFile = tempDir();
        writeFileSync(join(byFile, '.env.production'), `${INSTALLED}COMPOSE_PROJECT_NAME=eigen\n`);
        expect((await runConfigure(byFile, ['--yes'], undefined, { EIGEN_PROJECT: undefined }, live)).code).toBe(0);
        expect(readFileSync(join(byFile, '.env.production'), 'utf8')).toContain('\nEIGEN_SUBNET=172.20.0.0/24\n');

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
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).not.toContain('SMTP_RELAY_HOST');
    });

    test('a piped - clears any optional answer, and a bare - is no relay host', async () => {
        const fresh = tempDir();
        const answers = ['eigen.example.org', 'example.org', '1', 'admin@example.org', 'y', '-', '', ''];
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
        const env = readFileSync(join(user, '.env.production'), 'utf8');
        expect(env).toContain('\nSMTP_RELAY_HOST=smtp.relay.test\n');
        expect(env).not.toContain('SMTP_RELAY_USER');
        expect(env).not.toContain('SMTP_RELAY_PASSWORD');

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
        expect(env.get('MAIL_DOMAIN')).toBe('eigen.example.org');
        expect(env.get('ACME_EMAIL')).toBe('admin@eigen.example.org');
    });

    test('HTTPS comes before hosted mail, then only mail questions, and the mail domain stays without it', async () => {
        const dir = tempDir();
        const run = await runConfigure(dir, [], ['eigen.example.org', '', '', '', 'n', '-'].join('\n'));
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        const order = [
            'Where will Eigen',
            'Which mail domain',
            'How do people reach Eigen over HTTPS? (1) Eigen handles it on ports 80 and 443 (2) My web server forwards to Eigen [1]',
            "Let's Encrypt",
            'Host email',
            'mail relay',
        ].map((question) => run.stdout.indexOf(question));
        expect(order).not.toContain(-1);
        expect(order).toEqual(order.toSorted((a, b) => a - b));
        const env = readEnvFile(join(dir, '.env.production'));
        expect(env.get('MAIL_DOMAIN')).toBe('eigen.example.org');
        expect(env.get('ACME_EMAIL')).toBe('admin@eigen.example.org');
        expect(env.get('MAIL_ENABLED')).toBe('0');
    });

    test('a mail domain must hold addresses, so localhost suggests eigen.localhost and refuses localhost', async () => {
        const base = ['--yes', '--no-mail', '--no-relay', '--no-proxy', '--contact-email', 'admin@example.org'];
        const dir = tempDir();
        const suggested = await runConfigure(dir, [...base, '--domain', 'localhost']);
        expect(suggested.code).toBe(0);
        expect(readEnvFile(join(dir, '.env.production')).get('MAIL_DOMAIN')).toBe('eigen.localhost');
        const given = await runConfigure(tempDir(), [...base, '--domain', 'localhost', '--mail-domain', 'localhost']);
        expect(given.code).toBe(1);
        expect(given.stderr).toContain('--mail-domain');
        expect(given.stderr).toContain('eigen.localhost');
        const fine = await runConfigure(tempDir(), [...base, '--domain', 'localhost', '--mail-domain', 'example.org']);
        expect(fine.code).toBe(0);
    });

    test('a rerun behind a web server suggests that choice again, and a choice is answered by number', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, '.env.production'), INSTALLED.replace('edge,mail', 'static,mail'));
        const rerun = await runConfigure(dir, [], ['', '', '', '', '', '', '', ''].join('\n'));
        expect(rerun.stderr).toBe('');
        expect(rerun.code).toBe(0);
        expect(rerun.stdout).toContain('My web server forwards to Eigen [2]');
        expect(rerun.stdout).toContain('Where should Eigen listen');
        expect(readEnvFile(join(dir, '.env.production')).get('COMPOSE_PROFILES')).toBe('static,mail');
        const wrong = await runConfigure(tempDir(), [], ['eigen.example.org', '', 'y'].join('\n'));
        expect(wrong.code).toBe(1);
        expect(wrong.stderr).toContain('--proxy <host:port> or --no-proxy');
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
        const run = await runInTerminal(dir, ['--domain', 'eigen.example.org'], {}, [
            { when: '?', keys: '\r\r\r\r\r\r' },
        ]);
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
            ],
            {},
            [{ when: "relay's password", keys: 'secret\r' }],
        );
        expect(run.code).toBe(1);
        expect(run.output).toContain('--relay-password-env');
        expect(run.output).not.toContain('secret');
        expect(existsSync(join(dir, '.env.production'))).toBe(false);
    });

    test('the interactive run explains its questions and honors NO_COLOR', async () => {
        const CYAN = '\x1b[36m';
        const cancel = { when: 'Where will Eigen be hosted', keys: '\x03' };
        const plain = await runInTerminal(tempDir(), [], { NO_COLOR: '1' }, [cancel]);
        expect(plain.code).toBe(130);
        expect(plain.output.indexOf('The web address people open')).toBeGreaterThan(
            plain.output.indexOf('Where will Eigen'),
        );
        expect(plain.output).toContain('igen.example.com');
        expect(plain.output).not.toContain(CYAN);
        const colored = await runInTerminal(tempDir(), [], { NO_COLOR: undefined }, [cancel]);
        expect(colored.code).toBe(130);
        expect(colored.output).toContain(CYAN);
    });

    test('the interactive HTTPS choice starts on the current answer, else on Eigen handling it', async () => {
        const toHttps = [
            { when: 'Where will Eigen be hosted', keys: '\r' },
            { when: 'Which mail domain', keys: '\r' },
            { when: 'How do people reach Eigen over HTTPS', keys: '\x03' },
        ];
        const rerun = tempDir();
        writeFileSync(join(rerun, '.env.production'), INSTALLED.replace('edge,mail', 'static,mail'));
        const behind = await runInTerminal(rerun, [], {}, toHttps);
        expect(behind.code).toBe(130);
        expect(behind.output).toContain('nginx, Apache, Caddy, a NAS');
        expect(behind.output).not.toContain('gets its own certificate');

        const fresh = tempDir();
        writeFileSync(join(fresh, '.env.production'), INSTALLED);
        const edge = await runInTerminal(fresh, [], {}, toHttps);
        expect(edge.code).toBe(130);
        expect(edge.output).toContain('gets its own certificate');
        expect(edge.output).not.toContain('nginx, Apache');
    });
});
