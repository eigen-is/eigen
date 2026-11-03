// A small summary of who can open a Drive item, for a place such as a Drive row's Shared column or a chat's toolbar.
// It shows a lock when anyone signed in with the link may open the item, then the first few people's avatars and a
// count of the rest. An item nobody else has shows an add-person icon on hover, where the caller asks for one. When
// the caller passes onClick, the summary is a button that opens Share, so the keyboard reaches it. A caller whose
// keyboard reaches Share another way, such as a list row's menu key, takes the button out of the Tab order.

import { useDriveAccess } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { UserAvatar } from '@workspace/ui/components/user/user-avatar';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { Unlock, UserRoundPlus } from 'lucide-react';

export type DriveShareSummaryProps = {
    path: DrivePath;
    onClick?: () => void;
    showIconOnHover?: boolean;
    ancestorBreadcrumb?: DrivePath[];
    // The button's tabIndex, such as -1 to take it out of the Tab order.
    tabIndex?: number;
};

export function DriveShareSummary({
    path,
    onClick,
    showIconOnHover = true,
    ancestorBreadcrumb,
    tabIndex,
}: DriveShareSummaryProps) {
    const { allEntries } = useDriveAccess(path, undefined, ancestorBreadcrumb);

    const isPublic = path.visibility !== 'private';
    const isShared = allEntries.length > 1 || isPublic;
    const avatarCount = isPublic ? 3 : 4;

    // Spans, since the summary may sit in a button. Each avatar overlaps the one before it, and a later sibling paints
    // on top, so the overlap needs no z-index.
    const summary = isShared ? (
        <span className="flex items-center gap-1 -my-0.5">
            {isPublic && (
                <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                        <span className="h-6 w-6 rounded-full flex items-center justify-center bg-muted">
                            <Unlock className="h-3 w-3 text-primary" />
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>Anyone signed in with the link</TooltipContent>
                </Tooltip>
            )}
            {allEntries.slice(0, avatarCount).map((access, index) => (
                <UserAvatar
                    key={access.id}
                    email={access.id}
                    size="sm"
                    className={cn((index > 0 || isPublic) && '-ml-4')}
                    tooltip
                />
            ))}
            {allEntries.length > avatarCount && (
                <span className="text-xs text-muted-foreground ml-1">+{allEntries.length - avatarCount}</span>
            )}
        </span>
    ) : (
        showIconOnHover && (
            <span className={HOVER_REVEAL_CLASS}>
                <UserRoundPlus className="h-4 w-4 text-muted-foreground" />
            </span>
        )
    );

    // With nothing to show there is nothing to click, so the keyboard skips it too.
    if (!onClick || !summary) return <div className="flex items-center gap-1">{summary}</div>;

    return (
        <button
            type="button"
            aria-label="Share"
            tabIndex={tabIndex}
            className="flex items-center gap-1 cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
        >
            {summary}
        </button>
    );
}
