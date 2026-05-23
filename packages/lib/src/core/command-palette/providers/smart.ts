import type { CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { ExternalLink, Mail } from 'lucide-react';
import { useMemo } from 'react';
import { parseSmartInput } from '../parse-smart-input';

export function useSmartResults(ctx: CommandContext, input: string): PaletteResult[] {
    return useMemo(() => {
        const parsed = parseSmartInput(input);
        if (!parsed) return [];

        if (parsed.kind === 'email') {
            const items = ctx.selection?.items ?? [];
            if (items.length > 0) {
                const title =
                    items.length === 1
                        ? `Send ${items[0].name} to ${parsed.value}`
                        : `Send ${items.length} files to ${parsed.value}`;
                return [
                    {
                        kind: 'smart',
                        id: 'smart.send-to',
                        title,
                        icon: Mail,
                        group: 'top-hit',
                        rank: 1000,
                        deterministic: true,
                        run: (rctx) => rctx.openMailComposeWith({ to: parsed.value, attachments: items }),
                    },
                ];
            }
            return [
                {
                    kind: 'smart',
                    id: 'smart.mail-to',
                    title: `Mail to ${parsed.value}`,
                    icon: Mail,
                    group: 'top-hit',
                    rank: 1000,
                    deterministic: true,
                    run: (rctx) => rctx.openMailComposeWith({ to: parsed.value }),
                },
            ];
        }

        // URL — opens in a new tab. `noopener,noreferrer` prevents tabnabbing.
        return [
            {
                kind: 'smart',
                id: 'smart.open-link',
                title: 'Open link',
                subtitle: parsed.value,
                icon: ExternalLink,
                group: 'top-hit',
                rank: 1000,
                deterministic: true,
                run: () => window.open(parsed.value, '_blank', 'noopener,noreferrer'),
            },
        ];
    }, [ctx, input]);
}
