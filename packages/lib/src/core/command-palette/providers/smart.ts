import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { ExternalLink, Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useContactSuggestions } from '../../contacts';
import { parseSmartInput } from '../parse-smart-input';

export function useSmartResults(ctx: CommandContext, input: string): PaletteResult[] {
    // Same shared hook the autosuggest UIs use — picks up personal contacts AND
    // team members so typing a teammate's name also triggers the "Send mail to <email>"
    // suggestion under Top Hit.
    const { suggestions } = useContactSuggestions(input);

    return useMemo(() => {
        const out: PaletteResult[] = [];
        const parsed = parseSmartInput(input);

        // Whole-input email or URL shape — deterministic claim on Top Hit.
        if (parsed?.kind === 'email') {
            const items = ctx.selection?.items ?? [];
            if (items.length > 0) {
                const title =
                    items.length === 1
                        ? `Send ${items[0].name} to ${parsed.value}`
                        : `Send ${items.length} files to ${parsed.value}`;
                out.push({
                    kind: 'smart',
                    id: 'smart.send-to',
                    title,
                    icon: Mail,
                    group: 'smart',
                    rank: 1000,
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
                    rank: 1000,
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
                rank: 1000,
                deterministic: true,
                // noopener,noreferrer prevents tabnabbing.
                run: () => window.open(parsed.value, '_blank', 'noopener,noreferrer'),
            });
        }

        // Top contact suggestion → derived "Send mail to <email>" row. Non-deterministic
        // so the contact card itself still claims the Top Hit via structural match; this
        // row sits in the Suggestions section directly under it. Skip when the typed
        // input is already the suggestion's email (the deterministic path covers it).
        // No subtitle — the title already contains the email, the name was redundant.
        const top = suggestions[0];
        if (top && parsed?.value !== top.email) {
            out.push({
                kind: 'smart',
                id: `smart.mail-to-contact-${top.id}`,
                title: `Send mail to ${top.email}`,
                icon: Mail,
                group: 'smart',
                rank: 500,
                deterministic: false,
                run: (rctx) => rctx.openMailComposeWith({ to: top.email }),
            });
        }

        return out;
    }, [ctx, input, suggestions]);
}
