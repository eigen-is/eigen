import { useResolvedUser } from '@workspace/lib/public';
import { cn } from '@workspace/ui/lib/utils';
import type { HTMLAttributes } from 'react';
import { Avatar, AvatarImage } from '../avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip.tsx';
import { OwnerInfoPopover } from './owner-info-popover';

export type UserAvatarProps = Omit<HTMLAttributes<HTMLDivElement>, 'popover'> & {
    name?: string;
    email?: string;
    imageUrl?: string;
    userId?: string;
    className?: string;
    size?: 'sm' | 'md' | 'lg';
    tooltip?: boolean;
    popover?: boolean;
};

export function UserAvatar({
    name,
    email,
    imageUrl,
    userId,
    className,
    size = 'md',
    tooltip = false,
    popover = false,
    ...props
}: UserAvatarProps) {
    const { displayName, avatarSrc } = useResolvedUser({ userId, email, name, imageUrl });

    const sizeClasses = {
        sm: 'h-6 w-6',
        md: 'h-8 w-8',
        lg: 'h-10 w-10',
    };

    const avatar = (
        <Avatar className={cn(sizeClasses[size], className, 'print-exact select-none')} {...props}>
            <AvatarImage src={avatarSrc} alt={displayName} />
        </Avatar>
    );

    if (popover) {
        return (
            <OwnerInfoPopover
                userId={userId}
                email={email}
                name={name}
                tooltipText={tooltip ? displayName : undefined}
                triggerClassName="rounded-full"
            >
                {avatar}
            </OwnerInfoPopover>
        );
    }

    if (tooltip) {
        return (
            <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>{avatar}</TooltipTrigger>
                <TooltipContent>{displayName}</TooltipContent>
            </Tooltip>
        );
    }

    return avatar;
}
