import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import type { Contact } from '@workspace/lib/types/contact';
import { User } from 'lucide-react';
import { useMemo } from 'react';
import { useContacts } from '../../contacts/hooks/use-contacts';

// Canonical Contact fields (per packages/lib/src/types/contact.ts):
//   { id, firstName, lastName, email: string[], phone: string[], ... }
// — useContacts() takes no args; it resolves ownerId from useAuth() internally.

function contactName(c: Contact): string {
    const full = `${c.firstName} ${c.lastName}`.trim();
    return full || c.email[0] || 'Unknown contact';
}

export function useContactResults(_ctx: CommandContext, input: string): PaletteResult[] {
    const { data: contacts } = useContacts();

    return useMemo(() => {
        if (input.trim().length === 0) return [];
        const needle = input.trim().toLowerCase();
        const matches = (contacts ?? []).filter(
            (c) =>
                contactName(c).toLowerCase().includes(needle) || c.email.some((e) => e.toLowerCase().includes(needle)),
        );
        return matches.slice(0, 6).map((c, i) => contactToResult(c, -i));
    }, [contacts, input]);
}

function contactToResult(contact: Contact, rank: number): PaletteResult {
    const primaryEmail = contact.email[0];
    return {
        kind: 'contact',
        id: `contact.${contact.id}`,
        title: contactName(contact),
        subtitle: primaryEmail,
        icon: User,
        group: 'contacts',
        rank,
        payload: contact,
        run: (ctx) => {
            if (primaryEmail) ctx.openMailComposeWith({ to: primaryEmail });
        },
    };
}
