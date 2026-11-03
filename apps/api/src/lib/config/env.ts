// The API's reads of its process environment, such as whether it runs in production, which docker profiles are on
// and the build it runs. Each is a function, so a test can change a variable between calls.

export function isProduction(): boolean {
    return process.env['PRODUCTION'] === '1' || process.env['NODE_ENV'] === 'production';
}

export function isTest(): boolean {
    return process.env['NODE_ENV'] === 'test';
}

export function isDemo(): boolean {
    return process.env['EIGEN_DEMO'] === '1';
}

// Hosted mailboxes come with the `mail` docker profile (postfix + dovecot). A deployment that runs without it sets
// MAIL_ENABLED=0, and the apps then hide every Mail entry point. A restore asks it of the .env.production it restores
// with.
export function isMailEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
    return env['MAIL_ENABLED'] !== '0';
}

// A demo box seeds mailboxes without an MTA: the Mail app stays while sendMail skips.
export function isMailAppEnabled(): boolean {
    return isMailEnabled() || isDemo();
}

// The `edge` docker profile runs the bundled Caddy. The API reads COMPOSE_PROFILES from .env.production through
// env_file.
export function isBundledCaddy(): boolean {
    return (process.env['COMPOSE_PROFILES'] ?? '').split(',').includes('edge');
}

// The path the public proxy serves the API under, such as `/eigen` in a standard install, with no trailing slash. Setup
// writes it as VITE_API_HOST, and a dev API's absolute VITE_API_HOST has none. The proxy strips it before the API sees
// a request, so only URLs inside a request, such as a WebDAV Destination, still carry it.
export function getApiBasePath(): string {
    const apiHost = process.env['VITE_API_HOST'] ?? '';
    const path = /^https?:\/\//.test(apiHost) ? new URL(apiHost).pathname : apiHost;
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    return trimmed ? `/${trimmed}` : '';
}

// The relay a mail-off install sends through; unset, it sends no email at all.
export function getRelayHost(): string | undefined {
    return process.env['SMTP_RELAY_HOST'] || undefined;
}

// The commit the API image was built from, set by its Dockerfile and by ./eigen for a local build. It is unset in
// `bun run dev`.
export function getBuildCommit(): string | undefined {
    return process.env['EIGEN_COMMIT'] || undefined;
}

// The install's .env.production, which Compose mounts read-only for the server backup. It is unset in `bun run dev`.
export function getEnvFile(): string | undefined {
    return process.env['EIGEN_ENV_FILE'] || undefined;
}
