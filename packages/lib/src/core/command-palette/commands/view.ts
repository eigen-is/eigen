import type { Command } from '@workspace/lib/types/command-palette';
import { Sun } from 'lucide-react';

export const viewCommands: Command[] = [
    {
        id: 'view.toggle-theme',
        title: 'Toggle theme',
        keywords: ['dark', 'light'],
        icon: Sun,
        baseRank: 4,
        run: (ctx) => ctx.toggleTheme(),
    },
];
