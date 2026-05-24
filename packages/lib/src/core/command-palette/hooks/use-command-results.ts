import type { CommandContext, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { useMemo, useRef } from 'react';
import { SUGGESTED_COMMAND_IDS } from '../commands';
import { buildSections } from '../engine';
import { parseQuery } from '../parse-query';
import { useActionResults } from '../providers/actions';
import { useContactResults } from '../providers/contacts';
import { useMailSearchResults } from '../providers/mail-search';
import { useSmartResults } from '../providers/smart';

const EMPTY_SECTIONS: Sections = { topHit: undefined, groups: [] };

export function useCommandResults(ctx: CommandContext, input: string, scope?: PaletteScope): Sections {
    const parsed = parseQuery(input);
    // A typed prefix (mail:, >, @) is the strongest signal — if the user typed one,
    // honour it over the chip scope they set earlier via Tab.
    const effectiveScope = parsed.scope ?? scope;
    const action = useActionResults(ctx, parsed.q);
    const contact = useContactResults(ctx, parsed.q);
    const smart = useSmartResults(ctx, input); // smart sees raw input — parses for shape
    const mail = useMailSearchResults(ctx, input, effectiveScope);

    // While a mail search is in flight, keep rendering the last settled merge so the
    // palette doesn't collapse on every keystroke. The previous merge is "stale" in
    // the same sense that any debounced UI is — the user sees a frozen good state
    // for a few hundred milliseconds, then the new merge replaces it in one step.
    // Writing to a ref inside useMemo is the React docs' recommended cache pattern
    // (see "You Might Not Need an Effect" → caching expensive calculations).
    const lastSettledRef = useRef<Sections>(EMPTY_SECTIONS);

    return useMemo(() => {
        if (mail.isPending) return lastSettledRef.current;
        const next = buildSections({
            action,
            contact,
            smart,
            mail: mail.results,
            input,
            scope: effectiveScope,
            suggestedCommandIds: SUGGESTED_COMMAND_IDS,
        });
        lastSettledRef.current = next;
        return next;
    }, [action, contact, smart, mail.results, mail.isPending, input, effectiveScope]);
}
