import {Link} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {UserPublicAvatar} from "../user-public-avatar";

export interface Acl {
    email: string;
    // Add other ACL properties as needed
}

export interface DriveShareSummaryProps {
    acl?: Acl[] | null;
    onClick?: () => void;
    showIconOnHover?: boolean;
}

export function DriveShareSummary({
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
                    {acl?.slice(0, 3).map((access, index) => (
                        <UserPublicAvatar
                            key={access.email}
                            email={access.email}
                            size="sm"
                            className={cn(
                                "border border-background",
                                index > 0 && "-ml-2" // Overlap avatars
                            )}
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
                        <Link className="h-4 w-4 text-muted-foreground"/>
                    </div>
                )
            )}
        </div>
    );
}