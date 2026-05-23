import type { CommandContext, Sections } from '@workspace/lib/types/command-palette';
import { useMemo } from 'react';
import { SUGGESTED_COMMAND_IDS } from '../commands';
import { buildSections } from '../engine';
import { parseQuery } from '../parse-query';
import { useActionResults } from '../providers/actions';
import { useContactResults } from '../providers/contacts';
import { useMailSearchResults } from '../providers/mail-search';
import { useSmartResults } from '../providers/smart';

export function useCommandResults(ctx: CommandContext, input: string): Sections {
    const parsed = parseQuery(input);
    const action = useActionResults(ctx, parsed.q);
    const contact = useContactResults(ctx, parsed.q);
    const smart = useSmartResults(ctx, input); // smart sees raw input — parses for shape
    const mail = useMailSearchResults(ctx, input);

    return useMemo(
        () =>
            buildSections({
                action,
                contact,
                smart,
                mail: mail.results,
                input,
                scope: parsed.scope,
                isMailPending: mail.isPending,
                suggestedCommandIds: SUGGESTED_COMMAND_IDS,
            }),
        [action, contact, smart, mail.results, mail.isPending, input, parsed.scope],
    );
}
