import type { Command } from '@workspace/lib/types/command-palette';
import { Sun } from 'lucide-react';
import { BASE_RANKS } from './base-ranks';

export const viewCommands: Command[] = [
    {
        id: 'view.toggle-theme',
        title: 'Toggle theme',
        keywords: ['dark', 'light'],
        icon: Sun,
        baseRank: BASE_RANKS.VIEW_UTILITY,
        run: (ctx) => ctx.toggleTheme(),
    },
];
