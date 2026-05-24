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
        // Always jump to the contacts app — the "Send mail to <email>" smart row
        // already covers the compose intent; the contact row's job is to open the
        // person's page in contacts. The route handles both personal contacts and
        // team-member emails.
        run: (ctx) => ctx.navigate(getContactsAppUrl(`book/all?contactId=${s.id}`)),
    };
}
