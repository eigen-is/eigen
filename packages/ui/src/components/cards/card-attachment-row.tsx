// The row of a card's attachments in its dialog: the button that adds one, which says so in words while the card has
// none, and the chips beside it. Both card dialogs draw it, the one that adds a card with the files it holds until Add
// and an open card with its own.

import { Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../button';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type CardAttachmentRowProps = {
    // Absent where nobody may attach, such as for a reader.
    onAdd?: () => void;
    hasAttachments: boolean;
    children?: ReactNode;
};

export function CardAttachmentRow({ onAdd, hasAttachments, children }: CardAttachmentRowProps) {
    if (!onAdd && !hasAttachments) return null;
    return (
        <div className="flex min-w-0 items-center gap-2">
            {onAdd &&
                (hasAttachments ? (
                    <TooltipButton icon={Paperclip} tooltipText="Add attachment" className="shrink-0" onClick={onAdd} />
                ) : (
                    <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onAdd}>
                        <Paperclip />
                        Add attachment
                    </Button>
                ))}
            {children}
        </div>
    );
}
