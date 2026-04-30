#!/usr/bin/env bun
// Interactive setup for production deployment. Run: bun run setup
//
// Asks four questions, writes .env.production, generates host reverse-proxy snippets when
// the user runs Eigen behind an existing webserver, and prints the DNS records to add.
// Idempotent: re-running shows current values as defaults.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

const ENV_PATH = '.env.production';
const NGINX_OUT = 'eigen.nginx.conf';
const CADDY_OUT = 'eigen.Caddyfile';

// Frontend apps that ship as separate dist subdirs under /<appname>/. Keep in sync with
// the bundled Caddyfile and vite.shared.config.ts. Order doesn't matter.
const APPS = [
    'mail',
    'drive',
    'docs',
    'contacts',
    'calendar',
    'chat',
    'stickies',
    'slides',
    'sheets',
    'space',
    'admin',
] as const;

// Event-based readline that buffers lines arriving before a consumer asks. This handles both
// the TTY case (lines come one at a time after each prompt) and the piped case (all lines
// arrive before the first prompt is awaited). Bun's readline/promises hangs in the latter.
const rl = createInterface({ input: stdin });
const buffered: string[] = [];
const pending: ((line: string) => void)[] = [];
let closed = false;
rl.on('line', (line) => {
    const next = pending.shift();
    if (next) next(line);
    else buffered.push(line);
});
rl.on('close', () => {
    closed = true;
    while (pending.length) pending.shift()?.('');
});

function prompt(text: string): Promise<string> {
    if (closed && !buffered.length) {
        console.error('\nSetup aborted: stdin closed before all questions answered.');
        process.exit(1);
    }
    stdout.write(text);
    if (buffered.length) return Promise.resolve(buffered.shift() as string);
    return new Promise((res) => pending.push(res));
}

async function ask(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await prompt(`${question}${suffix}: `)).trim();
    return answer || fallback || '';
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await prompt(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer.startsWith('y');
}

const isDomain = (s: string) => /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(s);
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Strip protocol/path users may paste in by accident.
function cleanDomain(s: string): string {
    return s
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
}

