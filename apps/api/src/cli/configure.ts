import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { parseArgs } from 'node:util';
import { APP_URLS } from '@workspace/lib/constants/app-urls';
import { DEFAULT_RELAY_PORT } from '@workspace/lib/constants/mail';
import { validateEmailAddress } from '@workspace/lib/validation';
import { readEnvFile, writeEnvFile } from './env-file';
import { ENV_PATH, IMAGE_NAMES, installOwner, ownAs, ROOT } from './install';
import { createUi, type Ui } from './ui';

export type ConfigureAnswers = {
    domain: string;
    mail: boolean;
    mailDomain: string;
    behindProxy: boolean;
    staticAddress: string;
    contactEmail: string;
    relay: { host: string; port: string; user: string; password: string } | null;
    subnet: string | null;
};

export type DockerNetwork = {
    Name: string;
    Labels: Record<string, string> | null;
    IPAM: { Config: { Subnet?: string }[] | null };
};

const DEFAULT_SUBNET = '172.20.0.0/24';
// Enough for a host that runs a few Eigen stacks side by side.
const SUBNET_CANDIDATES = [
    DEFAULT_SUBNET,
    '172.30.0.0/24',
    '172.31.0.0/24',
    ...[20, 21, 22, 23].map((n) => `10.${n}.0.0/24`),
];
const PROXY_SNIPPETS = join(ROOT, 'docker/proxy');
// The launcher resolves these on the host, where the Docker socket is.
const PINS = ['EIGEN_REGISTRY', 'EIGEN_VERSION', ...IMAGE_NAMES.map((name) => `EIGEN_${name.toUpperCase()}_IMAGE`)];
export const CONFIGURE_OPTIONS = {
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
    yes: { type: 'boolean' },
    // The update step's: only adds the keys the env file lacks, with their defaults; no existing line changes.
    backfill: { type: 'boolean' },
} as const;
export const CONFIGURE_USAGE = `Usage: ./eigen setup [flags]

Asks the setup questions and writes ${ENV_PATH}. Any flag makes the run non-interactive:
questions no flag answers are read from stdin, one line each. An empty line keeps the answer
in brackets; - clears an optional answer; a choice is answered with its number.

  --domain <name>              Web address, like eigen.example.com
  --mail-domain <name>         The domain of every user's address, like example.com
  --proxy <host:port>          Run behind your own web server, which forwards to host:port
  --no-proxy                   Let Eigen's own web server take ports 80 and 443
  --contact-email <address>    Contact address for Let's Encrypt
  --mail | --no-mail           Host email on this server
  --relay <host:port>          Send outgoing mail through this relay
  --no-relay                   No relay
  --relay-user <name>          Relay user name
  --relay-password-env <VAR>   Read the relay password from this environment variable
  --yes                        Keep the current or default answer for every flag not given
  --help                       Show this help`;

const NO_CONTROL = /^\P{Cc}*$/u;

function cleanDomain(value: string): string {
    return value
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
}

function isPort(value: string): boolean {
    return /^\d{1,5}$/.test(value) && +value > 0 && +value < 65536;
}

function isDottedDomain(value: string): boolean {
    return /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(cleanDomain(value));
}

function validateDomain(value: string): string | undefined {
    if (cleanDomain(value) !== 'localhost' && !isDottedDomain(value)) {
        return 'Enter a web address, like eigen.example.com, without https:// or a path.';
    }
}

// User addresses need a dot in their domain, so a mail domain cannot be localhost.
function validateMailDomain(value: string): string | undefined {
    if (!isDottedDomain(value)) {
        return 'Enter a mail domain with a dot, like example.com. To try Eigen locally, use eigen.localhost.';
    }
}

function validateEmail(value: string): string | undefined {
    if (!validateEmailAddress(value) || !NO_CONTROL.test(value))
        return 'Enter an email address like admin@example.com.';
}

function validateText(value: string): string | undefined {
    if (!NO_CONTROL.test(value)) return 'Remove the control characters from this answer.';
}

function validateAddress(value: string): string | undefined {
    const [host = '', port = '', extra] = value.split(':');
    const octets = host.split('.');
    const validHost = octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && +octet < 256);
    if (!validHost || !isPort(port) || extra !== undefined)
        return 'Enter an IPv4 address and port, like 127.0.0.1:8080.';
}

function validateRelay(value: string): string | undefined {
    if (value === '') return;
    const [host = '', port = String(DEFAULT_RELAY_PORT), extra] = value.split(':');
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host) || !isPort(port) || extra !== undefined) {
        return 'Enter the relay as host:port, like smtp-relay.brevo.com:587.';
    }
}

