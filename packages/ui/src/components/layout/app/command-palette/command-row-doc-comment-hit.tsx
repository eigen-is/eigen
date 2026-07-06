import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'doc-comment-hit' }>;
    onSelect: () => void;
};

// A comment-thread hit from the open document's comments.db. `label` is an FTS snippet of the
// matched message tail; `context` is who last spoke in the thread. Enter calls the capability's
// reveal (stickies open the card; docs scroll to the comment anchor + open the panel).
export function CommandRowDocCommentHit({ result, onSelect }: Props) {
    const { payload, icon: Icon } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate text-foreground">{payload.label}</div>
                {payload.context && (
                    <div className="text-xs truncate text-muted-foreground mt-0.5">{payload.context}</div>
                )}
            </div>
        </CommandItem>
    );
}