// Strip surrounding quotes the user may have hand-added. Docker env-file format treats them
// literally, so unquoted is the safe shape on round-trip.
function readExisting(): Record<string, string> {
    if (!existsSync(ENV_PATH)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}

const PLACEHOLDER_DOMAINS = new Set(['eigen.example.com', 'example.com', 'localhost']);

async function promptDomain(question: string, fallback?: string): Promise<string> {
    while (true) {
        const raw = await ask(question, fallback);
        const value = cleanDomain(raw);
        if (isDomain(value) && !PLACEHOLDER_DOMAINS.has(value)) return value;
        console.log('  Please enter a real domain (no scheme, no path).');
    }
}

async function promptEmail(question: string, fallback: string): Promise<string> {
    while (true) {
        const value = await ask(question, fallback);
        if (isEmail(value)) return value;
        console.log('  Please enter a valid email address.');
    }
}

// --- main ---

console.log('\n--- Eigen setup ---\n');
const existing = readExisting();
if (Object.keys(existing).length) {
    console.log(`Found existing ${ENV_PATH}; current values shown as defaults.\n`);
}

const domain = await promptDomain('Web URL (e.g. eigen.example.com)', existing.DOMAIN);
// When the web URL has 3+ labels, suggest the parent as the default mail domain. Heuristic
// only (no public-suffix awareness — doesn't matter, the user confirms).
const labels = domain.split('.');
const mailDefault = existing.MAIL_DOMAIN || (labels.length >= 3 ? labels.slice(1).join('.') : domain);
const mailDomain = await promptDomain('Mail domain (addresses end @<this>)', mailDefault);
const useHostProxy = await askYesNo(
    'Run Eigen behind an existing webserver on this host (nginx, Caddy, …)?',
    existing.COMPOSE_PROFILES === 'mail',
);
const adminEmail = await promptEmail(
    'Admin email (Let’s Encrypt + setup wizard)',
    existing.ACME_EMAIL || `admin@${mailDomain}`,
);

rl.close();

// --- write .env.production ---

const composeProfiles = useHostProxy ? 'mail' : 'edge,mail';

const env = `# Eigen production config — generated by 'bun run setup'.

# === REQUIRED ===
DOMAIN=${domain}
MAIL_DOMAIN=${mailDomain}
ACME_EMAIL=${adminEmail}

# === DEPLOYMENT SHAPE ===
# edge,mail = bundled Caddy + bundled mail. Drop 'edge' to use a host webserver.
COMPOSE_PROFILES=${composeProfiles}
# Host bind for the API; only reached when COMPOSE_PROFILES omits 'edge'.
EIGEN_API_BIND=127.0.0.1:8000

# === SMTP RELAY (optional — required if your VPS blocks outbound port 25) ===
# Brevo free tier: 300 emails/day. Sign up at https://brevo.com
SMTP_RELAY_HOST=${existing.SMTP_RELAY_HOST ?? ''}
SMTP_RELAY_PORT=${existing.SMTP_RELAY_PORT ?? '587'}
SMTP_RELAY_USER=${existing.SMTP_RELAY_USER ?? ''}
SMTP_RELAY_PASSWORD=${existing.SMTP_RELAY_PASSWORD ?? ''}

# === ADVANCED (auto-derived — only edit if you know what you're doing) ===
PRODUCTION=1
API_URL=https://${domain}
VITE_API_HOST=https://${domain}/eigen
COOKIE_DOMAIN=.${domain}
TRUSTED_NETWORKS=127.0.0.0/8,::1,172.16.0.0/12

VITE_APP_SPACE_URL=https://${domain}/space
VITE_APP_MAIL_URL=https://${domain}/mail
VITE_APP_CALENDAR_URL=https://${domain}/calendar
VITE_APP_CONTACTS_URL=https://${domain}/contacts
VITE_APP_DRIVE_URL=https://${domain}/drive
VITE_APP_DOCS_URL=https://${domain}/docs
VITE_APP_STICKIES_URL=https://${domain}/stickies
VITE_APP_CHAT_URL=https://${domain}/chat
VITE_APP_ADMIN_URL=https://${domain}/admin
VITE_APP_SLIDES_URL=https://${domain}/slides
VITE_APP_SHEETS_URL=https://${domain}/sheets
`;

writeFileSync(ENV_PATH, env);
console.log(`\n✓ Wrote ${ENV_PATH}`);

// --- reverse-proxy snippets ---

if (useHostProxy) {
    const distRoot = resolve('dist');
    const appRegex = APPS.join('|');
    const nginxConf = `# Eigen reverse-proxy snippet for nginx.
# Symlink: ln -s ${resolve(NGINX_OUT)} /etc/nginx/sites-enabled/eigen.conf
#
# Make sure your nginx http {} block has the WebSocket upgrade map below — it's
# required for collaborative editing (sheets, slides, stickies, docs). On Debian/
# Ubuntu, /etc/nginx/sites-enabled/* is included from http {}, so dropping this
# whole file in just works.

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

    # API + WebSocket (collab editing uses /eigen/ws/collab/...)
    location /eigen/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;            # WebSocket upgrade
        proxy_set_header Connection $connection_upgrade;   # WebSocket upgrade
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;       # SSE: stream chunks immediately
        proxy_cache off;
        proxy_read_timeout 24h;    # SSE / WebSocket: long-lived connections
        gzip off;                  # SSE: gzip would buffer
    }

    # CalDAV
    location /dav/ {
        proxy_pass http://127.0.0.1:8000/dav/;
        proxy_http_version 1.1;
        proxy_read_timeout 5m;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location = /.well-known/caldav { return 301 /dav/; }

    # SPA bundles — each app is built into its own /<appname>/ subdir with assets
    # referenced as /<appname>/assets/... Match the path; fall back to that app's
    # index.html so deep links (/mail/inbox, /drive/folder/abc) hit the SPA router.
    location ~ ^/(${appRegex})(/.*)?$ {
        root ${distRoot};
        try_files $uri $uri/ /$1/index.html;
    }

    # Landing page
    location / {
        root ${distRoot}/index;
        try_files $uri $uri/ /index.html;
    }
}
`;
    writeFileSync(NGINX_OUT, nginxConf);

    const caddyConf = `# Eigen reverse-proxy snippet for Caddy. Append to your host Caddyfile.

(app) {
    redir /{args[0]} /{args[0]}/ 308
    handle_path /{args[0]}/* {
        root * ${distRoot}/{args[0]}
        try_files {path} /index.html
        file_server
    }
}

${domain} {
    encode gzip zstd

    # API + WebSocket (Caddy auto-detects upgrade requests)
    handle_path /eigen/* {
        reverse_proxy 127.0.0.1:8000 {
            flush_interval -1
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }

    # CalDAV
    handle /dav/* {
        reverse_proxy 127.0.0.1:8000
    }
    redir /.well-known/caldav /dav/ 301

    # Frontend apps
${APPS.map((app) => `    import app ${app}`).join('\n')}

    # Landing page
    handle {
        root * ${distRoot}/index
        try_files {path} {path}/index.html /index.html
        file_server
    }
}
`;
    writeFileSync(CADDY_OUT, caddyConf);
    console.log(`✓ Wrote ${NGINX_OUT} and ${CADDY_OUT}`);
}

// --- DNS records ---

const dkimHost = `eigen._domainkey.${mailDomain}`;
console.log('\n--- DNS records to add ---');
console.log(`  A     ${domain.padEnd(40)} -> YOUR_SERVER_IP`);
if (mailDomain !== domain) {
    console.log(
        `  A     ${`autoconfig.${mailDomain}`.padEnd(40)} -> YOUR_SERVER_IP   (optional, mail-client autoconfig)`,
    );
}
console.log(`  MX    ${mailDomain.padEnd(40)} 10 ${domain}.`);
console.log(`  TXT   ${mailDomain.padEnd(40)} "v=spf1 mx ~all"`);
console.log(
    `  TXT   ${`_dmarc.${mailDomain}`.padEnd(40)} "v=DMARC1; p=quarantine; rua=mailto:postmaster@${mailDomain}"`,
);
console.log(`  TXT   ${dkimHost.padEnd(40)} <printed in postfix logs after first boot>`);
console.log(`  SRV   ${`_imaps._tcp.${mailDomain}`.padEnd(40)} 0 1 993 ${domain}.`);
console.log(`  SRV   ${`_submission._tcp.${mailDomain}`.padEnd(40)} 0 1 587 ${domain}.`);
console.log(`  PTR   (your VPS rDNS)                          -> ${domain}`);

// --- next steps ---

console.log('\n--- Next steps ---');
console.log('  1. Add the DNS records above');
if (useHostProxy) {
    console.log(
        `  2. Wire the snippet in (e.g. ln -s ${resolve(NGINX_OUT)} /etc/nginx/sites-enabled/eigen.conf, reload)`,
    );
    console.log('  3. bun install && bun run --sequential --filter "./apps/*" build');
    console.log('  4. bun --filter "@apps/api" buildfordocker && docker compose --env-file .env.production up -d');
} else {
    console.log('  2. bun install && bun run --sequential --filter "./apps/*" build');
    console.log('  3. bun --filter "@apps/api" buildfordocker && docker compose --env-file .env.production up -d');
}
if (mailDomain !== domain) {
    console.log(`\nNote: web is on ${domain} but mail is @${mailDomain}. Mail clients won't auto-find`);
    console.log(`autoconfig — either add an autoconfig.${mailDomain} record (see above) or have users`);
    console.log(`enter ${domain} as IMAP/SMTP server manually.`);
}
console.log(`\nWhen everything is up, visit: https://${domain}/admin\n`);
