import {Unlock, UserRoundPlus} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {type DrivePath} from "@workspace/lib/types/drive";
import {Tooltip, TooltipContent, TooltipTrigger} from "@workspace/ui/components/tooltip";
import {type DriveAccessItem, useDriveAccess} from "@workspace/lib/drive";
import {UserAvatar} from "@workspace/ui/components/layout/user-avatar";

export type DriveShareSummaryProps = {
    path: DrivePath;
    onClick?: () => void;
    showIconOnHover?: boolean;
}

export function DriveShareSummary({
                                      path,
                                      onClick,
                                      showIconOnHover = true,
                                  }: DriveShareSummaryProps) {
    const {allEntries} = useDriveAccess(path);

    const hasEntries = allEntries.length > 1;
    const isPublic = path.visibility !== 'private';
    const isShared = hasEntries || isPublic;

    return (
        <div
            className={cn(
                "flex items-center gap-1 cursor-pointer",
            )}
            onClick={(e) => {
                e.stopPropagation();
                onClick?.();
            }}
        >
            {isShared ? (
                <div className="flex items-center gap-1">
                    {isPublic && (
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <span
                                    className="-ml-4 h-6 w-6 rounded-full flex items-center justify-center bg-gray-100 position-relative"
                                    style={{zIndex: 1}}
                                >
                                    <Unlock className="h-3 w-3 text-primary"/>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>Anyone with the link can access</TooltipContent>
                        </Tooltip>
                    )}
                    {allEntries.slice(0, isPublic ? 3 : 4).map((access: DriveAccessItem, index: number) =>
                        <UserAvatar
                            key={access.id}
                            email={access.id}
                            size="sm"
                            className="-ml-4 position-relative"
                            style={{zIndex: (isPublic ? 2 : 1) + index}}
                            tooltip={true}
                        />
                    )}
                    {allEntries.length > (isPublic ? 3 : 4) && (
                        <span className="text-xs text-muted-foreground ml-1">
                            +{allEntries.length - (isPublic ? 3 : 4)}
                        </span>
                    )}
                </div>
            ) : (
                showIconOnHover && (
                    <div className="invisible group-hover:visible">
                        <UserRoundPlus className="h-4 w-4 text-muted-foreground"/>
                    </div>
                )
            )}
        </div>
    );
}