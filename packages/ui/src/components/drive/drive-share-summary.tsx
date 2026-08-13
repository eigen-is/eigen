import { type DriveAccessItem, useDriveAccess } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { UserAvatar } from '@workspace/ui/components/user/user-avatar';
import { cn } from '@workspace/ui/lib/utils';
import { Unlock, UserRoundPlus } from 'lucide-react';

export type DriveShareSummaryProps = {
    path: DrivePath;
    onClick?: () => void;
    showIconOnHover?: boolean;
    ancestorBreadcrumb?: DrivePath[];
    className?: string;
};

export function DriveShareSummary({
    path,
    onClick,
    showIconOnHover = true,
    ancestorBreadcrumb,
    className,
}: DriveShareSummaryProps) {
    const { allEntries } = useDriveAccess(path, undefined, ancestorBreadcrumb);

    const hasEntries = allEntries.length > 1;
    const isPublic = path.visibility !== 'private';
    const isShared = hasEntries || isPublic;

    return (
        <div
            className={cn('flex items-center gap-1', onClick && 'cursor-pointer', className)}
            onClick={
                onClick
                    ? (e) => {
                          e.stopPropagation();
                          onClick();
                      }
                    : undefined
            }
        >
            {isShared ? (
                <div className="flex items-center gap-1 -my-0.5">
                    {isPublic && (
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <span
                                    className="h-6 w-6 rounded-full flex items-center justify-center bg-muted relative"
                                    style={{ zIndex: 1 }}
                                >
                                    <Unlock className="h-3 w-3 text-primary" />
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>Any authenticated user with the link</TooltipContent>
                        </Tooltip>
                    )}
                    {allEntries.slice(0, isPublic ? 3 : 4).map((access: DriveAccessItem, index: number) => (
                        <UserAvatar
                            key={access.id}
                            email={access.id}
                            size="sm"
                            className={cn('relative', (index > 0 || isPublic) && '-ml-4')}
                            style={{ zIndex: (isPublic ? 2 : 1) + index }}
                            tooltip={true}
                        />
                    ))}
                    {allEntries.length > (isPublic ? 3 : 4) && (
                        <span className="text-xs text-muted-foreground ml-1">
                            +{allEntries.length - (isPublic ? 3 : 4)}
                        </span>
                    )}
                </div>
            ) : (
                showIconOnHover && (
                    <div className="invisible group-hover:visible pointer-coarse:visible">
                        <UserRoundPlus className="h-4 w-4 text-muted-foreground" />
                    </div>
                )
            )}
        </div>
    );
}
