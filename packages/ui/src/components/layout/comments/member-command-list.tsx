import { usePublicUsers } from '@workspace/lib/public';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@workspace/ui/components/command';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { MemberAvatar } from './member-avatar';

// Shared by the pinned rows in AssigneePicker / AssigneeMenuItems (they live outside cmdk's list so
// they never get filtered, hence they can't reuse CommandItem's data-[selected] styling).
export const memberRowClassName =
    'relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground';

type MemberCommandListProps = {
    members: EffectiveMember[];
    currentUserEmail: string;
    selectedEmail: string | null;
    onSelect: (email: string) => void;
    header?: ReactNode;
};

export function MemberCommandList({ members, selectedEmail, onSelect, header }: MemberCommandListProps) {
    const users = usePublicUsers(members.map((m) => m.email));
    const showSearch = members.length > 8;
    return (
        <Command>
            {showSearch && <CommandInput placeholder="Find person…" />}
            {header}
            <CommandList className="max-h-56 overflow-y-auto">
                <CommandEmpty>No people found.</CommandEmpty>
                {members.map((m) => {
                    const displayName = users[m.email]?.name || m.email.split('@')[0];
                    return (
                        <CommandItem
                            key={m.email}
                            value={`${displayName} ${m.email}`}
                            onSelect={() => onSelect(m.email)}
                        >
                            <MemberAvatar email={m.email} />
                            <span className="flex-1 truncate">{displayName}</span>
                            {selectedEmail === m.email && <Check className="h-4 w-4 shrink-0" />}
                        </CommandItem>
                    );
                })}
            </CommandList>
            {showSearch && (
                <div className="border-t px-2 py-1 text-[11px] text-muted-foreground">{members.length} people</div>
            )}
        </Command>
    );
}
