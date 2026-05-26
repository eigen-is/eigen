import { formatTimeAgo } from '@workspace/lib/date';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'file' }>;
    onSelect: () => void;
};

// Two-line file row: icon + display name on top, type/recency hint below. Same
// density as the action and contact rows — single-line entries grow a subtle
// secondary line only when there's something useful to say (here: when the file
// was last touched).
export function CommandRowFile({ result, onSelect }: Props) {
    const { payload, icon: Icon, title } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {payload.type === 'folder' ? 'Folder' : payload.type} · {formatTimeAgo(payload.updatedAt)}
                </div>
            </div>
        </CommandItem>
    );
}
