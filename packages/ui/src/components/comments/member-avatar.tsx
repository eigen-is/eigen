import { useResolvedUser } from '@workspace/lib/public';
import { Avatar, AvatarFallback, AvatarImage } from '@workspace/ui/components/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';

// Not UserAvatar: member lists need an initial-letter fallback at 16px (UserAvatar renders an
// empty circle for imageless users; adding a fallback there is an app-wide visual decision).
export function MemberAvatar({ email, className }: { email: string; className?: string }) {
    const { displayName, avatarSrc } = useResolvedUser({ email });
    const label = displayName || email.split('@')[0];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Avatar className={cn('h-4 w-4', className)}>
                    <AvatarImage src={avatarSrc} alt={label} />
                    <AvatarFallback className="text-[9px]">{label.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}
