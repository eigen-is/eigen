"use client"

import {HTMLAttributes, ReactNode} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {UserAvatar} from "./user-avatar"
import {usePublicUser} from "@workspace/lib/public"
import {getMailComposeUrl} from "@workspace/lib/api"
import {EigenLoader} from "./eigen-loader"

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
    const {data, isLoading} = usePublicUser(userId || email || '');

    const resolvedName = autoFetch ? (data?.name || name || email) : (name || email || "");
    const resolvedEmail = autoFetch ? (data?.email || email) : email;
    const displayName = resolvedName || "";

    if (autoFetch && isLoading) return <EigenLoader/>;

    return (
        <div className={cn("flex items-center", className)} {...props}>
            <UserAvatar
                name={resolvedName}
                email={resolvedEmail}
                imageUrl={imageUrl}
                userId={userId}
            />

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                <div className="flex justify-between items-center gap-2">
                    {resolvedEmail && resolvedName && resolvedName !== resolvedEmail &&
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