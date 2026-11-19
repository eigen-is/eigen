// The row along the bottom of a card's column in its dialog: its color, its assignee and, on a card that has its
// thread, the button that resolves or reopens it. The dialog that adds a card holds the first two until Add, and an open
// card applies each at once. A reader sees the assignee and whether the card is resolved, without the controls.

import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../button';
import { AssigneeChip } from '../comments/assignee-chip';
import { AssigneePicker } from '../comments/assignee-picker';
import { ColorPicker } from '../media/color-picker';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

type CardPropertiesProps = {
    // Buttons for the whole card at the start of the right-hand group, such as an open card's delete.
    actions?: ReactNode;
    color: string;
    onColorChange?: (color: string) => void;
    assignee: string | null;
    onAssigneeChange?: (email: string | null) => void;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    status?: CommentEntry['status'];
    onStatusChange?: (status: CommentEntry['status']) => void;
};

export function CardProperties({
    actions,
    color,
    onColorChange,
    assignee,
    onAssigneeChange,
    members,
    currentUserEmail,
    status,
    onStatusChange,
}: CardPropertiesProps) {
    const resolved = status === 'resolved';
    let assigneeControl: ReactNode = assignee && <AssigneeChip email={assignee} />;
    if (onAssigneeChange && members && currentUserEmail) {
        assigneeControl = (
            <AssigneePicker
                value={assignee}
                onChange={onAssigneeChange}
                members={members}
                currentUserEmail={currentUserEmail}
            >
                {/* Named Assignee, as the row has no labels and an avatar alone could be anyone. */}
                <TooltipTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="max-w-48 font-normal">
                        {assignee ? (
                            <AssigneeChip email={assignee} />
                        ) : (
                            <span className="text-muted-foreground">Unassigned</span>
                        )}
                    </Button>
                </TooltipTrigger>
            </AssigneePicker>
        );
    }

    let statusControl: ReactNode = null;
    if (status && onStatusChange) {
        statusControl = (
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant={resolved ? 'default' : 'outline'}
                        size="sm"
                        aria-pressed={resolved}
                        onClick={() => onStatusChange(resolved ? 'open' : 'resolved')}
                    >
                        <Check />
                        {resolved ? 'Resolved' : 'Resolve'}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{resolved ? 'Reopen' : 'Resolve'}</TooltipContent>
            </Tooltip>
        );
    } else if (resolved) {
        statusControl = (
            <span className="flex h-8 items-center gap-1.5 text-sm">
                <Check className="h-4 w-4" />
                Resolved
            </span>
        );
    }

    // A reader of an open, unassigned card has nothing here, and the bar around it hides.
    if (!actions && !onColorChange && !assigneeControl && !statusControl) return null;
    return (
        <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2">
            {onColorChange && (
                <div role="group" aria-label="Color">
                    <ColorPicker
                        value={color}
                        onChange={onColorChange}
                        colors={EIGEN_STICKIES_COLORS}
                        columns={EIGEN_STICKIES_COLORS[0].length}
                        showReset={false}
                    />
                </div>
            )}
            <div className="ml-auto flex items-center gap-2">
                {actions}
                {assigneeControl && (
                    <Tooltip>
                        <div role="group" aria-label="Assignee">
                            {assigneeControl}
                        </div>
                        {onAssigneeChange && <TooltipContent>Assignee</TooltipContent>}
                    </Tooltip>
                )}
                {statusControl && (
                    <div role="group" aria-label="Status">
                        {statusControl}
                    </div>
                )}
            </div>
        </div>
    );
}
