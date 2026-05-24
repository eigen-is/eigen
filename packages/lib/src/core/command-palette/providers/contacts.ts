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

    return useMemo(() => suggestions.slice(0, 6).map((s, i) => suggestionToResult(s, -i)), [suggestions]);
}

function suggestionToResult(s: ContactSuggestion, rank: number): PaletteResult {
    return {
        kind: 'contact',
        id: `contact.${s.id}`,
        title: s.displayName,
        subtitle: s.email,
        icon: User,
        group: 'contacts',
        rank,
        payload: s,
        // Personal contacts open in the contacts app's All view by id (same URL the
        // app uses for its own row clicks). Team members aren't in the personal book,
        // so jumping to compose with their email is the canonical action.
        run: (ctx) =>
            s.kind === 'personal'
                ? ctx.navigate(getContactsAppUrl(`book/all?contactId=${s.id}`))
                : ctx.openMailComposeWith({ to: s.email }),
    };
}
