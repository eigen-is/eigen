import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConfigureAnswers, chooseSubnet, configureEntries, type DockerNetwork } from '../../cli/configure';

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
    proxy: null,
    contactEmail: 'admin@example.org',
    relay: null,
    from: 'noreply@example.org',
    subnet: null,
};

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'eigen-configure-'));
}

async function runConfigure(dir: string, args: string[], input?: string, env: Record<string, string> = {}) {
    const networks = join(dir, 'networks.json');
    writeFileSync(networks, JSON.stringify(NETWORKS));
    const proc = Bun.spawn([process.execPath, CLI, 'configure', ...args], {
        cwd: dir,
        env: { ...process.env, EIGEN_DOCKER_NETWORKS: networks, EIGEN_PROJECT: 'my-eigen', ...env },
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
            proxy: '127.0.0.1:18080',
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

    test('a backfill keeps a hand-edited file byte-for-byte and adds the keys it lacks', async () => {
        const dir = tempDir();
        const original = [
            'PRODUCTION=1',
            '',
            'DOMAIN=eigen.example.org',
            'MAIL_DOMAIN=example.org',
            'ACME_EMAIL=admin@example.org',
            '',
            'COMPOSE_PROFILES=edge,mail',
            'EIGEN_STATIC_HOST=127.0.0.1',
            'EIGEN_STATIC_PORT=8080',
            '',
            'API_URL=https://eigen.example.org',
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
        writeFileSync(join(dir, '.env.production'), original);
        const run = await runConfigure(dir, ['--backfill']);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout.trim().split('\n')).toHaveLength(1);
        const written = readFileSync(join(dir, '.env.production'), 'utf8');
        expect(written.startsWith(original)).toBe(true);
        expect(written).toContain('\nMAIL_ENABLED=1\n');
        expect(written).toContain('\nVITE_APP_DOCS_URL=/docs\n');
        expect(written).not.toContain('EIGEN_SUBNET');

        const again = await runConfigure(dir, ['--backfill']);
        expect(again.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(written);
    });
});
