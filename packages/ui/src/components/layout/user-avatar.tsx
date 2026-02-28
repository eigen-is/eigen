"use client"

import {HTMLAttributes} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {Avatar, AvatarImage} from "@workspace/ui/components/avatar"
import {API_HOST, getPublicAvatarUrl} from "@workspace/lib/api"

export type UserAvatarProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    className?: string
    size?: "sm" | "md" | "lg"
}

export function UserAvatar({
                               name,
                               email,
                               imageUrl,
                               userId,
                               className,
                               size = "md",
                               ...props
                           }: UserAvatarProps) {
    const displayName = (name || email || "");

    const avatarSrc = imageUrl
        ? `${API_HOST}/${imageUrl}`
        : getPublicAvatarUrl(email || userId || '');

    const sizeClasses = {
        sm: "h-6 w-6",
        md: "h-8 w-8",
        lg: "h-10 w-10"
    };

    return (
        <Avatar className={cn(sizeClasses[size], className, "print-exact")} {...props}>
            <AvatarImage src={avatarSrc} alt={displayName}/>
        </Avatar>
    );
}
