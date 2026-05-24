import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { ExternalLink, Mail } from 'lucide-react';
import { useMemo } from 'react';
import { useContacts } from '../../contacts/hooks/use-contacts';
import { parseSmartInput } from '../parse-smart-input';

export function useSmartResults(ctx: CommandContext, input: string): PaletteResult[] {
    const { data: contacts } = useContacts();

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

        // Contact name match → derived "Send mail to <email>". Not deterministic — the
        // contact card itself still claims the Top Hit via structural match; this row
        // sits in the Suggestions section directly under it so the user has both
        // options at the top: open the contact, or jump straight to compose.
        const needle = input.trim().toLowerCase();
        if (needle.length > 0 && contacts) {
            const matched = contacts.find((c) => {
                const name = `${c.firstName} ${c.lastName}`.trim().toLowerCase();
                return name.includes(needle) && c.email[0];
            });
            const email = matched?.email[0];
            // Skip when the input itself is the email — parseSmartInput already covered that path.
            if (matched && email && parsed?.value !== email) {
                out.push({
                    kind: 'smart',
                    id: `smart.mail-to-contact-${matched.id}`,
                    title: `Send mail to ${email}`,
                    subtitle: `${matched.firstName} ${matched.lastName}`.trim(),
                    icon: Mail,
                    group: 'smart',
                    rank: 500,
                    deterministic: false,
                    run: (rctx) => rctx.openMailComposeWith({ to: email }),
                });
            }
        }

        return out;
    }, [ctx, input, contacts]);
}
