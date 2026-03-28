import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';

export function extractMentionedEmails(content: string): string[] {
    const matches = content.match(EMAIL_FIND_REGEX);
    if (!matches) return [];
    return [...new Set(matches.map((e) => e.toLowerCase()))];
}
