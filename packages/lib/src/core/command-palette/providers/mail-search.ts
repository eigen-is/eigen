import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useSearch } from '../../search';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { parseQuery } from '../parse-query';

export function useMailSearchResults(
    ctx: CommandContext,
    input: string,
): {
    results: PaletteResult[];
    isPending: boolean;
} {
    const debouncedInput = useDebouncedValue(input, 150);
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
        return data.mail.map((email: EmailSummary, i: number) => ({
            kind: 'mail' as const,
            id: `mail.${email.id}`,
            title: email.subject || '(no subject)',
            subtitle: email.fromShort || email.fromAddress,
            icon: Mail,
            group: 'mail',
            rank: -i,
            payload: email,
        }));
    }, [data]);

    return { results, isPending: !scopeBlocks && parsed.q.length > 0 && isFetching };
}
