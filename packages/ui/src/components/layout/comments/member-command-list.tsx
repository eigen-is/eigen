import type { CommentAssigneeFilter } from '@workspace/lib/comments';
import { usePublicUsers } from '@workspace/lib/public';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@workspace/ui/components/command';
import { Check, CircleSlash, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { MemberAvatar } from './member-avatar';

// Pinned rows live outside cmdk's list so they never get filtered, hence they can't reuse
// CommandItem's data-[selected] styling.
export const memberRowClassName =
    'relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground';

// The "me / Unassigned" header block shared by AssigneePicker and AssigneeMenuItems.
export function PinnedAssigneeRows({
    currentUserEmail,
    selected,
    onSelect,
    meLabel,
}: {
    currentUserEmail: string;
    selected: string | null;
    onSelect: (email: string | null) => void;
    meLabel: string;
}) {
    return (
        <div className="p-1">
            <button type="button" className={memberRowClassName} onClick={() => onSelect(currentUserEmail)}>
                <MemberAvatar email={currentUserEmail} />
                <span className="flex-1 truncate text-left">{meLabel}</span>
                {selected === currentUserEmail && <Check className="h-4 w-4 shrink-0" />}
            </button>
            <button type="button" className={memberRowClassName} onClick={() => onSelect(null)}>
                <CircleSlash className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate text-left">Unassigned</span>
                {selected === null && <Check className="h-4 w-4 shrink-0" />}
            </button>
        </div>
    );
}

// Filter-semantics sibling of PinnedAssigneeRows (CommentAssigneeFilter values, not string | null),
// shared by CommentFilterButton and CommentFilterMenuItems.
export function PinnedAssigneeFilterRows({
    assignee,
    onSelect,
    currentUserEmail,
}: {
    assignee: CommentAssigneeFilter;
    onSelect: (a: CommentAssigneeFilter) => void;
    currentUserEmail: string;
}) {
    return (
        <div className="p-1">
            <button type="button" className={memberRowClassName} onClick={() => onSelect('all')}>
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate text-left">Anyone</span>
                {assignee === 'all' && <Check className="h-4 w-4 shrink-0" />}
            </button>
            <button type="button" className={memberRowClassName} onClick={() => onSelect('me')}>
                <MemberAvatar email={currentUserEmail} />
                <span className="flex-1 truncate text-left">Me</span>
                {assignee === 'me' && <Check className="h-4 w-4 shrink-0" />}
            </button>
            <button type="button" className={memberRowClassName} onClick={() => onSelect('unassigned')}>
                <CircleSlash className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate text-left">Unassigned</span>
                {assignee === 'unassigned' && <Check className="h-4 w-4 shrink-0" />}
            </button>
        </div>
    );
}

type MemberCommandListProps = {
    members: EffectiveMember[];
    selectedEmail: string | null;
    onSelect: (email: string) => void;
    header?: ReactNode;
    // The current user is pinned as a "Me" row in the header, so hide their named row here.
    currentUserEmail?: string;
};

export function MemberCommandList({
    members,
    selectedEmail,
    onSelect,
    header,
    currentUserEmail,
}: MemberCommandListProps) {
    const me = currentUserEmail?.toLowerCase();
    const listed = me ? members.filter((m) => m.email !== me) : members;
    const users = usePublicUsers(listed.map((m) => m.email));
    const showSearch = listed.length > 8;
    return (
        <Command>
            {showSearch && <CommandInput placeholder="Find person…" />}
            {header}
            <CommandList className="max-h-56 overflow-y-auto">
                {/* Anyone/Me/Unassigned live in the header, so an empty member list is normal — only a real search miss (list non-empty) warrants the message. */}
                {listed.length > 0 && <CommandEmpty>No people found.</CommandEmpty>}
                {listed.map((m) => {
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
                <div className="border-t px-2 py-1 text-[11px] text-muted-foreground">{listed.length} people</div>
            )}
        </Command>
    );
}
