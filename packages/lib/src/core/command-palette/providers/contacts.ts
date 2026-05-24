import { getContactsAppUrl } from '@workspace/lib/api';
import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { User } from 'lucide-react';
import { useMemo } from 'react';
import { useContactSuggestions } from '../../contacts';

// Reuse the same suggestion hook the mail/calendar/drive-share autosuggest UIs
// use — personal contacts + team members, merged and deduped. Without this the
// palette would silently miss team members typing their name.
export function useContactResults(_ctx: CommandContext, input: string): PaletteResult[] {
    const { suggestions } = useContactSuggestions(input);

    return useMemo(() => suggestions.map((s, i) => suggestionToResult(s, -i)), [suggestions]);
}

function suggestionToResult(s: ContactSuggestion, rank: number): PaletteResult {
    return {
        kind: 'contact',
        id: `contact.${s.id}`,
        title: s.displayName,
        icon: User,
        group: 'contacts',
        rank,
        payload: s,
        // Personal contacts open in the contacts app's All view by uuid; team members
        // open in their team's view scoped by email (book/all doesn't index team
        // members — see apps/contacts/src/routes/_auth.$filterType.$filterId.tsx).
        run: (ctx) =>
            s.kind === 'team' && s.teamId
                ? ctx.navigate(getContactsAppUrl(`team/${s.teamId}?contactId=${encodeURIComponent(s.email)}`))
                : ctx.navigate(getContactsAppUrl(`book/all?contactId=${s.id}`)),
    };
}
