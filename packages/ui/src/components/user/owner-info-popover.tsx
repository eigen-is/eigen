import { useMyTeams } from '@workspace/lib/home';
import { useTeamMembers } from '@workspace/lib/team';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { CollapsibleUserList } from './collapsible-user-list';
import { UserItem } from './user-item';

export type OwnerInfoPopoverProps = {
    userId?: string;
    email?: string;
    name?: string;
    tooltipText?: string;
    triggerClassName?: string;
    children: ReactNode;
};

export function OwnerInfoPopover({
    userId,
    email,
    name,
    tooltipText,
    triggerClassName,
    children,
}: OwnerInfoPopoverProps) {
    const parsed = parseOwnerId(userId || email || '');
    const isTeam = parsed.type === 'team';

    const triggerButton = (
        <PopoverTrigger asChild>
            <button
                type="button"
                aria-label={isTeam ? 'Team members' : 'User info'}
                className={cn(
                    'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    triggerClassName,
                )}
            >
                {children}
            </button>
        </PopoverTrigger>
    );

    return (
        <Popover>
            {tooltipText ? (
                <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
                    <TooltipContent>{tooltipText}</TooltipContent>
                </Tooltip>
            ) : (
                triggerButton
            )}
            <PopoverContent align="start" collisionPadding={8} className="w-80 p-2">
                {isTeam ? (
                    <TeamMembersContent teamId={parsed.id} />
                ) : (
                    <UserItem userId={userId} email={email} name={name} mailLink className="px-2 py-1.5" />
                )}
            </PopoverContent>
        </Popover>
    );
}

function TeamMembersContent({ teamId }: { teamId: string }) {
    const { data: teams } = useMyTeams();
    const team = teams?.find((t) => t.id === teamId);
    const { data: members = [] } = useTeamMembers(teamId);

    return (
        <CollapsibleUserList
            title={team?.name ?? 'Team'}
            count={members.length}
            collapseThreshold={Number.POSITIVE_INFINITY}
            summaryLines={[`${members.length} ${members.length === 1 ? 'member' : 'members'}`]}
        >
            {members.map((m) => (
                <UserItem key={m.userId} userId={m.userId} name={m.name} email={m.email} />
            ))}
        </CollapsibleUserList>
    );
}
