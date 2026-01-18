"use client"

import {HTMLAttributes} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {Avatar, AvatarImage} from "@workspace/ui/components/avatar"
import {useAvatar} from "@workspace/lib/media"
import {AvatarDigiDoodle} from "eigen-avatar-generator/react"

export type UserAvatarProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    className?: string
    forceUseImageUrl?: boolean
    size?: "sm" | "md" | "lg"
}

export function UserAvatar({
                               name,
                               email,
                               imageUrl,
                               forceUseImageUrl,
                               userId,
                               className,
                               size = "md",
                               ...props
                           }: UserAvatarProps) {
    const displayName = (name || email || "");

    // Fetch public user data if we don't have an image URL
    const {data} = useAvatar(email || userId || '', {
        enabled: !(imageUrl || '').trim() && !forceUseImageUrl
    });

    // Determine the image to display
    const avatarImage = forceUseImageUrl ? imageUrl : (imageUrl || data?.avatar || '');

    // Size classes
    const sizeClasses = {
        sm: "h-6 w-6",
        md: "h-8 w-8",
        lg: "h-10 w-10"
    };

    return (
        <Avatar className={cn(sizeClasses[size], className, "print-exact")} {...props}>
            {avatarImage ? (
                <AvatarImage src={`${import.meta.env.VITE_API_HOST}/${avatarImage}`} alt={displayName}/>
            ) : (
                <AvatarDigiDoodle id={userId || email || ''} background="#eeeeee"/>
            )}
        </Avatar>
    );
}
