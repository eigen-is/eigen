import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useMemo, useRef } from 'react';
import { useScrollToIndex } from '../../hooks/use-scroll-to-index';

type CommandHelp = {
    cmd: string;
    desc: string;
};

type ChatSlashSuggestProps = {
    query: string;
    commandsHelp: CommandHelp[];
    onSelect: (command: string) => void;
    visible: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, commands: string[]) => void;
};

export function ChatSlashSuggest({
    query,
    commandsHelp,
    onSelect,
    visible,
    selectedIndex,
    onItemsChange,
}: ChatSlashSuggestProps) {
    const listRef = useRef<HTMLUListElement>(null);
    useScrollToIndex(listRef, selectedIndex);

    const items = useMemo(() => {
        if (!visible || !query) return [];

        const q = query.toLowerCase();
        const seen = new Set<string>();
        const results: { cmd: string; desc: string }[] = [];

        for (const help of commandsHelp) {
            const primaryCmd = help.cmd.split(',')[0].split(' ')[0].trim();
            const allCmds = help.cmd.split(',').map((c) => c.trim().split(' ')[0]);

            if (allCmds.some((c) => c.toLowerCase().startsWith(q))) {
                if (!seen.has(primaryCmd)) {
                    seen.add(primaryCmd);
                    results.push({ cmd: help.cmd, desc: help.desc });
                }
            }
        }

        return results;
    }, [visible, query, commandsHelp]);

    const cmds = useMemo(() => items.map((i) => i.cmd.split(',')[0].split(' ')[0].trim()), [items]);

    useEffect(() => {
        onItemsChange(items.length, cmds);
    }, [items.length, cmds, onItemsChange]);

    if (items.length === 0) return null;

    return (
        <ul
            ref={listRef}
            className="absolute bottom-full left-0 right-0 z-10 bg-background border rounded-md shadow-lg overflow-y-auto max-h-48 mb-1"
        >
            {items.map((item, index) => (
                <li
                    key={item.cmd}
                    className={cn('px-3 py-2 eigen-list-item', index === selectedIndex && 'eigen-list-item-active')}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect(cmds[index]);
                    }}
                >
                    <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs font-medium">{item.cmd}</span>
                        <span className="text-xs text-muted-foreground truncate">{item.desc}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}
