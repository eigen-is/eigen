import type { Command } from '@workspace/lib/types/command-palette';
import { Mail } from 'lucide-react';

export const driveCommands: Command[] = [
    {
        id: 'drive.mail-to',
        title: 'Mail to…',
        keywords: ['send', 'attach', 'compose'],
        icon: Mail,
        baseRank: 15,
        availability: (ctx) => (ctx.selection?.items.length ?? 0) > 0,
        run: (ctx) => {
            if (!ctx.selection || ctx.selection.items.length === 0) return;
            ctx.openMailComposeWith({ attachments: ctx.selection.items });
        },
    },
];
