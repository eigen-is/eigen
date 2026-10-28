// A comment-thread hit in the palette's IN COMMENTS section, from a search of the open document's
// comments. The label is the matched part of the thread's newest messages, and the line under it names
// who spoke last. Enter calls the document's reveal, which opens the card or scrolls to the comment.

import { useResolvedUser } from '@workspace/lib/public';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'doc-comment-hit' }>;
    onSelect: () => void;
};

export function CommandRowDocCommentHit({ result, onSelect }: Props) {
    const { payload, icon: Icon } = result;
    const { displayName: lastAuthor } = useResolvedUser({ email: payload.context });
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate text-foreground">{payload.label}</div>
                {lastAuthor && <div className="text-xs truncate text-muted-foreground mt-0.5">{lastAuthor}</div>}
            </div>
        </CommandItem>
    );
}