// Setup records the domain every account's address was made on; an unreadable data folder leaves the check to the API's boot.
function readSetMailDomain(): string | undefined {
    try {
        return JSON.parse(readFileSync('data/server/config.json', 'utf8')).mailDomain || undefined;
    } catch {
        return undefined;
    }
}

function cidrRange(cidr: string): [number, number] {
    const [ip = '', prefix = '32'] = cidr.split('/');
    const start = ip.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
    return [start, start + 2 ** (32 - Number(prefix)) - 1];
}

// A rerun reuses the live network's subnet, or the running containers are orphaned. Undefined when all are taken.
export function chooseSubnet(networks: DockerNetwork[], project: string): string | undefined {
    const live = networks.find(
        (network) => network.Name === `${project}_eigen` && network.Labels?.['com.docker.compose.project'] === project,
    );
    const liveSubnet = live?.IPAM.Config?.[0]?.Subnet;
    if (liveSubnet) return liveSubnet;
    const occupied = networks
        .flatMap((network) => network.IPAM.Config ?? [])
        .flatMap((config) => (config.Subnet && /^[\d.]+\/\d+$/.test(config.Subnet) ? [cidrRange(config.Subnet)] : []));
    return SUBNET_CANDIDATES.find((candidate) => {
        const [start, end] = cidrRange(candidate);
        return !occupied.some(([takenStart, takenEnd]) => start <= takenEnd && takenStart <= end);
    });
}

export function configureEntries(existing: Map<string, string>, answers: ConfigureAnswers): Map<string, string> {
    const entries = new Map(existing);
    const [staticHost = '', staticPort = ''] = answers.staticAddress.split(':');
    entries.set('DOMAIN', answers.domain);
    entries.set('MAIL_DOMAIN', answers.mailDomain);
    entries.set('ACME_EMAIL', answers.contactEmail);
    entries.set('COMPOSE_PROFILES', `${answers.behindProxy ? 'static' : 'edge'}${answers.mail ? ',mail' : ''}`);
    entries.set('MAIL_ENABLED', answers.mail ? '1' : '0');
    entries.set('EIGEN_STATIC_HOST', staticHost);
    entries.set('EIGEN_STATIC_PORT', staticPort);
    // Compose has no default for either, whether or not the mail profile runs unbound: this is their one default.
    const subnet = answers.subnet ?? DEFAULT_SUBNET;
    entries.set('EIGEN_SUBNET', subnet);
    if (!entries.has('EIGEN_UNBOUND_IP')) entries.set('EIGEN_UNBOUND_IP', subnet.replace(/\.0\/\d+$/, '.254'));

    // Postfix relays through these with hosted mail, the API without it.
    const relay = answers.relay ?? { host: '', port: '', user: '', password: '' };
    for (const [key, value] of [
        ['SMTP_RELAY_HOST', relay.host],
        ['SMTP_RELAY_PORT', relay.port],
        ['SMTP_RELAY_USER', relay.user],
        ['SMTP_RELAY_PASSWORD', relay.password],
    ] as const) {
        if (value) entries.set(key, value);
        else entries.delete(key);
    }

    entries.set('API_URL', `https://${answers.domain}`);
    for (const [key, value] of Object.entries(APP_URLS)) {
        if (!entries.has(key)) entries.set(key, value);
    }
    return entries;
}

