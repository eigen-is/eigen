const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export {EMAIL_REGEX};

export function validateEmailAddress(value: string): boolean {
    return EMAIL_REGEX.test(value.trim());
}

export function validateEmailTarget(value: string, context: string): string | null {
    if (!value || !value.trim()) return `${context} target cannot be empty`;
    if (!validateEmailAddress(value)) return `'${value}' is not a valid email address`;
    return null;
}

// Email regex for finding emails in text (global flag for multiple matches)
export const EMAIL_FIND_REGEX = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

