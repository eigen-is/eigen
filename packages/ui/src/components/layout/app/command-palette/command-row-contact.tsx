import { useResolvedUser } from '@workspace/lib/public';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { Avatar, AvatarImage } from '@workspace/ui/components/avatar';
import { CommandItem } from '@workspace/ui/components/command';

type Props = {
    result: Extract<PaletteResult, { kind: 'contact' }>;
    onSelect: () => void;
};

// Use the same name/email/avatar resolver as UserItem (so the avatar matches the
// rest of the app), but render at palette density — a small avatar that visually
// matches the h-4 w-4 lucide icons every other row uses.
export function CommandRowContact({ result, onSelect }: Props) {
    const { displayName, resolvedEmail, avatarSrc } = useResolvedUser({
        userId: result.payload.id,
        email: result.payload.email,
        name: result.payload.displayName,
    });
    return (
        <CommandItem onSelect={onSelect} value={result.id}>
            <Avatar className="h-5 w-5 print-exact select-none shrink-0">
                <AvatarImage src={avatarSrc} alt={displayName} />
            </Avatar>
            <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate">{displayName}</span>
                {resolvedEmail && resolvedEmail !== displayName && (
                    <span className="text-xs text-muted-foreground truncate">{resolvedEmail}</span>
                )}
            </div>
        </CommandItem>
    );
}
