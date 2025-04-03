"use client"

import {HTMLAttributes} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {Avatar, AvatarFallback, AvatarImage} from "@workspace/ui/components/avatar"
import {useAvatarUrl} from "@workspace/lib/media"

export interface UserAvatarProps extends HTMLAttributes<HTMLDivElement> {
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
    const firstChar = displayName.trim().charAt(0).toUpperCase();

    // Fetch public user data if we don't have an image URL
    const {getAvatarUrl} = useAvatarUrl(email || userId || '', {
        enabled: !(imageUrl || '').trim() && !forceUseImageUrl
    });

    // Determine the image to display
    const avatarImage = forceUseImageUrl ? imageUrl : (imageUrl || getAvatarUrl() || '');

    // Size classes
    const sizeClasses = {
        sm: "h-6 w-6",
        md: "h-8 w-8",
        lg: "h-10 w-10"
    };

    return (
        <Avatar className={cn(sizeClasses[size], className)} {...props}>
            {avatarImage ? (
                <AvatarImage src={`${import.meta.env.VITE_API_HOST}/${avatarImage}`} alt={displayName}/>
            ) : (
                <div className="bg-gray-200 text-gray-600 font-medium  h-full w-full">
                    <AvatarFallback>{firstChar}</AvatarFallback>
                </div>
            )}
        </Avatar>
    );
}
