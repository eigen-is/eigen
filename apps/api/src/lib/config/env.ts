export function isProduction(): boolean {
    return process.env['PRODUCTION'] === '1' || process.env['NODE_ENV'] === 'production';
}

export function isTest(): boolean {
    return process.env['NODE_ENV'] === 'test';
}

export function isDemo(): boolean {
    return process.env['EIGEN_DEMO'] === '1';
}

// Hosted mailboxes come with the `mail` docker profile (postfix + dovecot). A deployment that
// runs without it sets MAIL_ENABLED=0, and the apps then hide every Mail entry point.
export function isMailEnabled(): boolean {
    return process.env['MAIL_ENABLED'] !== '0';
}

// A demo box seeds mailboxes without an MTA: the Mail app stays while sendMail skips.
export function isMailAppEnabled(): boolean {
    return isMailEnabled() || isDemo();
}

// The `edge` docker profile runs the bundled Caddy; the API reads COMPOSE_PROFILES from .env.production through env_file.
export function isBundledCaddy(): boolean {
    return (process.env['COMPOSE_PROFILES'] ?? '').split(',').includes('edge');
}

// The relay a mail-off install sends through; unset, it sends no email at all.
export function getRelayHost(): string | undefined {
    return process.env['SMTP_RELAY_HOST'] || undefined;
}
