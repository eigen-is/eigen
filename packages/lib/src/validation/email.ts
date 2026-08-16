const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_FIND_REGEX = /[^\s@([]+@[^\s@]+\.[^\s@.,;:!?\])]+/g;

// RFC 5321's practical maximum: the SMTP path is capped at 256 octets including the angle
// brackets, so no conforming address is longer. The single bound for every email input.
export const MAX_EMAIL_LENGTH = 254;

export function validateEmailAddress(value: string): boolean {
    return EMAIL_REGEX.test(value.trim());
}

export function validateEmailTarget(value: string, context: string): string | null {
    if (!value?.trim()) return `${context} target cannot be empty`;
    if (!validateEmailAddress(value)) return `'${value}' is not a valid email address`;
    return null;
}
