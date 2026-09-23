import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { validateEmailAddress } from '@workspace/lib/validation';
import addressparser from 'nodemailer/lib/addressparser';
import { readEnvFile, writeEnvFile } from './env-file';
import { createUi, type Ui } from './ui';

export type ConfigureAnswers = {
    domain: string;
    mail: boolean;
    mailDomain: string;
    proxy: string | null;
    contactEmail: string;
    relay: { host: string; port: string; user: string; password: string } | null;
    from: string;
    subnet: string | null;
};

export type DockerNetwork = {
    Name: string;
    Labels: Record<string, string> | null;
    IPAM: { Config: { Subnet?: string }[] | null };
};

const ENV_PATH = '.env.production';
const DEFAULT_SUBNET = '172.20.0.0/24';
const SUBNET_CANDIDATES = [DEFAULT_SUBNET, '172.30.0.0/24', '172.31.0.0/24', '10.20.0.0/24'];
const PLACEHOLDER_DOMAINS = new Set(['eigen.example.com', 'example.com']);
// Postfix relays when Eigen hosts mail; the API relays itself when it does not. Ports are Compose's defaults.
const MAIL_RELAY_KEYS = ['SMTP_RELAY_HOST', 'SMTP_RELAY_PORT', 'SMTP_RELAY_USER', 'SMTP_RELAY_PASSWORD'] as const;
const API_RELAY_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
const MAIL_RELAY_PORT = '587';
const API_RELAY_PORT = '25';
// Digests the launcher resolved on the host (no socket in here), passed as KEY=VALUE words in EIGEN_PINS.
const RELEASE_PINS = new Set([
    'EIGEN_REGISTRY',
    'EIGEN_VERSION',
    'EIGEN_API_IMAGE',
    'EIGEN_FRONTEND_IMAGE',
    'EIGEN_POSTFIX_IMAGE',
    'EIGEN_DOVECOT_IMAGE',
]);
// Relative, so the same bundle serves any hostname; the API prefixes API_URL when it builds links in mail.
const APP_URLS = {
    VITE_API_HOST: '/eigen',
    VITE_APP_SPACE_URL: '/space',
    VITE_APP_MAIL_URL: '/mail',
    VITE_APP_CALENDAR_URL: '/calendar',
    VITE_APP_CONTACTS_URL: '/contacts',
    VITE_APP_DRIVE_URL: '/drive',
    VITE_APP_DOCS_URL: '/docs',
    VITE_APP_STICKIES_URL: '/stickies',
    VITE_APP_CHAT_URL: '/chat',
    VITE_APP_ADMIN_URL: '/admin',
    VITE_APP_SLIDES_URL: '/slides',
    VITE_APP_SHEETS_URL: '/sheets',
    VITE_APP_VECTOR_URL: '/vector',
    VITE_APP_INDEX_URL: '/',
};
const OPTIONS = {
    domain: { type: 'string' },
    mail: { type: 'boolean' },
    'no-mail': { type: 'boolean' },
    'mail-domain': { type: 'string' },
    proxy: { type: 'string' },
    'no-proxy': { type: 'boolean' },
    'contact-email': { type: 'string' },
    relay: { type: 'string' },
    'no-relay': { type: 'boolean' },
    'relay-user': { type: 'string' },
    'relay-password-env': { type: 'string' },
    from: { type: 'string' },
    yes: { type: 'boolean' },
    backfill: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
} as const;
const USAGE = `Usage: configure [flags]

Asks the setup questions and writes ${ENV_PATH}. Any flag makes the run non-interactive.

  --domain <name>              Web address, like eigen.example.com
  --mail | --no-mail           Host email on this server
  --mail-domain <name>         The part after @ in mail addresses
  --proxy <host:port>          Run behind your own web server, which forwards to host:port
  --no-proxy                   Let Eigen's own web server take ports 80 and 443
  --contact-email <address>    Contact address for Let's Encrypt
  --relay <host:port>          Send outgoing mail through this relay
  --no-relay                   No relay
  --relay-user <name>          Relay user name
  --relay-password-env <VAR>   Read the relay password from this environment variable
  --from <sender>              System sender, an address or Name <address>
  --yes                        Keep the current or default answer for every flag not given
  --backfill                   Keep every answer, add missing keys, print one line
  --help                       Show this help`;

