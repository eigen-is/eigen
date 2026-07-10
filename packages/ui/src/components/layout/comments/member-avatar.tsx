import { useResolvedUser } from '@workspace/lib/public';
import { Avatar, AvatarFallback, AvatarImage } from '@workspace/ui/components/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';

// Mirrors UserItem's avatar: useResolvedUser bakes the API_HOST/getPublicAvatarUrl helper into avatarSrc.
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
