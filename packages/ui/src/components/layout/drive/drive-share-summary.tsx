import {UserRoundPlus} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {UserPublicAvatar} from "../user-public-avatar";
import {type DriveACL, type DrivePath} from "@apps/api-server/types/drive";

export interface DriveShareSummaryProps {
    path: DrivePath;
    acl?: DriveACL[] | null;
    onClick?: () => void;
    showIconOnHover?: boolean;
}

export function DriveShareSummary({
    path,
    acl,
    onClick,
    showIconOnHover = true,
}: DriveShareSummaryProps) {
    const isShared = acl && acl.length > 0;

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
                    />
                    {acl?.slice(0, 3).map((access) => (
                        <UserPublicAvatar
                            email={access.email}
                            size="sm"
                            className="-ml-4"
                        />
                    ))}
                    {acl && acl.length > 3 && (
                        <span className="text-xs text-muted-foreground ml-1">
              +{acl.length - 3}
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