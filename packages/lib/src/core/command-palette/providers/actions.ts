import type { Command, CommandContext, PaletteResult, ResultGroup } from '@workspace/lib/types/command-palette';
import { useMemo } from 'react';
import { allCommands } from '../commands';
import { actionBoosts } from '../rank';

export function useActionResults(ctx: CommandContext, input: string): PaletteResult[] {
    return useMemo(() => {
        const visible = allCommands.filter((cmd: Command) => !cmd.availability || cmd.availability(ctx));
        if (input.trim().length === 0) {
            // Return every visible command. The engine routes selection-group ones to
            // the "Selection" section (always shown when a selection is present) and
            // catalog ones to "Suggested" via SUGGESTED_COMMAND_IDS.
            return visible.map((cmd) => commandToResult(cmd, ctx, cmd.baseRank ?? 0));
        }
        const ranked = visible
            .map((cmd) => {
                const title = cmd.dynamicTitle ? cmd.dynamicTitle(ctx) : cmd.title;
                const boost = actionBoosts(input, { title, keywords: cmd.keywords });
                return { cmd, title, score: (cmd.baseRank ?? 0) + boost };
            })
            .filter((entry) => entry.score > 0 || matchesById(entry.cmd.id, input))
            .sort((a, b) => b.score - a.score);
        return ranked.map(({ cmd, title, score }) => commandToResult(cmd, ctx, score, title));
    }, [ctx, input]);
}

function commandToResult(cmd: Command, ctx: CommandContext, rank: number, title?: string): PaletteResult {
    const group: ResultGroup = cmd.group === 'selection' ? 'selection' : 'actions';
    return {
        kind: 'action',
        id: cmd.id,
        title: title ?? (cmd.dynamicTitle ? cmd.dynamicTitle(ctx) : cmd.title),
        icon: cmd.icon,
        group,
        rank,
        run: cmd.run,
    };
}

// Hidden behaviour: typing a command's full id (e.g. "nav.mail") always matches.
// Cheap to add and gives us a stable test handle without leaking through the UI.
function matchesById(id: string, input: string): boolean {
    return id.toLowerCase().includes(input.trim().toLowerCase());
}