const NO_CONTROL = /^\P{Cc}*$/u;

const cleanDomain = (value: string) =>
    value
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .toLowerCase();

function validateDomain(value: string): string | undefined {
    const domain = cleanDomain(value);
    const valid = domain === 'localhost' || /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(domain);
    if (!valid || PLACEHOLDER_DOMAINS.has(domain)) {
        return 'Enter a domain name like eigen.example.com, without https:// or a path.';
    }
}

function validateEmail(value: string): string | undefined {
    if (!validateEmailAddress(value) || !NO_CONTROL.test(value))
        return 'Enter an email address like admin@example.com.';
}

function validateText(value: string): string | undefined {
    if (!NO_CONTROL.test(value)) return 'Remove the control characters from this answer.';
}

const isPort = (value: string) => /^\d{1,5}$/.test(value) && +value > 0 && +value < 65536;

function validateAddress(value: string): string | undefined {
    const [host = '', port = '', extra] = value.split(':');
    const octets = host.split('.');
    const validHost = octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && +octet < 256);
    if (!validHost || !isPort(port) || extra !== undefined)
        return 'Enter an IPv4 address and port, like 127.0.0.1:8080.';
}

function validateRelay(value: string): string | undefined {
    if (value === '' || value === 'none') return;
    const [host = '', port = '587', extra] = value.split(':');
    if (!/^[a-z0-9.-]+$/i.test(host) || !isPort(port) || extra !== undefined) {
        return 'Enter the relay as host:port, like smtp-relay.brevo.com:587, or leave it empty.';
    }
}

// The mailer's own parser, so what passes here is what it sends from.
function validateFrom(value: string): string | undefined {
    const parsed = addressparser(value, { flatten: true });
    if (parsed.length !== 1 || !validateEmailAddress(parsed[0]?.address ?? '') || !NO_CONTROL.test(value)) {
        return 'Enter an address, or a name and address like Eigen <noreply@example.com>.';
    }
}

function cidrRange(cidr: string): [number, number] {
    const [ip = '', prefix = '32'] = cidr.split('/');
    const start = ip.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
    return [start, start + 2 ** (32 - Number(prefix)) - 1];
}

// A rerun must reuse the live network's subnet: recreating it elsewhere would orphan the running containers.
export function chooseSubnet(networks: DockerNetwork[], project: string): string {
    const live = networks.find(
        (network) => network.Name === `${project}_eigen` && network.Labels?.['com.docker.compose.project'] === project,
    );
    const liveSubnet = live?.IPAM.Config?.[0]?.Subnet;
    if (liveSubnet) return liveSubnet;
    const occupied = networks
        .flatMap((network) => network.IPAM.Config ?? [])
        .flatMap((config) => (config.Subnet && /^[\d.]+\/\d+$/.test(config.Subnet) ? [cidrRange(config.Subnet)] : []));
    const free = SUBNET_CANDIDATES.find((candidate) => {
        const [start, end] = cidrRange(candidate);
        return !occupied.some(([takenStart, takenEnd]) => start <= takenEnd && takenStart <= end);
    });
    return free ?? DEFAULT_SUBNET;
}

