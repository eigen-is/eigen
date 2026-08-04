#!/usr/bin/env bun
// Interactive setup for production deployment. Run: bun run setup
//
// Asks four questions, writes .env.production, generates host reverse-proxy snippets when
// the user runs Eigen behind an existing webserver, and prints the DNS records to add.
// Idempotent: re-running shows current values as defaults.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

const ENV_PATH = '.env.production';
const NGINX_OUT = 'eigen.nginx.conf';
const CADDY_OUT = 'eigen.Caddyfile';
const APACHE_OUT = 'eigen.apache.conf';

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
const isIPv4 = (s: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s);
const isPort = (s: string) => /^\d+$/.test(s) && +s > 0 && +s < 65536;

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

async function promptIPv4(question: string, fallback: string): Promise<string> {
    while (true) {
        const value = await ask(question, fallback);
        if (isIPv4(value)) return value;
        console.log('  Please enter a valid IPv4 address (e.g. 127.0.0.1 or 0.0.0.0).');
    }
}

async function promptPort(question: string, fallback: string): Promise<string> {
    while (true) {
        const value = await ask(question, fallback);
        if (isPort(value)) return value;
        console.log('  Please enter a port between 1 and 65535.');
    }
}

// --- docker subnet detection ---
//
// docker-compose.yml defaults to 172.20.0.0/24 for the eigen network. That collides with
// existing docker installs that already use it (default bridge sometimes runs there, or
// another compose stack got it first). On fresh installs we can detect the conflict and
// pick a free /24; on a re-run against a live eigen we MUST reuse the existing subnet so
// we don't shift it under a running deployment.

const DEFAULT_SUBNET = '172.20.0.0/24';
const SUBNET_CANDIDATES = [DEFAULT_SUBNET, '172.30.0.0/24', '172.31.0.0/24', '10.20.0.0/24'];

function cidrRange(cidr: string): [number, number] {
    const [ip, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr ?? '32', 10);
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    const start = (parts[0] * 2 ** 24 + parts[1] * 2 ** 16 + parts[2] * 2 ** 8 + parts[3]) >>> 0;
    const size = 2 ** (32 - prefix);
    return [start, start + size - 1];
}

function cidrsOverlap(a: string, b: string): boolean {
    const [aStart, aEnd] = cidrRange(a);
    const [bStart, bEnd] = cidrRange(b);
    return aStart <= bEnd && bStart <= aEnd;
}

// `.0` → `.254` for the /24's last-usable host (matches docker-compose.yml's unbound IP).
function unboundIpFor(subnet: string): string {
    return subnet.split('/')[0].replace(/\.0$/, '.254');
}

async function runDocker(args: string[]): Promise<{ stdout: string; ok: boolean }> {
    try {
        const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'ignore' });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return { stdout, ok: proc.exitCode === 0 };
    } catch {
        return { stdout: '', ok: false };
    }
}

