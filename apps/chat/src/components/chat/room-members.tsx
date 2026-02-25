import {UserPublicAvatar} from "@workspace/ui/components/layout/user-public-avatar";
import type {DriveACL} from "@workspace/lib/types/drive";

type RoomMembersProps = {
    ownerId: string;
    acl: DriveACL[] | null;
    onClick?: () => void;
}

export function RoomMembers({ownerId, acl, onClick}: RoomMembersProps) {
    const members = acl || [];

    return (
        <button onClick={onClick} className="flex items-center cursor-pointer hover:opacity-80 transition-opacity">
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
        </button>
    );
}
