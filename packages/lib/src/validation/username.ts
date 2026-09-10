// RFC 2142 role mailboxes: unclaimable, and mail to them fans out to every org admin. Spread into
// RESERVED_USERNAMES below so the two can never drift.
export const ROLE_MAILBOX_LOCAL_PARTS = new Set(['postmaster', 'abuse', 'noreply']);

const RESERVED_USERNAMES = new Set([
    // System/admin
    'admin',
    'administrator',
    'root',
    'superuser',
    'sysadmin',
    // Email standards
    ...ROLE_MAILBOX_LOCAL_PARTS,
    'webmaster',
    'hostmaster',
    'mailer-daemon',
    'no-reply',
    // Support
    'support',
    'help',
    'info',
    'contact',
    'security',
    // Protocols/infra
    'www',
    'ftp',
    'mail',
    'smtp',
    'imap',
    'pop',
    'caldav',
    'carddav',
    // Brand
    'eigen',
    // Generic
    'system',
    'daemon',
    'nobody',
    'test',
    'demo',
    'guest',
    'user',
    'api',
]);

const USERNAME_REGEX = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

export function validateUsername(username: string): string | null {
    if (username.length < 2 || username.length > 30) return 'Username must be 2-30 characters';
    if (!USERNAME_REGEX.test(username))
        return 'Username must be lowercase alphanumeric, dots, or hyphens (no leading/trailing dot or hyphen)';
    if (username.includes('..')) return 'Username cannot contain consecutive dots';
    if (RESERVED_USERNAMES.has(username.toLowerCase())) return 'This username is reserved';
    return null;
}
