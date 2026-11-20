// The icon buttons that act on an opened sticky or comment card, such as Copy link, Edit and Resolve. A host puts
// them in its top bar, such as the card dialog's. Each one shows only when its handler is given.

import { copyToClipboard } from '@workspace/lib/clipboard';
import type { LucideIcon } from 'lucide-react';
import { Link as LinkIcon, Pencil } from 'lucide-react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type NoteCardActionsProps = {
    copyLinkUrl?: string;
    onEdit?: () => void;
    // The card's own action, such as Resolve or Reopen.
    actionIcon?: LucideIcon;
    actionTooltip?: string;
    onAction?: () => void;
};

export function NoteCardActions({ copyLinkUrl, onEdit, actionIcon, actionTooltip, onAction }: NoteCardActionsProps) {
    return (
        <div className="flex items-center gap-1">
            {copyLinkUrl && (
                <TooltipButton
                    icon={LinkIcon}
                    tooltipText="Copy link"
                    onClick={() => copyToClipboard(copyLinkUrl, 'Link copied to clipboard')}
                />
            )}
            {onEdit && <TooltipButton icon={Pencil} tooltipText="Edit" onClick={onEdit} />}
            {actionIcon && actionTooltip && onAction && (
                <TooltipButton icon={actionIcon} tooltipText={actionTooltip} onClick={onAction} />
            )}
        </div>
    );
}
