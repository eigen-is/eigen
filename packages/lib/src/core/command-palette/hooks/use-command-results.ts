import type { CommandContext, Sections } from '@workspace/lib/types/command-palette';
import { useMemo } from 'react';
import { SUGGESTED_COMMAND_IDS } from '../commands';
import { buildSections } from '../engine';
import { parseQuery } from '../parse-query';
import { useActionResults } from '../providers/actions';
import { useContactResults } from '../providers/contacts';
import { useMailSearchResults } from '../providers/mail-search';
import { useSmartResults } from '../providers/smart';

const EMPTY_SECTIONS: Sections = { topHit: undefined, groups: [] };

export function useCommandResults(ctx: CommandContext, input: string): Sections {
    const parsed = parseQuery(input);
    const action = useActionResults(ctx, parsed.q);
    const contact = useContactResults(ctx, parsed.q);
    const smart = useSmartResults(ctx, input); // smart sees raw input — parses for shape
    const mail = useMailSearchResults(ctx, input);

    return useMemo(() => {
        // While a mail search is in flight, hold back the entire result set. The
        // alternative — showing actions/contacts immediately and letting mail join
        // later — visibly reorders the palette and made it feel unstable. With this
        // gate the user sees a single coherent merge once the search settles.
        // Scope-blocked queries (e.g. ">actions", "@alice") never enter pending, so
        // they render immediately as before.
        if (mail.isPending) return EMPTY_SECTIONS;
        return buildSections({
            action,
            contact,
            smart,
            mail: mail.results,
            input,
            scope: parsed.scope,
            suggestedCommandIds: SUGGESTED_COMMAND_IDS,
        });
    }, [action, contact, smart, mail.results, mail.isPending, input, parsed.scope]);
}
