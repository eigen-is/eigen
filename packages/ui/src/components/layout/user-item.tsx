"use client"

import {HTMLAttributes, ReactNode} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {usePublicConfig, usePublicUser} from "@workspace/lib/public"
import {API_HOST, getMailComposeUrl, getPublicAvatarUrl} from "@workspace/lib/api"
import {EigenLoader} from "./eigen-loader"
import {useContacts} from "@workspace/lib/contacts";
import {Avatar, AvatarImage} from "../avatar.tsx";
import {parseOwnerId} from "@workspace/lib/types";
import {usePeopleTeams} from "@workspace/lib/people";

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
    const {data: org} = usePublicConfig();
    const {data: teams} = usePeopleTeams(org?.orgId);

    const parsed = parseOwnerId(userId || email || '');

    const contact = !isLoadingContacts && email && dataContacts ? dataContacts.find(c => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl || (contact?.avatar) || (publicUser?.avatar) || null;
    const displayName = (parsed.type === 'team' ? teams?.find((t) => t.id === parsed.id)?.name : '') || (contact && `${contact.firstName} ${contact.lastName}`.trim()) || (publicUser && publicUser.name?.trim()) || name || email || "";
    const resolvedEmail = (parsed.type === 'team' ? 'Team' : '') || publicUser?.email || email || "";
    const avatarSrc = url
        ? `${API_HOST}/${url}`
        : getPublicAvatarUrl(userId || email || '');

    if (isLoadingPublic || isLoadingContacts) return <EigenLoader/>;

    return (
        <div className={cn("flex items-center", className)} {...props}>
            <Avatar className={"h-8 w-8 print-exact select-none"}>
                <AvatarImage src={avatarSrc} alt={displayName}/>
            </Avatar>

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                <div className="flex justify-between items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
                    {resolvedEmail && (resolvedEmail !== displayName || mailLink) &&
                        <span>{mailLink ? <a className="hover:underline"
                                             href={getMailComposeUrl(resolvedEmail)}>{resolvedEmail}</a> : resolvedEmail}</span>}
                    {label && (
                        <span>
                            {label}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
