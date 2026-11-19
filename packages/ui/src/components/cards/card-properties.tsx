// The row under a card's text in its dialog: its color, its assignee and, on a card that has its thread, the button
// that resolves or reopens it. The dialog that adds a card holds the first two until Add, and an open card applies each
// at once. A reader sees the assignee and whether the card is resolved, without the controls.

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
                <Button type="button" variant="outline" size="sm" className="max-w-48 font-normal">
                    {assignee ? (
                        <AssigneeChip email={assignee} />
                    ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                    )}
                </Button>
            </AssigneePicker>
        );
    }

    return (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            {onColorChange && (
                <Property label="Color">
                    <ColorPicker
                        value={color}
                        onChange={onColorChange}
                        colors={EIGEN_STICKIES_COLORS}
                        columns={EIGEN_STICKIES_COLORS[0].length}
                        showReset={false}
                    />
                </Property>
            )}
            {assigneeControl && <Property label="Assignee">{assigneeControl}</Property>}
            {status && onStatusChange && (
                <Property label="Status">
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
                </Property>
            )}
            {resolved && !onStatusChange && (
                <Property label="Status">
                    <span className="flex h-8 items-center gap-1.5 text-sm">
                        <Check className="h-4 w-4" />
                        Resolved
                    </span>
                </Property>
            )}
        </div>
    );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}
