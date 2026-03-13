"use client"

import {HTMLAttributes, ReactNode} from "react"
import {usePublicConfig, usePublicUser} from "@workspace/lib/public"
import {getMailComposeUrl} from "@workspace/lib/api"
import {useContacts} from "@workspace/lib/contacts";
import {parseOwnerId} from "@workspace/lib/types";
import {usePeopleTeams} from "@workspace/lib/people";

export type UserNameProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    label?: ReactNode
    className?: string
    mailLink?: boolean
    autoFetch?: boolean
}

export function UserName({
                             name,
                             email,
                             imageUrl,
                             userId,
                             label,
                             className,
                             mailLink = false,
                             autoFetch = false,
                             ...props
                         }: UserNameProps) {
    const {data: dataContacts, isLoading: isLoadingContacts} = useContacts();
    const {data: dataPublic, isLoading: isLoadingPublic} = usePublicUser(userId || email || '');
    const {data: org} = usePublicConfig();
    const {data: teams} = usePeopleTeams(org?.orgId);

    const parsed = parseOwnerId(userId || email || '');

    const contact = !isLoadingContacts && email && dataContacts ? dataContacts.find(c => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const displayName = (parsed.type === 'team' ? teams?.find((t) => t.id === parsed.id)?.name : '') || (contact && `${contact.firstName} ${contact.lastName}`.trim()) || (publicUser && publicUser.name?.trim()) || name || email || "";
    const resolvedEmail = (parsed.type === 'team' ? 'Team' : '') || publicUser?.email || email || "";

    if (isLoadingPublic || isLoadingContacts) return <span/>;

    return (
        <span className={className} {...props}>
            {displayName}
            {resolvedEmail && (resolvedEmail !== displayName || mailLink) &&
                <> ({mailLink ? <a className="hover:underline"
                    href={getMailComposeUrl(resolvedEmail)}>{resolvedEmail}</a> : resolvedEmail})</>}
        </span>
    );
}
