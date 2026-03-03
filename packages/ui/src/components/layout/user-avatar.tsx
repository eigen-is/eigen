"use client"

import {HTMLAttributes} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {Avatar, AvatarImage} from "../avatar"
import {API_HOST, getPublicAvatarUrl} from "@workspace/lib/api"
import {useContacts} from "@workspace/lib/contacts";
import {usePublicUser} from "@workspace/lib/public"
import {Tooltip, TooltipContent, TooltipTrigger} from "../tooltip.tsx";
import {parseOwnerId} from "@workspace/lib/types";

export type UserAvatarProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    className?: string
    size?: "sm" | "md" | "lg"
    tooltip?: boolean
}

export function UserAvatar({
                               name,
                               email,
                               imageUrl,
                               userId,
                               className,
                               size = "md",
                               tooltip = false,
                               ...props
                           }: UserAvatarProps) {
    const {data: dataContacts, isLoading: isLoadingContacts} = useContacts();
    const {data: dataPublic, isLoading: isLoadingPublic} = usePublicUser(userId || email || '');
    const parsed = parseOwnerId(userId || email || '');

    const contact = !isLoadingContacts && email && dataContacts ? dataContacts.find(c => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl || (contact?.avatar) || (publicUser?.avatar) || null;
    const displayName = (parsed.type === 'team' ? 'Team' : '') || (contact && `${contact.firstName} ${contact.lastName}`.trim()) || (publicUser && publicUser.name?.trim()) || name || email || "";
    const avatarSrc = url
        ? `${API_HOST}/${url}`
        : getPublicAvatarUrl(userId || email || '');

    const sizeClasses = {
        sm: "h-6 w-6",
        md: "h-8 w-8",
        lg: "h-10 w-10"
    };

    return (
        tooltip ?
            <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                    <Avatar className={cn(sizeClasses[size], className, "print-exact select-none")} {...props}>
                        <AvatarImage src={avatarSrc} alt={displayName}/>
                    </Avatar>
                </TooltipTrigger>
                <TooltipContent>{displayName}</TooltipContent>
            </Tooltip>
            :
            <Avatar className={cn(sizeClasses[size], className, "print-exact select-none")} {...props}>
                <AvatarImage src={avatarSrc} alt={displayName}/>
            </Avatar>

    );
}
