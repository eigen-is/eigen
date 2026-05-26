import { formatTimeAgo } from '@workspace/lib/date';
import { getFilePresentation } from '@workspace/lib/file-presentation';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'file' }>;
    onSelect: () => void;
};

// Two-line file row using the same getFilePresentation helper the Drive table
// and detail panes use — icon, then a humanised type label (Folder / Documents /
// image/png / …) plus relative recency. Keeps the palette visually in sync with
// the rest of the Drive UI: same icon for the same mime, same label.
export function CommandRowFile({ result, onSelect }: Props) {
    const { payload, icon: Icon, title } = result;
    const presentation = getFilePresentation(payload.mimeType, payload.type);
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {presentation.label} · {formatTimeAgo(payload.updatedAt)}
                </div>
            </div>
        </CommandItem>
    );
}
