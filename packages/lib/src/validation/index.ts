const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: string): boolean {
    return EMAIL_REGEX.test(value);
}

export function validateEmailTarget(value: string, context: string): string | null {
    if (!value || !value.trim()) return `${context} target cannot be empty`;
    if (!isEmailAddress(value.trim())) return `'${value}' is not a valid email address`;
    return null;
}

export function validateACLEmails(acl: { email: string; public?: boolean }[]): string | null {
    for (const entry of acl) {
        if (entry.public && !entry.email) continue;
        if (!isEmailAddress(entry.email)) {
            return `Invalid email in ACL: '${entry.email}'`;
        }
    }
    return null;
}
