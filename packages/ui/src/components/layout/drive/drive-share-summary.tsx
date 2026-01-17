import {Unlock, UserRoundPlus} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {UserPublicAvatar} from "../user-public-avatar";
import {type DrivePath} from "@workspace/lib/types/drive";
import {Tooltip, TooltipContent, TooltipTrigger} from "@workspace/ui/components/tooltip";

export interface DriveShareSummaryProps {
    path: DrivePath;
    onClick?: () => void;
    showIconOnHover?: boolean;
}

export function DriveShareSummary({
                                      path,
                                      onClick,
                                      showIconOnHover = true,
                                  }: DriveShareSummaryProps) {
    const isShared = path.acl && path.acl.length > 0;

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
                    <UserPublicAvatar
                        email={path.ownerId}
                        size="sm"
                        className="position-relative"
                        style={{zIndex: 0}}
                    />
                    {path.acl?.slice(0, 3).map((access, index) => (
                        access.public ? (
                            <Tooltip delayDuration={300}>
                                <TooltipTrigger asChild>
                                    <span
                                        key={`public-${access.email}`}
                                        className={`-ml-4 h-6 w-6 rounded-full flex items-center justify-center bg-gray-100 position-relative`}
                                        style={{zIndex: index + 1}}
                                    >
                                        <Unlock className="h-3 w-3 text-primary"/>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>Any logged-in eigen user with the link can access</TooltipContent>
                            </Tooltip>
                        ) : (
                            <UserPublicAvatar
                                key={access.email}
                                email={access.email}
                                size="sm"
                                className={`-ml-4 position-relative`}
                                style={{zIndex: index + 1}}
                            />
                        )
                    ))}
                    {path.acl && path.acl.length > 3 && (
                        <span className="text-xs text-muted-foreground ml-1">
              +{path.acl.length - 3}
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