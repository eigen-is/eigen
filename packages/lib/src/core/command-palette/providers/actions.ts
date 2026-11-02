// The palette's command source: the static catalog, such as Go to and New, plus the Selection commands
// built from the rows a page published. With an empty query it hands the engine every available
// command; with text, only those whose title or keywords match, ranked by base rank plus match boost.

import type { Command, CommandContext, PaletteResult } from '@workspace/lib/types/command-palette';
import { useMemo } from 'react';
import { allCommands } from '../commands';
import { selectionCommands } from '../commands/selection';
import { actionBoosts } from '../rank';

export function useActionResults(ctx: CommandContext, input: string): PaletteResult[] {
    return useMemo(() => {
        const visible = [...allCommands, ...selectionCommands(ctx)].filter(
            (cmd) => !cmd.availability || cmd.availability(ctx),
        );
        if (input.trim().length === 0) {
            // The engine routes selection commands to the "Selection" section, always shown when a
            // selection is present, and catalog ones to "Suggested" through SUGGESTED_COMMAND_IDS.
            return visible.map((cmd) => commandToResult(cmd, cmd.baseRank ?? 0));
        }
        return (
            visible
                .map((cmd) => {
                    const boost = actionBoosts(input, cmd);
                    return { cmd, boost, score: (cmd.baseRank ?? 0) + boost };
                })
                // Gate on the boost: every command has a positive base rank, so a gate on the score
                // would admit every visible command for any query. The base rank only breaks ties.
                .filter((entry) => entry.boost > 0)
                .sort((a, b) => b.score - a.score)
                .map(({ cmd, score }) => commandToResult(cmd, score))
        );
    }, [ctx, input]);
}

function commandToResult(cmd: Command, rank: number): PaletteResult {
    return {
        kind: 'action',
        id: cmd.id,
        title: cmd.title,
        subtitle: cmd.subtitle,
        icon: cmd.icon,
        group: cmd.group === 'selection' ? 'selection' : 'actions',
        rank,
        run: cmd.run,
    };
}
