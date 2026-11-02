// The palette's smart rows: what the typed text itself suggests. A whole email address or web link
// claims the Top hit with Mail to or Open link, and a matching contact adds Send mail to rows under
// Suggestions. With a selection the page offers to mail, the mail rows send those files along.

import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { ExternalLink, Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useContactSuggestions } from '../../contacts';
import { parseQuery } from '../parse-query';
import { parseSmartInput } from '../parse-smart-input';

// A sure shape, a whole email address or URL, claims the Top hit outright. A row from a matching
// contact sits under Suggestions, and the one that sends the selected files ranks first there. These
// ranks never compete with the catalog's base ranks, because they sort another section.
const SMART_RANKS = {
    DETERMINISTIC: 1000,
    CONTACT_WITH_ATTACH: 501,
    CONTACT_PLAIN: 500,
} as const;

export function useSmartResults(ctx: CommandContext, input: string): PaletteResult[] {
    // The query without its scope prefix, so `mail: alice` matches the contact Alice.
    const { suggestions } = useContactSuggestions(parseQuery(input).q);

    return useMemo(() => {
        const out: PaletteResult[] = [];
        const parsed = parseSmartInput(input);
        // The selected files go along only where the page offers to mail them; Trash, for one, does not.
        const items = ctx.selectionActions?.some(({ action }) => action.id === 'mail-to')
            ? (ctx.selection?.items ?? [])
            : [];

        // A whole email address or URL claims the Top hit.
        if (ctx.mailEnabled && parsed?.kind === 'email') {
            if (items.length > 0) {
                const title =
                    items.length === 1
                        ? `Send ${stripEigenExtension(items[0].name)} to ${parsed.value}`
                        : `Send ${items.length} files to ${parsed.value}`;
                out.push({
                    kind: 'smart',
                    id: 'smart.send-to',
                    title,
                    icon: Mail,
                    group: 'smart',
                    rank: SMART_RANKS.DETERMINISTIC,
                    deterministic: true,
                    run: (rctx) => rctx.openMailComposeWith({ to: parsed.value, attachments: items }),
                });
            } else {
                out.push({
                    kind: 'smart',
                    id: 'smart.mail-to',
                    title: `Mail to ${parsed.value}`,
                    icon: Mail,
                    group: 'smart',
                    rank: SMART_RANKS.DETERMINISTIC,
                    deterministic: true,
                    run: (rctx) => rctx.openMailComposeWith({ to: parsed.value }),
                });
            }
        } else if (parsed?.kind === 'url') {
            out.push({
                kind: 'smart',
                id: 'smart.open-link',
                title: 'Open link',
                subtitle: parsed.value,
                icon: ExternalLink,
                group: 'smart',
                rank: SMART_RANKS.DETERMINISTIC,
                deterministic: true,
                // noopener,noreferrer prevents tabnabbing.
                run: () => window.open(parsed.value, '_blank', 'noopener,noreferrer'),
            });
        }

        // The top contact adds rows under Suggestions, never the Top hit, so the contact card itself can
        // claim it. A typed address that is already the contact's has its row from above.
        const top = suggestions[0];
        if (ctx.mailEnabled && top && parsed?.value !== top.email) {
            // A mail without attachments, offered even with a selection, for a mail about something else.
            out.push({
                kind: 'smart',
                id: `smart.mail-to-contact-${top.id}`,
                title: `Send mail to ${top.email}`,
                icon: Mail,
                group: 'smart',
                rank: SMART_RANKS.CONTACT_PLAIN,
                deterministic: false,
                run: (rctx) => rctx.openMailComposeWith({ to: top.email }),
            });
            if (items.length > 0) {
                const title =
                    items.length === 1
                        ? `Send ${stripEigenExtension(items[0].name)} to ${top.email}`
                        : `Send ${items.length} files to ${top.email}`;
                out.push({
                    kind: 'smart',
                    id: `smart.send-to-contact-${top.id}`,
                    title,
                    icon: Mail,
                    group: 'smart',
                    rank: SMART_RANKS.CONTACT_WITH_ATTACH,
                    deterministic: false,
                    run: (rctx) => rctx.openMailComposeWith({ to: top.email, attachments: items }),
                });
            }
        }

        return out;
    }, [ctx, input, suggestions]);
}
