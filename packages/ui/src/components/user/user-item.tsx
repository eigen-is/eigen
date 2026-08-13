import { useResolvedUser } from '@workspace/lib/public';
import { cn } from '@workspace/ui/lib/utils';
import type { HTMLAttributes, ReactNode } from 'react';
import { Avatar, AvatarImage } from '../avatar';
import { EigenLoader } from '../braket/eigen-loader';
import { MailComposeLink } from './mail-compose-link';
import { OwnerInfoPopover } from './owner-info-popover';

export type UserItemProps = Omit<HTMLAttributes<HTMLDivElement>, 'popover'> & {
    name?: string;
    email?: string;
    imageUrl?: string;
    userId?: string;
    label?: ReactNode;
    className?: string;
    mailLink?: boolean;
    popover?: boolean;
};

export function UserItem({
    name,
    email,
    imageUrl,
    userId,
    label,
    className,
    mailLink = false,
    popover = false,
    ...props
}: UserItemProps) {
    const { displayName, resolvedEmail, avatarSrc, isLoading } = useResolvedUser({
        userId,
        email,
        name,
        imageUrl,
    });

    if (isLoading) return <EigenLoader />;

    const row = (
        <div className={cn('flex items-center', className)} {...props}>
            <Avatar className={'h-8 w-8 print-exact select-none'}>
                <AvatarImage src={avatarSrc} alt={displayName} />
            </Avatar>

            <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-foreground">{displayName}</p>
                <div className="flex justify-between items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                    {resolvedEmail && (resolvedEmail !== displayName || mailLink) && (
                        <span>
                            <MailComposeLink email={resolvedEmail} mailLink={mailLink} />
                        </span>
                    )}
                    {label && <span className="ml-auto">{label}</span>}
                </div>
            </div>
        </div>
    );

    if (popover) {
        return (
            <OwnerInfoPopover userId={userId} email={email} name={name} triggerClassName="w-full text-left rounded">
                {row}
            </OwnerInfoPopover>
        );
    }

    return row;
}
