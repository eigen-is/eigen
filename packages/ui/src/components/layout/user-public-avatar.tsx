"use client"

import {Tooltip, TooltipContent, TooltipTrigger,} from "@workspace/ui/components/tooltip";
import {UserAvatar, UserAvatarProps} from "./user-avatar"
import {useAvatar} from "@workspace/lib/media"

export type UserPublicAvatarProps = Omit<UserAvatarProps, 'name' | 'imageUrl'> & {
    email: string
    className?: string
    size?: "sm" | "md" | "lg"
}

export function UserPublicAvatar({
                                     email,
                                     className,
                                     size = "md",
                                     ...props
                                 }: UserPublicAvatarProps) {
    // Fetch user data based on email
    const {data} = useAvatar(email || '', {enabled: true});

    // Once data is loaded, render UserAvatar with the fetched data
    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
                <UserAvatar
                    name={data?.name || email}
                    email={data?.email || email}
                    imageUrl={data?.avatar}
                    forceUseImageUrl
                    size={size}
                    className={className}
                    {...props}
                />
            </TooltipTrigger>
            <TooltipContent>{data?.name || email}</TooltipContent>
        </Tooltip>
    );
}
