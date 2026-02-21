"use client"

import {HTMLAttributes, ReactNode} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {UserAvatar} from "./user-avatar"
import {usePublicUser} from "@workspace/lib/public"
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
    const {data, isLoading} = usePublicUser(email || '', {enabled: autoFetch});

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
                <div className="flex justify-between items-center">
                    {resolvedEmail && resolvedName && resolvedName !== resolvedEmail && <p className="text-xs text-gray-500">{mailLink ? <a className="hover:underline"
                                                                                          href={`${import.meta.env.VITE_APP_MAIL_URL}/box/inbox?mode=compose&to=${resolvedEmail}`}>{resolvedEmail}</a> : resolvedEmail}</p>}
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
    email?: string
    label?: ReactNode
    className?: string
    mailLink?: boolean
}

export function UserPublicItem({email, label, className, mailLink = false, ...props}: UserPublicItemProps) {
    return <UserItem email={email} label={label} className={className} mailLink={mailLink} autoFetch {...props}/>;
}