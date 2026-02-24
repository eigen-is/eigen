import {UserPublicAvatar} from "@workspace/ui/components/layout/user-public-avatar";
import type {DriveACL} from "@workspace/lib/types/drive";

type RoomMembersProps = {
    ownerId: string;
    acl: DriveACL[] | null;
}

export function RoomMembers({ownerId, acl}: RoomMembersProps) {
    const members = acl?.filter(a => !a.public) || [];

    return (
        <div className="flex items-center">
            <UserPublicAvatar
                email={ownerId}
                size="sm"
                style={{zIndex: 0}}
            />
            {members.slice(0, 3).map((access, index) => (
                <UserPublicAvatar
                    key={access.email}
                    email={access.email}
                    size="sm"
                    className="-ml-2"
                    style={{zIndex: index + 1}}
                />
            ))}
            {members.length > 3 && (
                <span className="text-xs text-muted-foreground ml-1">
                    +{members.length - 3}
                </span>
            )}
        </div>
    );
}