export function configureEntries(
    existing: Map<string, string>,
    answers: ConfigureAnswers,
    wasMail: boolean,
): Map<string, string> {
    const entries = new Map(existing);
    const staticAddress = `${existing.get('EIGEN_STATIC_HOST') || '127.0.0.1'}:${existing.get('EIGEN_STATIC_PORT') || '8080'}`;
    const [staticHost = '', staticPort = ''] = (answers.proxy ?? staticAddress).split(':');
    entries.set('DOMAIN', answers.domain);
    entries.set('MAIL_DOMAIN', answers.mailDomain);
    entries.set('ACME_EMAIL', answers.contactEmail);
    entries.set('COMPOSE_PROFILES', `${answers.proxy ? 'static' : 'edge'}${answers.mail ? ',mail' : ''}`);
    entries.set('MAIL_ENABLED', answers.mail ? '1' : '0');
    entries.set('EIGEN_STATIC_HOST', staticHost);
    entries.set('EIGEN_STATIC_PORT', staticPort);
    if (answers.subnet && answers.subnet !== DEFAULT_SUBNET) {
        entries.set('EIGEN_SUBNET', answers.subnet);
        if (!entries.has('EIGEN_UNBOUND_IP')) {
            entries.set('EIGEN_UNBOUND_IP', answers.subnet.replace(/\.0\/\d+$/, '.254'));
        }
    }

    // Switching modes moves the relay: API relay keys left behind with mail on would bypass postfix.
    const [relayKeys, otherKeys] = answers.mail ? [MAIL_RELAY_KEYS, API_RELAY_KEYS] : [API_RELAY_KEYS, MAIL_RELAY_KEYS];
    if (wasMail !== answers.mail) {
        for (const key of otherKeys) entries.delete(key);
    }
    const [hostKey, portKey, userKey, passwordKey] = relayKeys;
    if (answers.relay) {
        entries.set(hostKey, answers.relay.host);
        entries.set(portKey, answers.relay.port);
        for (const [key, value] of [
            [userKey, answers.relay.user],
            [passwordKey, answers.relay.password],
        ] as const) {
            if (value || entries.has(key)) entries.set(key, value);
        }
    } else if (entries.has(hostKey)) {
        entries.set(hostKey, '');
    }
    // Unset or empty, the sender follows MAIL_DOMAIN; writing the default would pin it.
    if (answers.from !== `noreply@${answers.mailDomain}` || existing.get('SMTP_FROM')) {
        entries.set('SMTP_FROM', answers.from);
    }

    entries.set('PRODUCTION', '1');
    entries.set('API_URL', `https://${answers.domain}`);
    for (const [key, value] of Object.entries(APP_URLS)) {
        if (!entries.has(key)) entries.set(key, value);
    }
    return entries;
}

function parseFlags(args: string[]) {
    try {
        return parseArgs({ args, options: OPTIONS }).values;
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exit(2);
    }
}

