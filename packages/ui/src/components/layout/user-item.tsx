"use client"

import {HTMLAttributes, ReactNode} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {usePublicUser} from "@workspace/lib/public"
import {API_HOST, getMailComposeUrl, getPublicAvatarUrl} from "@workspace/lib/api"
import {EigenLoader} from "./eigen-loader"
import {useContacts} from "@workspace/lib/contacts";
import {Avatar, AvatarImage} from "../avatar.tsx";

export type UserItemProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    label?: ReactNode
    className?: string
    mailLink?: boolean
    autoFetch?: boolean
}

export function UserItem({
                             name,
                             email,
                             imageUrl,
                             userId,
                             label,
                             className,
                             mailLink = false,
                             autoFetch = false,
                             ...props
                         }: UserItemProps) {
    const {data: dataContacts, isLoading: isLoadingContacts} = useContacts();
    const {data: dataPublic, isLoading: isLoadingPublic} = usePublicUser(userId || email || '');

    const contact = !isLoadingContacts && email && dataContacts ? dataContacts.find(c => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl || (contact?.avatar) || (publicUser?.avatar) || null;
    const displayName = (contact && `${contact.firstName} ${contact.lastName}`.trim()) || (publicUser && publicUser.name?.trim()) || name || email || "";
    const resolvedEmail = publicUser?.email || email || "";
    const avatarSrc = url
        ? `${API_HOST}/${url}`
        : getPublicAvatarUrl(userId || email || '');

    if (isLoadingPublic || isLoadingContacts) return <EigenLoader/>;

    return (
        <div className={cn("flex items-center", className)} {...props}>
            <Avatar className={cn(className, "h-8 w-8 print-exact select-none")} {...props}>
                <AvatarImage src={avatarSrc} alt={displayName}/>
            </Avatar>

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                <div className="flex justify-between items-center gap-2">
                    {resolvedEmail && (resolvedEmail !== displayName || mailLink) &&
                        <p className="text-xs text-gray-500">{mailLink ? <a className="hover:underline"
                                                                            href={getMailComposeUrl(resolvedEmail)}>{resolvedEmail}</a> : resolvedEmail}</p>}
                    {label && (
                        <p className="text-xs text-gray-500 whitespace-nowrap ml-auto">
                            {label}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

export type UserPublicItemProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    label?: ReactNode
    className?: string
    userId?: string
    mailLink?: boolean
}

export function UserPublicItem({
                                   name,
                                   email,
                                   label,
                                   className,
                                   userId,
                                   mailLink = false,
                                   ...props
                               }: UserPublicItemProps) {
    return <UserItem name={name} email={email} label={label} className={className} mailLink={mailLink} autoFetch
                     userId={userId} {...props}/>;
}   