// Returns null when the compose-baked default (172.20.0.0/24) is fine — no env vars
// needed. Returns { subnet, unboundIp, reason } when the env should pin a specific value.
async function detectSubnet(
    existing: Record<string, string>,
): Promise<{ subnet: string; unboundIp: string; reason: string } | null> {
    // 1. User-set wins. Don't second-guess hand-edited .env.production.
    if (existing.EIGEN_SUBNET && existing.EIGEN_UNBOUND_IP) {
        if (existing.EIGEN_SUBNET === DEFAULT_SUBNET) return null;
        return {
            subnet: existing.EIGEN_SUBNET,
            unboundIp: existing.EIGEN_UNBOUND_IP,
            reason: `preserved from existing .env.production (${existing.EIGEN_SUBNET})`,
        };
    }

    // 2. Docker not installed / not running → defer. Keep the default; if it conflicts at
    // compose-up time the user will see the troubleshooting doc.
    if (!(await runDocker(['info'])).ok) return null;

    // 3. Live eigen deployment? Reuse its actual subnet — the network already exists, and
    // re-creating it on a different subnet would orphan running containers.
    const eigenNet = await runDocker([
        'network',
        'inspect',
        'eigen_eigen',
        '--format',
        '{{(index .IPAM.Config 0).Subnet}}',
    ]);
    if (eigenNet.ok && eigenNet.stdout.trim()) {
        const existingSubnet = eigenNet.stdout.trim();
        if (existingSubnet === DEFAULT_SUBNET) return null;
        return {
            subnet: existingSubnet,
            unboundIp: unboundIpFor(existingSubnet),
            reason: `reused existing eigen_eigen network (${existingSubnet})`,
        };
    }

    // 4. Fresh install. Find a candidate /24 that doesn't overlap with any docker network.
    const ids = (await runDocker(['network', 'ls', '-q'])).stdout.trim().split('\n').filter(Boolean);
    if (ids.length === 0) return null;
    const inspect = await runDocker([
        'network',
        'inspect',
        ...ids,
        '--format',
        '{{range .IPAM.Config}}{{.Subnet}}{{"\\n"}}{{end}}',
    ]);
    const occupied = inspect.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.includes('/'));

    for (const candidate of SUBNET_CANDIDATES) {
        if (!occupied.some((o) => cidrsOverlap(candidate, o))) {
            if (candidate === DEFAULT_SUBNET) return null;
            return {
                subnet: candidate,
                unboundIp: unboundIpFor(candidate),
                reason: `${DEFAULT_SUBNET} already in use by another docker network; picked ${candidate}`,
            };
        }
    }
    // All candidates taken — let compose fail loudly so the user reaches the troubleshooting doc.
    return null;
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
    existing.COMPOSE_PROFILES?.includes('static') ?? false,
);
// Only the static profile binds a port to the host (the host webserver proxies to it).
// The edge profile already takes 80/443 from the bundled Caddy and ignores these.
let staticHost = existing.EIGEN_STATIC_HOST || '127.0.0.1';
let staticPort = existing.EIGEN_STATIC_PORT || '8080';
if (useHostProxy) {
    console.log('\nThe bundled `eigen-static` container is reached by your host webserver.');
    console.log('  127.0.0.1 = localhost-only (recommended when the proxy is on the same host)');
    console.log('  0.0.0.0   = exposed on all interfaces (LAN-reachable, useful for testing)');
    staticHost = await promptIPv4('  Bind host', staticHost);
    staticPort = await promptPort('  Bind port', staticPort);
}
const adminEmail = await promptEmail(
    'Admin email (Let’s Encrypt + setup wizard)',
    existing.ACME_EMAIL || `admin@${mailDomain}`,
);

rl.close();

// --- detect docker network state ---

const subnet = await detectSubnet(existing);
if (subnet) console.log(`\nDocker network: ${subnet.reason}`);

// --- write .env.production ---

// edge   = bundled Caddy with HTTPS termination
// static = bundled static-only frontend (no HTTPS), for use behind a host webserver
// mail   = bundled mail trio (postfix + dovecot + unbound)
const composeProfiles = useHostProxy ? 'static,mail' : 'edge,mail';

const subnetBlock = subnet
    ? `\n# === DOCKER NETWORK (auto-detected; default 172.20.0.0/24 conflicted with another network) ===
EIGEN_SUBNET=${subnet.subnet}
EIGEN_UNBOUND_IP=${subnet.unboundIp}
`
    : '';

const env = `# Eigen production config — generated by 'bun run setup'.

# === REQUIRED ===
DOMAIN=${domain}
MAIL_DOMAIN=${mailDomain}
ACME_EMAIL=${adminEmail}

# === DEPLOYMENT SHAPE ===
# edge,mail   = bundled Caddy + bundled mail (default, all-in-one)
# static,mail = bundled frontend container + bundled mail (use with your own webserver)
# edge        = bundled Caddy only (host runs its own mail server)
# static      = bundled frontend only (host runs both webserver and mail)
COMPOSE_PROFILES=${composeProfiles}
# Host:port the bundled \`eigen-static\` container binds on. Only used with the 'static'
# profile — your host webserver proxies to this. 127.0.0.1 = localhost-only,
# 0.0.0.0 = all interfaces (LAN-reachable).
EIGEN_STATIC_HOST=${staticHost}
EIGEN_STATIC_PORT=${staticPort}
${subnetBlock}

# === SMTP RELAY (optional — required if your VPS blocks outbound port 25) ===
# Brevo free tier: 300 emails/day. Sign up at https://brevo.com
SMTP_RELAY_HOST=${existing.SMTP_RELAY_HOST ?? ''}
SMTP_RELAY_PORT=${existing.SMTP_RELAY_PORT ?? '587'}
SMTP_RELAY_USER=${existing.SMTP_RELAY_USER ?? ''}
SMTP_RELAY_PASSWORD=${existing.SMTP_RELAY_PASSWORD ?? ''}

# === ADVANCED (auto-derived — only edit if you know what you're doing) ===
PRODUCTION=1
API_URL=https://${domain}
# VITE_API_HOST and the per-app URLs are RELATIVE on purpose. The frontend bundle
# resolves them against window.location.origin at runtime, so the same build serves
# correctly via the public domain, a LAN IP, a tunnel, or any other reverse-proxy
# hostname. Don't hardcode an absolute URL here unless API and apps live on
# different origins (rare; would also need CORS + cookie tweaks).
VITE_API_HOST=/eigen
TRUSTED_NETWORKS=127.0.0.0/8,::1,172.16.0.0/12

VITE_APP_SPACE_URL=/space
VITE_APP_MAIL_URL=/mail
VITE_APP_CALENDAR_URL=/calendar
VITE_APP_CONTACTS_URL=/contacts
VITE_APP_DRIVE_URL=/drive
VITE_APP_DOCS_URL=/docs
VITE_APP_STICKIES_URL=/stickies
VITE_APP_CHAT_URL=/chat
VITE_APP_ADMIN_URL=/admin
VITE_APP_SLIDES_URL=/slides
VITE_APP_SHEETS_URL=/sheets
VITE_APP_INDEX_URL=/
`;

