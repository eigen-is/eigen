import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { UserNameCard } from '@workspace/ui/components/layout/user-name-card';
import type { ReactNode } from 'react';

function InlineEmail({ email }: { email: string }) {
    return <UserNameCard email={email} mailLink className="cursor-default font-medium" />;
}

// Matches http(s) URLs, trimming trailing punctuation.
const URL_REGEX = /https?:\/\/[^\s<>'")\]]+[^\s<>'")\].,;:!?]/g;

type RichToken = { index: number; end: number; type: 'email' | 'url'; value: string };

function tokenize(text: string): RichToken[] {
    const tokens: RichToken[] = [];
    const emailRegex = new RegExp(EMAIL_FIND_REGEX);
    const urlRegex = new RegExp(URL_REGEX);

    let match: RegExpExecArray | null;
    while ((match = emailRegex.exec(text)) !== null) {
        tokens.push({ index: match.index, end: match.index + match[0].length, type: 'email', value: match[0] });
    }
    while ((match = urlRegex.exec(text)) !== null) {
        tokens.push({ index: match.index, end: match.index + match[0].length, type: 'url', value: match[0] });
    }

    tokens.sort((a, b) => a.index - b.index);
    return tokens;
}

export function RichContent({ text, className }: { text: string; className?: string }) {
    const parts: ReactNode[] = [];
    const tokens = tokenize(text);

    let lastIdx = 0;
    for (const token of tokens) {
        if (token.index < lastIdx) continue;
        if (token.index > lastIdx) {
            parts.push(text.slice(lastIdx, token.index));
        }
        if (token.type === 'email') {
            parts.push(<InlineEmail key={token.index} email={token.value} />);
        } else {
            parts.push(
                <a
                    key={token.index}
                    href={token.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link hover:underline break-all"
                >
                    {token.value}
                </a>,
            );
        }
        lastIdx = token.end;
    }
    if (lastIdx < text.length) {
        parts.push(text.slice(lastIdx));
    }
    return <p className={className}>{parts}</p>;
}