export async function configure(
    flags: ReturnType<typeof parseArgs<{ options: typeof CONFIGURE_OPTIONS }>>['values'],
): Promise<void> {
    const backfill = flags.backfill === true;
    const acceptDefaults = backfill || flags.yes === true;
    // Annotated, so TypeScript sees that ui.fail never returns.
    const ui: Ui = await createUi(Object.keys(flags).length > 0);
    const existing = readEnvFile(ENV_PATH);
    if (backfill && !existing.get('DOMAIN')) ui.fail(`${ENV_PATH} has no DOMAIN.`, 'Run ./eigen setup first.');
    ui.intro('Configure Eigen');
    ui.explain('A few questions. Enter keeps the suggested answer.');

    const answer = async (
        question: { message: string; help: string; flag: string; placeholder?: string },
        given: string | undefined,
        initial: string,
        validate: (value: string) => string | undefined,
    ): Promise<string> => {
        const { message, flag } = question;
        if (given !== undefined) {
            const error = validate(given);
            return error ? ui.fail(`${flag}: ${error}`, `Pass a valid ${flag}.`) : given;
        }
        // Everything a backfill does not add, the final merge puts back as it was.
        if (backfill) return initial;
        if (acceptDefaults)
            return validate(initial) ? ui.fail(`No answer for "${message}".`, `Pass ${flag}.`) : initial;
        return ui.ask({ ...question, initial, validate });
    };
    const decide = async (
        given: boolean | undefined,
        initial: boolean,
        ask: (initial: boolean) => Promise<boolean>,
    ) => {
        if (given !== undefined) return given;
        if (acceptDefaults) return initial;
        return ask(initial);
    };

    const domain = cleanDomain(
        await answer(
            {
                message: 'Where will Eigen be hosted?',
                help: 'The web address people open, like eigen.example.com. You must be able to set its DNS records.',
                flag: '--domain',
                placeholder: 'eigen.example.com',
            },
            flags.domain,
            existing.get('DOMAIN') ?? '',
            validateDomain,
        ),
    );
    const setMailDomain = readSetMailDomain();
    const givenMailDomain = flags['mail-domain'];
    if (setMailDomain && givenMailDomain !== undefined && cleanDomain(givenMailDomain) !== setMailDomain) {
        ui.fail(
            `--mail-domain: every account here is on ${setMailDomain}, so the mail domain cannot change.`,
            'Leave out --mail-domain.',
        );
    }
    if (setMailDomain && !backfill) {
        ui.note(`Mail domain: ${setMailDomain}`, ['Set at the first setup; every account is on it.']);
    }
    const mailDomain =
        setMailDomain ??
        cleanDomain(
            await answer(
                {
                    message: 'Which mail domain will you use?',
                    help:
                        'Everyone signs in with an address on it, like jane@example.com.\n' +
                        'Mailboxes live on this server or wherever its email is hosted now.',
                    flag: '--mail-domain',
                },
                givenMailDomain,
                existing.get('MAIL_DOMAIN') || (domain === 'localhost' ? 'eigen.localhost' : domain),
                validateMailDomain,
            ),
        );
    const behindProxy = await decide(
        flags.proxy !== undefined ? true : flags['no-proxy'] ? false : undefined,
        (existing.get('COMPOSE_PROFILES') ?? '').split(',').includes('static'),
        (initial) =>
            ui.select({
                message: 'How do people reach Eigen over HTTPS?',
                options: [
                    { value: false, label: 'Eigen handles it on ports 80 and 443', hint: 'gets its own certificate' },
                    { value: true, label: 'My web server forwards to Eigen', hint: 'nginx, Apache, Caddy, a NAS' },
                ],
                initial,
                flag: '--proxy <host:port> or --no-proxy',
            }),
    );
    const currentStatic = `${existing.get('EIGEN_STATIC_HOST') || '127.0.0.1'}:${existing.get('EIGEN_STATIC_PORT') || '8080'}`;
    const staticAddress = behindProxy
        ? await answer(
              {
                  message: 'Where should Eigen listen for your web server, as host:port?',
                  help:
                      '127.0.0.1 keeps it on this machine.\n' +
                      'For a web server in Docker, use the Docker host, like 172.17.0.1.',
                  flag: '--proxy',
              },
              flags.proxy,
              currentStatic,
              validateAddress,
          )
        : currentStatic;
    // Only the bundled Caddy asks Let's Encrypt for a certificate.
    const currentContact = existing.get('ACME_EMAIL') || `admin@${mailDomain}`;
    const contactEmail =
        !behindProxy || flags['contact-email'] !== undefined
            ? await answer(
                  {
                      message: "Which email address should Let's Encrypt use?",
                      help: 'It only writes about problems with the HTTPS certificate.',
                      flag: '--contact-email',
                  },
                  flags['contact-email'],
                  currentContact,
                  validateEmail,
              )
            : currentContact;

    const mail = await decide(
        flags.mail ? true : flags['no-mail'] ? false : undefined,
        existing.get('MAIL_ENABLED') !== '0',
        (initial) =>
            ui.confirm({
                message: 'Host email on this server?',
                help:
                    'Yes: Eigen hosts the mailboxes, on ports 25, 465, 587 and 993.\n' +
                    'No: Eigen hosts no mailboxes. There is no Mail app, and email stays where it is.',
                flag: '--mail or --no-mail',
                initial,
            }),
    );

    const currentHost = existing.get('SMTP_RELAY_HOST');
    const relayAnswer = await answer(
        {
            message: 'Which mail relay should Eigen send through, as host:port? (optional)',
            help: mail
                ? 'Useful when your provider blocks port 25. Leave it empty to send directly.'
                : 'Eigen needs one to send sign-in codes, invitations and notifications.',
            flag: '--relay',
        },
        flags['no-relay'] ? '' : flags.relay,
        currentHost ? `${currentHost}:${existing.get('SMTP_RELAY_PORT') || DEFAULT_RELAY_PORT}` : '',
        validateRelay,
    );
    let relay: ConfigureAnswers['relay'] = null;
    if (relayAnswer) {
        const [host = '', port = String(DEFAULT_RELAY_PORT)] = relayAnswer.split(':');
        const user = await answer(
            {
                message: "What is the relay's user name? (optional)",
                help: 'Leave it empty if the relay needs none.',
                flag: '--relay-user',
            },
            flags['relay-user'],
            existing.get('SMTP_RELAY_USER') ?? '',
            validateText,
        );
        const current = existing.get('SMTP_RELAY_PASSWORD') ?? '';
        const passwordEnv = flags['relay-password-env'];
        let password = user ? current : '';
        if (user && passwordEnv !== undefined) {
            password =
                process.env[passwordEnv] ??
                ui.fail(`--relay-password-env: ${passwordEnv} is not set.`, `Export the password as ${passwordEnv}.`);
        } else if (user && !acceptDefaults) {
            const keep = current ? ', or --yes to keep the current password' : '';
            password =
                (await ui.password({
                    message: current
                        ? "What is the relay's password? (empty keeps the current one)"
                        : "What is the relay's password?",
                    help: `Saved in ${ENV_PATH}, which only its owner can read.`,
                    validate: (value) => (value || current ? validateText(value) : 'Enter the relay password.'),
                    flag: `--relay-password-env <VAR>${keep}`,
                })) || current;
        }
        if (user && !password) ui.fail('A relay user needs a password.', 'Pass --relay-password-env <VAR>.');
        if (validateText(password)) ui.fail('The relay password contains control characters.', 'Remove them.');
        relay = { host, port, user, password };
    }

    // Only the launcher's setup lists the host's networks to pick a subnet from; without the list, the default.
    const networksFile = process.env['EIGEN_DOCKER_NETWORKS'];
    let subnet = existing.get('EIGEN_SUBNET') ?? null;
    if (subnet === null && networksFile) {
        // Compose takes COMPOSE_PROJECT_NAME from the env file over the folder name, which is /install in here.
        const project =
            existing.get('COMPOSE_PROJECT_NAME') ||
            process.env['EIGEN_PROJECT'] ||
            ui.fail('EIGEN_PROJECT is not set.', 'Run configure through ./eigen setup.');
        let networks: DockerNetwork[];
        try {
            networks = JSON.parse(readFileSync(networksFile, 'utf8'));
        } catch {
            ui.fail('Could not read the list of Docker networks.', 'Run ./eigen setup again.');
        }
        subnet =
            chooseSubnet(networks, project) ??
            ui.fail(
                'Every subnet Eigen tries is taken by another Docker network on this host.',
                `Set EIGEN_SUBNET in ${ENV_PATH} to a free /24, like 10.99.0.0/24, then run ./eigen setup again.`,
            );
    }

    const entries = configureEntries(existing, {
        domain,
        mail,
        mailDomain,
        behindProxy,
        staticAddress,
        contactEmail,
        relay,
        subnet,
    });
    // A backfill keeps every existing value; only the release pins the launcher passes may change a line.
    const written = backfill ? new Map([...entries, ...existing]) : entries;
    // Passed in release mode alone: a source build's image sets its own EIGEN_REGISTRY, which is no pin.
    if (process.env['EIGEN_VERSION']) {
        for (const key of PINS) {
            const value = process.env[key];
            if (value) written.set(key, value);
        }
    }
    const changed = [...written.keys()].filter((key) => written.get(key) !== existing.get(key));
    if (changed.length === 0 && written.size === existing.size) {
        ui.outro('Configuration unchanged.');
        return;
    }
    writeEnvFile(ENV_PATH, written);
    ownAs(ENV_PATH, installOwner('.'));
    if (backfill) {
        ui.outro(`${ENV_PATH}: set ${changed.join(', ')}.`);
        return;
    }

    if (!mail && !relay) ui.note('No relay', ['Eigen sends no email. Run ./eigen setup again to add a relay.']);

    if (behindProxy) {
        const [bindHost, bindPort] = staticAddress.split(':');
        const target = `${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`;
        for (const name of ['eigen.nginx.conf', 'eigen.Caddyfile', 'eigen.apache.conf']) {
            const template = readFileSync(join(PROXY_SNIPPETS, name), 'utf8');
            writeFileSync(name, template.replaceAll('{{DOMAIN}}', domain).replaceAll('{{TARGET}}', target));
        }
        ui.note(`Point your web server at ${target}`, [
            'eigen.nginx.conf   link into /etc/nginx/sites-enabled/, reload nginx',
            'eigen.apache.conf  copy to sites-available/eigen.conf, a2ensite eigen',
            'eigen.Caddyfile    import in your Caddyfile, reload Caddy',
            `nginx and Apache expect a certbot certificate for ${domain}.`,
        ]);
    }

    // A local trial needs no DNS.
    if (!/(^|\.)localhost$/.test(domain)) {
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
            'Add these DNS records',
            records.map(([type = '', name = '', value]) => `${type.padEnd(5)}${name.padEnd(width)}${value}`),
        );
    }
    ui.outro('Configuration saved.');
}
