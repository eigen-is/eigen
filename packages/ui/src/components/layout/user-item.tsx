"use client"

import {HTMLAttributes, ReactNode, useMemo} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {UserAvatar} from "./user-avatar"
import {useAvatar} from "@workspace/lib/media"
import { EigenLoader } from "./eigen-loader"

export interface UserItemProps extends HTMLAttributes<HTMLDivElement> {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    label?: ReactNode
    className?: string
}

export function UserItem({
                             name,
                             email,
                             imageUrl,
                             userId,
                             label,
                             className,
                             ...props
                         }: UserItemProps) {
    const displayName = name || email || ""

    return (
        <div className={cn("flex items-center", className)} {...props}>
            <UserAvatar
                name={name}
                email={email}
                imageUrl={imageUrl}
                userId={userId}
            />

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                <div className="flex justify-between items-center">
                    {email && name && <p className="text-xs text-gray-500">{email}</p>}
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

export interface UserPublicItemProps extends HTMLAttributes<HTMLDivElement> {
    email?: string
    label?: ReactNode
    className?: string
}

export function UserPublicItem({
    email,
    label,
    className,
    ...props
}: UserPublicItemProps) {
    const {data, isLoading } = useAvatar(email || '', {enabled: true});
    
    return isLoading ? <EigenLoader /> : (
        <div className={cn("flex items-center", className)} {...props}>
            <UserAvatar
                name={data?.name || email}
                email={data?.email || email}
                imageUrl={data?.avatar}
            />

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">{data?.name || email}</p>
                <div className="flex justify-between items-center">
                {data?.email && data?.name && <p className="text-xs text-gray-500">{data?.email}</p>}
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