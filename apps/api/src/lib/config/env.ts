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