export async function configure(args: string[]): Promise<void> {
    const flags = parseFlags(args);
    if (flags.help) {
        console.log(USAGE);
        return;
    }
    const backfill = flags.backfill === true;
    const acceptDefaults = backfill || flags.yes === true;
    const ui: Ui = await createUi(args.length > 0);
    const existing = readEnvFile(ENV_PATH);
    const pins = new Map<string, string>();
    for (const pin of (process.env['EIGEN_PINS'] ?? '').split(/\s+/).filter(Boolean)) {
        const [, key = '', value = ''] = pin.match(/^([A-Z_]+)=(.+)$/) ?? [];
        if (!RELEASE_PINS.has(key)) ui.fail(`EIGEN_PINS: "${pin}" is not a release pin.`, 'Run ./eigen setup again.');
        pins.set(key, value);
    }
    const existingDomain = existing.get('DOMAIN') ?? '';
    if (backfill && (!existingDomain || PLACEHOLDER_DOMAINS.has(existingDomain))) {
        ui.fail(`${ENV_PATH} has no DOMAIN of your own to keep.`, 'Run eigen setup first.');
    }
    if (!backfill) ui.intro('Configure Eigen');

    const answer = async (
        message: string,
        flag: string,
        given: string | undefined,
        initial: string,
        validate: (value: string) => string | undefined,
    ): Promise<string> => {
        if (given !== undefined) {
            const error = validate(given);
            return error ? ui.fail(`--${flag}: ${error}`, `Pass a valid --${flag}.`) : given;
        }
        if (backfill) return initial;
        if (acceptDefaults)
            return validate(initial) ? ui.fail(`No answer for "${message}".`, `Pass --${flag}.`) : initial;
        return ui.ask({ message, initial, validate, flag: `--${flag}` });
    };
    const decide = async (message: string, flag: string, given: boolean | undefined, initial: boolean) => {
        if (given !== undefined) return given;
        if (acceptDefaults) return initial;
        return ui.confirm({ message, initial, flag });
    };

    const domain = cleanDomain(
        await answer(
            'Web address, like eigen.example.com',
            'domain',
            flags.domain,
            PLACEHOLDER_DOMAINS.has(existingDomain) ? '' : existingDomain,
            validateDomain,
        ),
    );
    const profiles = existing.get('COMPOSE_PROFILES')?.split(',');
    // A file from before MAIL_ENABLED says mail is off only through its profiles.
    const wasMail = existing.get('MAIL_ENABLED') !== '0' && (profiles?.includes('mail') ?? true);
    const mail = await decide(
        'Host email on this server?',
        '--mail or --no-mail',
        flags.mail ? true : flags['no-mail'] ? false : undefined,
        wasMail,
    );
    // Only a guess: a web address with three or more labels usually wants mail on its parent domain.
    const labels = domain.split('.');
    const mailDomain = cleanDomain(
        mail || flags['mail-domain'] !== undefined
            ? await answer(
                  'Mail domain, the part after @ in addresses',
                  'mail-domain',
                  flags['mail-domain'],
                  existing.get('MAIL_DOMAIN') || (labels.length >= 3 ? labels.slice(1).join('.') : domain),
                  validateDomain,
              )
            : existing.get('MAIL_DOMAIN') || domain,
    );
    const behindProxy = await decide(
        'Run behind a web server you already have (nginx, Caddy, Apache)?',
        '--proxy <host:port> or --no-proxy',
        flags.proxy !== undefined ? true : flags['no-proxy'] ? false : undefined,
        profiles?.includes('static') ?? false,
    );
    const proxy = behindProxy
        ? await answer(
              'Address your web server forwards to, host:port',
              'proxy',
              flags.proxy,
              `${existing.get('EIGEN_STATIC_HOST') || '127.0.0.1'}:${existing.get('EIGEN_STATIC_PORT') || '8080'}`,
              validateAddress,
          )
        : null;
    // Only the bundled Caddy asks Let's Encrypt for a certificate; behind a proxy the question is moot.
    const contactEmailDefault = existing.get('ACME_EMAIL') || `admin@${mailDomain}`;
    const contactEmail =
        proxy === null || flags['contact-email'] !== undefined
            ? await answer(
                  "Contact email for Let's Encrypt",
                  'contact-email',
                  flags['contact-email'],
                  contactEmailDefault,
                  validateEmail,
              )
            : contactEmailDefault;

    const [hostKey, portKey, userKey, passwordKey] = wasMail ? MAIL_RELAY_KEYS : API_RELAY_KEYS;
    const previousHost = existing.get(hostKey);
    const relayAnswer = await answer(
        'Outgoing mail relay, host:port (optional)',
        'relay',
        flags['no-relay'] ? '' : flags.relay,
        previousHost ? `${previousHost}:${existing.get(portKey) || (wasMail ? MAIL_RELAY_PORT : API_RELAY_PORT)}` : '',
        validateRelay,
    );
    let relay: ConfigureAnswers['relay'] = null;
    if (relayAnswer && relayAnswer !== 'none') {
        const [host = '', port = mail ? MAIL_RELAY_PORT : API_RELAY_PORT] = relayAnswer.split(':');
        const user = await answer(
            'Relay user name (optional)',
            'relay-user',
            flags['relay-user'],
            existing.get(userKey) ?? '',
            validateText,
        );
        const previousPassword = existing.get(passwordKey) ?? '';
        const passwordEnv = flags['relay-password-env'];
        let password = '';
        if (user) {
            if (passwordEnv !== undefined) {
                password =
                    process.env[passwordEnv] ??
                    ui.fail(
                        `--relay-password-env: ${passwordEnv} is not set.`,
                        `Export the relay password as ${passwordEnv} first.`,
                    );
            } else if (acceptDefaults) {
                password = previousPassword;
            } else {
                const message = previousPassword
                    ? 'Relay password (leave empty to keep the current one)'
                    : 'Relay password';
                password = (await ui.password({ message, flag: '--relay-password-env <VAR>' })) || previousPassword;
            }
            if (!password && !backfill) {
                ui.fail(
                    'A relay user needs a password.',
                    'Pass --relay-password-env <VAR>, or leave the relay user empty.',
                );
            }
            if (validateText(password)) {
                ui.fail('The relay password contains control characters.', 'Pass a password without them.');
            }
        }
        relay = { host, port, user, password };
    } else if (!mail && !backfill) {
        ui.note('Without a relay, Eigen sends no email', [
            'Two-factor codes by email',
            'Guest sign-in codes',
            'Share and access-request notifications',
            '"Email collaborators"',
            'Waitlist invitations',
            'Calendar invitations and RSVP replies',
            'Rerun the setup to add a relay later.',
        ]);
    }
    const defaultFrom = existing.get('SMTP_FROM') || `noreply@${mailDomain}`;
    const from =
        mail || relay
            ? await answer('System sender, an address or Name <address>', 'from', flags.from, defaultFrom, validateFrom)
            : defaultFrom;

    const networksFile = process.env['EIGEN_DOCKER_NETWORKS'];
    let subnet = existing.get('EIGEN_SUBNET') ?? null;
    if (subnet === null && !backfill) {
        let networks: DockerNetwork[] | null = null;
        if (networksFile) {
            try {
                networks = JSON.parse(readFileSync(networksFile, 'utf8'));
            } catch {
                ui.fail('Could not read the Docker network list.', 'Run the setup again.');
            }
        } else {
            const spin = ui.spinner('Checking Docker networks');
            const docker = async (dockerArgs: string[]) => {
                try {
                    const proc = Bun.spawn(['docker', ...dockerArgs], { stdout: 'pipe', stderr: 'ignore' });
                    const stdout = await new Response(proc.stdout).text();
                    return (await proc.exited) === 0 ? stdout : null;
                } catch {
                    return null;
                }
            };
            const ids = await docker(['network', 'ls', '-q']);
            if (ids !== null) {
                const list = ids.split('\n').filter(Boolean);
                const inspected = list.length ? await docker(['network', 'inspect', ...list]) : '[]';
                if (inspected === null)
                    ui.fail(
                        'docker network inspect failed.',
                        'Check that Docker is running, then run the setup again.',
                    );
                networks = JSON.parse(inspected);
            }
            spin.stop(networks ? 'Docker networks checked' : 'Docker is not running; keeping the default network');
        }
        if (!Array.isArray(networks)) {
            if (networksFile) ui.fail('The Docker network list is not a JSON array.', 'Run the setup again.');
        } else {
            // Compose takes COMPOSE_PROJECT_NAME from the env file over the folder name; in the container the
            // folder is /install, so only the launcher knows the project.
            const project =
                existing.get('COMPOSE_PROJECT_NAME') ||
                process.env['EIGEN_PROJECT'] ||
                (networksFile
                    ? ui.fail('EIGEN_PROJECT is not set.', 'Run configure through ./eigen setup.')
                    : basename(process.cwd())
                          .toLowerCase()
                          .replace(/[^a-z0-9_-]/g, '')
                          .replace(/^[^a-z0-9]+/, ''));
            subnet = chooseSubnet(networks, project);
        }
    }

    const entries = configureEntries(
        existing,
        { domain, mail, mailDomain, proxy, contactEmail, relay, from, subnet },
        wasMail,
    );
    for (const [key, value] of pins) entries.set(key, value);
    writeEnvFile(ENV_PATH, entries);
    if (backfill) {
        const added = [...entries.keys()].filter((key) => !existing.has(key));
        ui.outro(added.length ? `${ENV_PATH}: added ${added.join(', ')}.` : `${ENV_PATH} is up to date.`);
        return;
    }

    const saved = [`Wrote ${ENV_PATH}`];
    if (subnet && subnet !== DEFAULT_SUBNET && !existing.has('EIGEN_SUBNET'))
        saved.push(`Uses Docker network ${subnet}`);
    if (proxy) {
        const [bindHost, bindPort] = proxy.split(':');
        const target = `${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`;
        writeFileSync(
            'eigen.nginx.conf',
            `# Eigen reverse-proxy snippet for nginx.
# From the install folder: sudo ln -s "$PWD/eigen.nginx.conf" /etc/nginx/sites-enabled/eigen.conf
#
# The map directive below must live at http {} scope. On Debian/Ubuntu the default
# /etc/nginx/sites-enabled/* include is inside http {}, so dropping this file in works as-is.

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

    location / {
        proxy_pass http://${target};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;            # WebSocket upgrade
        proxy_set_header Connection $connection_upgrade;   # WebSocket upgrade
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Baseline security headers (the CSP + referrer meta ride in each app's HTML).
        add_header X-Frame-Options SAMEORIGIN always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

        proxy_buffering off;       # SSE streams chunks immediately
        proxy_cache off;
        proxy_read_timeout 24h;    # SSE / WebSocket: long-lived connections
        gzip off;                  # gzip would buffer SSE
    }
}
`,
        );
        writeFileSync(
            'eigen.Caddyfile',
            `# Eigen reverse-proxy snippet for Caddy. Append to your host Caddyfile.
${domain} {
    encode gzip zstd

    # Baseline security headers (the CSP + referrer meta ride in each app's HTML).
    header X-Frame-Options SAMEORIGIN
    header X-Content-Type-Options nosniff
    header Referrer-Policy "strict-origin-when-cross-origin"
    header Permissions-Policy "camera=(), microphone=(), geolocation=()"

    reverse_proxy ${target} {
        flush_interval -1
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
}
`,
        );
        writeFileSync(
            'eigen.apache.conf',
            `# Eigen reverse-proxy snippet for Apache 2.4.
# Drop into /etc/apache2/sites-available/eigen.conf, then: sudo a2ensite eigen
#
# Required modules, run once:
#   sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
#
# Use the event MPM (the default on modern Apache). The prefork MPM spawns one process
# per connection and exhausts slots under long-lived SSE / WebSocket clients:
#   sudo a2dismod mpm_prefork && sudo a2enmod mpm_event && sudo systemctl restart apache2

<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName ${domain}

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/${domain}/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/${domain}/privkey.pem

    ProxyPreserveHost On
    ProxyTimeout 86400              # SSE / WebSocket: long-lived connections
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Real-IP "%{REAL_CLIENT_IP}e"   # the gateway keys rate limits on this

    # Baseline security headers (the CSP + referrer meta ride in each app's HTML).
    Header always set X-Frame-Options SAMEORIGIN
    Header always set X-Content-Type-Options nosniff
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"

    # WebSocket upgrade (collab editing on sheets, slides, stickies, docs)
    RewriteEngine On
    # Stash the client IP so mod_headers can fill X-Real-IP (it can't read REMOTE_ADDR directly).
    RewriteRule .* - [E=REAL_CLIENT_IP:%{REMOTE_ADDR}]
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://${target}/$1" [P,L]

    # Everything else
    ProxyPass        / http://${target}/
    ProxyPassReverse / http://${target}/
</VirtualHost>
</IfModule>
`,
        );
        saved.push(`Wrote eigen.nginx.conf, eigen.Caddyfile and eigen.apache.conf; they forward to ${target}`);
    }
    ui.note('Saved', saved);

    const server = "your server's IP address";
    const records = [['A', domain, server]];
    if (mail) {
        if (mailDomain !== domain) records.push(['A', `autoconfig.${mailDomain}`, `${server} (optional)`]);
        records.push(
            ['MX', mailDomain, `10 ${domain}.`],
            ['TXT', mailDomain, `"v=spf1 mx${relay ? " include:<your relay's SPF domain>" : ''} ~all"`],
            ['TXT', `eigen._domainkey.${mailDomain}`, 'the DKIM key from the postfix log after the first start'],
            ['TXT', `_dmarc.${mailDomain}`, `"v=DMARC1; p=quarantine; rua=mailto:postmaster@${mailDomain}"`],
            ['SRV', `_imaps._tcp.${mailDomain}`, `0 1 993 ${domain}.`],
            ['SRV', `_submission._tcp.${mailDomain}`, `0 1 587 ${domain}.`],
            ['SRV', `_caldavs._tcp.${mailDomain}`, `0 1 443 ${domain}.`],
            ['SRV', `_carddavs._tcp.${mailDomain}`, `0 1 443 ${domain}.`],
            ['TXT', `_caldavs._tcp.${mailDomain}`, '"path=/dav/"'],
            ['TXT', `_carddavs._tcp.${mailDomain}`, '"path=/dav/"'],
            ['PTR', server, `${domain}, set at your hosting provider`],
        );
    }
    const width = Math.max(...records.map(([, name = '']) => name.length)) + 2;
    ui.note(
        'DNS records',
        records.map(([type = '', name = '', value]) => `${type.padEnd(5)}${name.padEnd(width)}${value}`),
    );
    ui.outro(networksFile ? 'Configuration saved.' : 'Next: ./eigen setup builds and starts Eigen.');
}
