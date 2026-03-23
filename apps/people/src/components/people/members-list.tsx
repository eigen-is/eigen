import {useMemo, useRef} from 'react';
import {cn} from '@workspace/ui/lib/utils';
import {EmptyState} from '@workspace/ui';
import {SearchBar} from '@workspace/ui/components/layout/search-bar/search-bar';
import {UserItem} from '@workspace/ui/components/layout/user-item';
import {useKeyboardListNavigation} from '@workspace/ui/hooks/use-keyboard-list-navigation';
import {useListSelection} from '@workspace/ui/hooks/use-list-selection';
import {useListDrag} from '@workspace/ui/hooks/use-list-drag';
import {Badge} from '@workspace/ui/components/badge';
import {Button} from '@workspace/ui/components/button';
import {Plus} from 'lucide-react';
import type {OrgMember} from '@workspace/lib/types/people';
import {CreateUserDialog} from './create-user-dialog';

interface MembersListToolbarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    showCreateDialog: boolean;
    onShowCreateDialog: (show: boolean) => void;
    organizationId?: string;
}

export function MembersListToolbar({
                                       searchQuery,
                                       onSearchChange,
                                       showCreateDialog,
                                       onShowCreateDialog,
                                       organizationId
                                   }: MembersListToolbarProps) {
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder="Search members..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
            />
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => onShowCreateDialog(true)}>
                <Plus className="h-4 w-4"/>
            </Button>
            <CreateUserDialog
                open={showCreateDialog}
                onOpenChange={onShowCreateDialog}
                organizationId={organizationId}
            />
        </div>
    );
}

const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
    owner: 'default',
    admin: 'secondary',
    member: 'outline',
};

interface MembersListProps {
    members: OrgMember[];
    searchQuery: string;
    activeMemberId?: string;
    onRowClick: (memberId: string) => void;
}

export function MembersList({members, searchQuery, activeMemberId, onRowClick}: MembersListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    const filteredMembers = useMemo(() => {
        const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
        if (!searchQuery) return sorted;
        const q = searchQuery.toLowerCase();
        return sorted.filter(m =>
            m.name.toLowerCase().includes(q) ||
            m.email.toLowerCase().includes(q)
        );
    }, [members, searchQuery]);

    const selection = useListSelection({items: filteredMembers, getId: (m) => m.userId});

    const drag = useListDrag({selection, getId: (m) => m.userId, dragType: 'member'});

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
        items: filteredMembers,
        activeId: activeMemberId,
        getId: (m) => m.id,
        onSelect: (id) => onRowClick(id),
        containerRef: listRef,
        selection,
    });

    if (filteredMembers.length === 0) {
        return <EmptyState message={searchQuery ? 'No members match your search.' : 'No members found.'}/>;
    }

    return (
        <div
            className="flex-1 overflow-y-auto outline-none"
            ref={listRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
        >
            {filteredMembers.map((member, index) => (
                <div
                    key={member.id}
                    className={cn(
                        "flex items-center gap-3 px-4 py-3 eigen-list-item",
                        (activeMemberId === member.id || selectedIndex === index) && "eigen-list-item-active",
                        selection.isSelected(member.userId) && "eigen-list-item-selected",
                    )}
                    onClick={(e) => {
                        selection.handleItemClick(member.userId, e);
                        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                            onRowClick(member.id);
                        }
                    }}
                    {...drag.getDragProps(member)}
                >
                    <UserItem
                        name={member.name}
                        email={member.email}
                        className="flex-1 min-w-0"
                    />
                    <Badge variant={roleBadgeVariant[member.role] ?? 'outline'} className="shrink-0 text-xs">
                        {member.role}
                    </Badge>
                </div>
            ))}
        </div>
    );
}
