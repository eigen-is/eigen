import { getMailAppUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useSearch } from '../../search';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { parseQuery } from '../parse-query';

// Debounce keystrokes before firing the mail search. 150ms is short enough that the user
// doesn't notice the wait but long enough to coalesce a fast typing burst.
const MAIL_SEARCH_DEBOUNCE_MS = 150;

export function useMailSearchResults(
    ctx: CommandContext,
    input: string,
): {
    results: PaletteResult[];
    isPending: boolean;
} {
    const debouncedInput = useDebouncedValue(input, MAIL_SEARCH_DEBOUNCE_MS);
    const parsed = parseQuery(debouncedInput);

    // When a scope is set that excludes mail, skip the call entirely.
    const scopeBlocks = parsed.scope === 'actions' || parsed.scope === 'contacts';

    const { data, isFetching } = useSearch({
        ownerId: ctx.ownerId,
        q: parsed.q,
        sources: ['mail'],
        from: parsed.from,
        to: parsed.to,
        limit: 6,
        enabled: !scopeBlocks && parsed.q.length > 0,
    });

    const results = useMemo<PaletteResult[]>(() => {
        if (!data) return [];
        return data.mail.map((email: EmailSummary, i: number) => {
            // The mail route lives at /_auth/$filterType/$filterId — `box/<mailbox>` is
            // its canonical shape. Inbox is stored as the empty string in mail.db; route
            // segments need 'inbox'. Other mailboxes are lowercased because useEmails
            // lowercases the URL path on the wire (and the sidebar URLs match).
            const filterId = email.mailbox ? email.mailbox.toLowerCase() : 'inbox';
            return {
                kind: 'mail' as const,
                id: `mail.${email.id}`,
                title: email.subject || '(no subject)',
                subtitle: email.fromShort || email.fromAddress,
                icon: Mail,
                group: 'mail',
                rank: -i,
                payload: email,
                run: (ctx) => ctx.navigate(getMailAppUrl(`box/${filterId}?mailId=${email.id}`)),
            };
        });
    }, [data]);

    const willSearch = !scopeBlocks && input.trim().length > 0;
    const isDebouncing = willSearch && input !== debouncedInput;
    return { results, isPending: willSearch && (isDebouncing || isFetching) };
}
