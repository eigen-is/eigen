import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { ExternalLink, Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useContactSuggestions } from '../../contacts';
import { parseQuery } from '../parse-query';
import { parseSmartInput } from '../parse-smart-input';

// Smart-suggestion ranks. Two tiers:
//   - DETERMINISTIC (1000): unambiguous input shapes (a full email, a URL). These
//     claim the Top Hit outright.
//   - CONTACT_* (500-tier): non-deterministic contact-derived rows. They live in
//     the Suggestions section below the Top Hit. CONTACT_WITH_ATTACH ranks one
//     above CONTACT_PLAIN so users with a live Drive selection see
//     "Send <files> to <email>" first.
//
// Local to this file — smart ranks never compete with catalog baseRanks (different
// kind, different section); see commands/base-ranks.ts for the catalog tiers.
const SMART_RANKS = {
    DETERMINISTIC: 1000,
    CONTACT_WITH_ATTACH: 501,
    CONTACT_PLAIN: 500,
} as const;

export function useSmartResults(ctx: CommandContext, input: string): PaletteResult[] {
    // Same shared hook the autosuggest UIs use — picks up personal contacts AND
    // team members so typing a teammate's name also triggers the "Send mail to <email>"
    // suggestion under Top Hit. Feed it the scope-stripped query so `mail: alice`
    // matches contacts named "alice", not the literal "mail: alice".
    const { suggestions } = useContactSuggestions(parseQuery(input).q);

    return useMemo(() => {
        const out: PaletteResult[] = [];
        const parsed = parseSmartInput(input);

        // Whole-input email or URL shape — deterministic claim on Top Hit.
        if (parsed?.kind === 'email') {
            const items = ctx.selection?.items ?? [];
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

        // Top contact suggestion → derived smart rows. Non-deterministic so the contact
        // card itself still claims the Top Hit via structural match; these rows sit in
        // the Suggestions section directly under it. Skip when the typed input is
        // already the suggestion's email (the deterministic path above covers it).
        const top = suggestions[0];
        if (top && parsed?.value !== top.email) {
            // Plain compose, no attachments — always offered when a contact matches so
            // the user can send a clean mail even with a Drive selection live.
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
            // When a Drive selection is published, additionally offer the attach-aware
            // variant. Ranked above the plain row so users with a live selection see
            // "send these files" first.
            const items = ctx.selection?.items ?? [];
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
