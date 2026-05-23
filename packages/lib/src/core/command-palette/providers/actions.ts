import type { Command, CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { useMemo } from 'react';
import { allCommands } from '../commands';
import { actionBoosts } from '../rank';

export function useActionResults(ctx: CommandContext, input: string): PaletteResult[] {
    return useMemo(() => {
        const visible = allCommands.filter((cmd: Command) => !cmd.availability || cmd.availability(ctx));
        if (input.trim().length === 0) {
            // Return the full visible list; the engine's empty-input branch filters to
            // SUGGESTED_COMMAND_IDS.
            return visible.map((cmd) => commandToResult(cmd, cmd.baseRank ?? 0));
        }
        const ranked = visible
            .map((cmd) => {
                const boost = actionBoosts(input, {
                    title: cmd.title,
                    keywords: cmd.keywords,
                });
                return { cmd, score: (cmd.baseRank ?? 0) + boost };
            })
            .filter((entry) => entry.score > 0 || matchesById(entry.cmd.id, input))
            .sort((a, b) => b.score - a.score);
        return ranked.map(({ cmd, score }) => commandToResult(cmd, score));
    }, [ctx, input]);
}

function commandToResult(cmd: Command, rank: number): PaletteResult {
    return {
        kind: 'action',
        id: cmd.id,
        title: cmd.title,
        keywords: cmd.keywords,
        shortcut: cmd.shortcut,
        icon: cmd.icon,
        group: 'actions',
        rank,
        run: cmd.run,
    };
}

// Hidden behaviour: typing a command's full id (e.g. "nav.mail") always matches.
// Cheap to add and gives us a stable test handle without leaking through the UI.
function matchesById(id: string, input: string): boolean {
    return id.toLowerCase().includes(input.trim().toLowerCase());
}
