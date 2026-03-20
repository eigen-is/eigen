import {HTMLAttributes, ReactNode} from "react"
import {cn} from "@workspace/ui/lib/utils"
import {useResolvedUser} from "@workspace/lib/public"
import {getMailComposeUrl} from "@workspace/lib/api"
import {EigenLoader} from "./braket/eigen-loader.tsx"
import {Avatar, AvatarImage} from "../avatar.tsx";

export type UserItemProps = HTMLAttributes<HTMLDivElement> & {
    name?: string
    email?: string
    imageUrl?: string
    userId?: string
    label?: ReactNode
    className?: string
    mailLink?: boolean
}

export function UserItem({
                             name,
                             email,
                             imageUrl,
                             userId,
                             label,
                             className,
                             mailLink = false,
                             ...props
                         }: UserItemProps) {
    const {displayName, resolvedEmail, avatarSrc, isLoading} = useResolvedUser({userId, email, name, imageUrl});

    if (isLoading) return <EigenLoader/>;

    return (
        <div className={cn("flex items-center", className)} {...props}>
            <Avatar className={"h-8 w-8 print-exact select-none"}>
                <AvatarImage src={avatarSrc} alt={displayName}/>
            </Avatar>

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-foreground">{displayName}</p>
                <div className="flex justify-between items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
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
