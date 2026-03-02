"use client"

import {Tooltip, TooltipContent, TooltipTrigger,} from "@workspace/ui/components/tooltip";
import {UserAvatar, UserAvatarProps} from "./user-avatar"
import {usePublicUser} from "@workspace/lib/public"

export type UserPublicAvatarProps = Omit<UserAvatarProps, 'name' | 'imageUrl'> & {
    email?: string
    userId?: string
    className?: string
    size?: "sm" | "md" | "lg"
}

export function UserPublicAvatar({
                                     email,
                                     className,
                                     userId,
                                     size = "md",
                                     ...props
                                 }: UserPublicAvatarProps) {
    const {data} = usePublicUser(email || userId || '');

    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
                <UserAvatar
                    name={data?.name || email}
                    email={email}
                    userId={userId}
                    size={size}
                    className={className}
                    {...props}
                />
            </TooltipTrigger>
            <TooltipContent>{data?.name || email || ''}</TooltipContent>
        </Tooltip>
    );
}