writeFileSync(ENV_PATH, env);
console.log(`\n✓ Wrote ${ENV_PATH}`);

// --- data directory ---
//
// docker-compose.yml runs eigen-api as user 1000:1000 and bind-mounts ./data into the
// container. The directory must exist and be writable by that UID before the stack starts.
mkdirSync('data', { recursive: true });
let dataOwned = false;
try {
    const chown = Bun.spawn(['chown', '-R', '1000:1000', 'data'], { stdout: 'ignore', stderr: 'ignore' });
    await chown.exited;
    dataOwned = chown.exitCode === 0;
} catch {
    // chown unavailable (non-Unix host) — fall through to the manual instruction.
}
console.log(
    dataOwned
        ? '✓ Prepared data/ (owned by 1000:1000 for the container)'
        : '  Could not set data/ ownership — before starting, run: sudo chown -R 1000:1000 data',
);

// --- reverse-proxy snippets ---
//
// The bundled `eigen-static` container (profile `static`) handles SPA serving + API
// proxying internally on port 8080. Your webserver only needs to terminate HTTPS and
// forward everything to it, so the snippets here are intentionally minimal.

if (useHostProxy) {
    const nginxConf = `# Eigen reverse-proxy snippet for nginx.
# Symlink: ln -s ${resolve(NGINX_OUT)} /etc/nginx/sites-enabled/eigen.conf
#
# The map directive below must live at http {} scope. On Debian/Ubuntu the default
# /etc/nginx/sites-enabled/* include is inside http {}, so dropping this file in works
# as-is.

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
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;            # WebSocket upgrade
        proxy_set_header Connection $connection_upgrade;   # WebSocket upgrade
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;       # SSE streams chunks immediately
        proxy_cache off;
        proxy_read_timeout 24h;    # SSE / WebSocket: long-lived connections
        gzip off;                  # gzip would buffer SSE
    }
}
`;
    writeFileSync(NGINX_OUT, nginxConf);

    const caddyConf = `# Eigen reverse-proxy snippet for Caddy. Append to your host Caddyfile.
${domain} {
    encode gzip zstd
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
}
`;
    writeFileSync(CADDY_OUT, caddyConf);

    const apacheConf = `# Eigen reverse-proxy snippet for Apache 2.4.
# Drop into /etc/apache2/sites-available/eigen.conf, then: sudo a2ensite eigen
#
# Required modules — run once:
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

    # WebSocket upgrade (collab editing on sheets, slides, stickies, docs)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:8080/$1" [P,L]

    # Everything else
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
</IfModule>
`;
    writeFileSync(APACHE_OUT, apacheConf);
    console.log(`✓ Wrote ${NGINX_OUT}, ${CADDY_OUT}, and ${APACHE_OUT}`);
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
// Load .env.production before the build the same way update.sh does (scripts/update.sh) — the index
// prerender reads DOMAIN at build time for canonical/og:url/JSON-LD URLs and sitemap.xml.
console.log(
    '  2. bun install && set -a && source .env.production && set +a && bun run --sequential --filter "./apps/*" build',
);
console.log('  3. bun --filter "@apps/api" buildfordocker');
if (useHostProxy) {
    console.log('  4. docker compose --env-file .env.production build       # bakes dist/ into eigen-static');
    console.log('  5. docker compose --env-file .env.production up -d');
    console.log(
        `  6. Wire the snippet in: ln -s ${resolve(NGINX_OUT)} /etc/nginx/sites-enabled/eigen.conf && systemctl reload nginx`,
    );
} else {
    console.log('  4. docker compose --env-file .env.production up -d');
}
if (mailDomain !== domain) {
    console.log(`\nNote: web is on ${domain} but mail is @${mailDomain}. Mail clients won't auto-find`);
    console.log(`autoconfig — either add an autoconfig.${mailDomain} record (see above) or have users`);
    console.log(`enter ${domain} as IMAP/SMTP server manually.`);
}
console.log(`\nWhen everything is up, visit: https://${domain}/admin\n`);
