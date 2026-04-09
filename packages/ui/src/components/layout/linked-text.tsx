import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const URL_REGEX = /https?:\/\/[^\s<>'")\]]+[^\s<>'")\].,;:!?]/g;

export function LinkedText({ text, className }: { text: string; className?: string }) {
    const parts: ReactNode[] = [];
    const urlRegex = new RegExp(URL_REGEX);

    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(text.slice(lastIdx, match.index));
        }
        parts.push(
            <a
                key={match.index}
                href={match[0]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline break-all"
            >
                {match[0]}
            </a>,
        );
        lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) {
        parts.push(text.slice(lastIdx));
    }
    return <p className={cn('whitespace-pre-line break-words', className)}>{parts}</p>;
}
