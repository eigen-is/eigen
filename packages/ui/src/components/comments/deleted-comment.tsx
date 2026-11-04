// How a deleted comment shows wherever a card is reached, such as the pane and the card dialog: its title grayed and
// one line that says it was deleted. A comment is deleted when its thread is gone or its document no longer uses the
// card. Nothing here acts, so nobody replies to, resolves, assigns or edits a comment that is gone.

import { cn } from '../../lib/utils';

export function DeletedComment({ title, className }: { title: string; className?: string }) {
    return (
        <div className={cn('text-sm text-muted-foreground', className)}>
            <p className="line-clamp-2">{title}</p>
            <p className="mt-1 text-xs">This comment was deleted</p>
        </div>
    );
}
