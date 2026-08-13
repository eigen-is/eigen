import { getMailAppUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchQuery } from '../../search';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

// Debounce keystrokes before firing the mail search. 150ms is short enough that the user
// doesn't notice the wait but long enough to coalesce a fast typing burst.
const MAIL_SEARCH_DEBOUNCE_MS = 150;

export function useMailSearchResults(
    ctx: CommandContext,
    input: string,
    scope: PaletteScope | undefined,
): {
    results: PaletteResult[];
    isPending: boolean;
} {
    const debouncedInput = useDebouncedValue(input, MAIL_SEARCH_DEBOUNCE_MS);
    const parsed = parseQuery(debouncedInput);

    // Skip the network call when scope excludes mail. The effective scope already
    // merges the typed prefix (`mail:`, `>`, `@`) with the chip scope set via Tab.
    const scopeBlocks = scope === 'actions' || scope === 'contacts' || scope === 'doc';

    const { data, isFetching } = useSearchQuery({
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
        const encodedQ = parsed.q ? encodeURIComponent(parsed.q) : '';
        return data.mail.map((email, i) => {
            // The mail route lives at /_auth/$filterType/$filterId — `box/<mailbox>` is
            // its canonical shape. Inbox is stored as the empty string in mail.db; route
            // segments need 'inbox'. Other mailboxes are lowercased because useEmails
            // lowercases the URL path on the wire (and the sidebar URLs match).
            const filterId = email.mailbox ? email.mailbox.toLowerCase() : 'inbox';
            return {
                kind: 'mail' as const,
                id: `mail.${email.id}`,
                title: email.subject || '(no subject)',
                icon: Mail,
                group: 'mail',
                rank: -i,
                payload: email,
                run: (rctx) =>
                    rctx.navigate(
                        getMailAppUrl(`box/${filterId}?mailId=${email.id}${encodedQ ? `&q=${encodedQ}` : ''}`),
                    ),
            };
        });
    }, [data, parsed.q]);

    // `willSearch` matches the `enabled` predicate above — same shape both ways so
    // typing only an operator (`from:alice@x` with no q) doesn't stick `isPending`
    // permanently true while the underlying query is disabled.
    const willSearch = !scopeBlocks && parsed.q.length > 0;
    const isDebouncing = !scopeBlocks && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (willSearch && isFetching) || isDebouncing };
}
