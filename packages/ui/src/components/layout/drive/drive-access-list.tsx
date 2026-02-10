"use client"
import {UserPublicItem} from "../user-item"
import type {DriveACL, DrivePath} from "@workspace/lib/types/drive"
import {cn} from "@workspace/ui/lib/utils"
import {useMemo} from "react"
import {usePublicUser} from "@workspace/lib/public"
import {Lock, Unlock, UserRoundPlus} from "lucide-react"
import {AvatarIcon} from "@workspace/ui/components/avatar"
import {Separator} from "@workspace/ui/components/separator"
import {TooltipButton} from "../tooltip-button"

export type DriveAccessListProps = {
    path: DrivePath
    className?: string
    onShareClick?: (path: DrivePath) => void
}

export function DriveAccessList({
                                    path,
                                    className,
                                    onShareClick
                                }: DriveAccessListProps) {
    const owner = usePublicUser(path.ownerId);

    // Combine owner and ACL list, ensuring owner is first and not duplicated
    // Also calculate publicAccess directly here instead of using setState
    const [accessList, publicAccess] = useMemo(() => {
        if (!owner.data) return [[], false];

        const ownerAccess = {
            email: owner.data.email || '',
            read: true,
            write: true,
            public: false,
            owner: true
        }

        const accessList = [ownerAccess];
        let hasPublicAccess = false;

        if (path.acl && path.acl.length > 0) {
            // Add only non-owner users from ACL
            path.acl.forEach((access) => {
                if (access.public) {
                    hasPublicAccess = true;
                } else if (access.email !== owner.data?.email) {
                    accessList.push({
                        email: access.email,
                        read: access.read,
                        write: access.write,
                        public: access.public,
                        owner: false
                    })
                }
            })
        }

        return [accessList, hasPublicAccess];
    }, [path, owner.data]);

    return (
        <div className={cn("space-y-4", className)}>
            <div className="flex items-center justify-between h-12 border-t border-b">
                <h3 className="text-base font-medium">People with access</h3>
                <TooltipButton
                    icon={UserRoundPlus}
                    tooltipText="Edit Access"
                    onClick={() => {
                        onShareClick?.(path);
                    }}
                />
            </div>

            <div className="space-y-2">
                {accessList.map((access) => (
                    <UserPublicItem
                        key={access.email}
                        email={access.email}
                        label={access.owner ? "Owner" : (
                            <AccessLabel access={access}/>
                        )}
                    />
                ))}
            </div>
            <Separator/>
            <div>
                <h4 className="text-sm font-medium mb-2">General access</h4>
                {!publicAccess ? (
                    <div className="flex items-center">
                        <AvatarIcon
                            className="w-10 h-10"
                        ><Lock/></AvatarIcon>
                        <div>
                            <p className="text-sm font-medium">Restricted</p>
                            <p className="text-xs text-gray-500">Only people with access can open with the link</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center">
                        <AvatarIcon
                            className="w-10 h-10"
                        ><Unlock/></AvatarIcon>
                        <div>
                            <p className="text-sm font-medium">Unrestricted</p>
                            <p className="text-xs text-gray-500">Any logged-in eigen user with the link can access</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

// Component to display the appropriate access label
function AccessLabel({access}: { access: DriveACL }) {
    if (access.write) {
        return <span>Editor</span>
    }
    if (access.read) {
        return <span>Viewer</span>
    }
    return null
}
