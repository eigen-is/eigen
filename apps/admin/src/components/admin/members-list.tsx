import type { OrgMember } from '@workspace/lib/types/admin';
import { EmptyState } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { SearchBar } from '@workspace/ui/components/search-bar/search-bar';
import { PersonList } from '@workspace/ui/components/user/person-list';
import { UserItem } from '@workspace/ui/components/user/user-item';
import { Plus } from 'lucide-react';
import { CreateUserDialog } from './create-user-dialog';

type MembersListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    showCreateDialog: boolean;
    onShowCreateDialog: (show: boolean) => void;
    organizationId?: string;
};

export function MembersListToolbar({
    searchQuery,
    onSearchChange,
    showCreateDialog,
    onShowCreateDialog,
    organizationId,
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
                <Plus className="h-4 w-4" />
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

type MembersListProps = {
    members: OrgMember[];
    searchQuery: string;
    activeMemberId?: string;
    onRowClick: (memberId: string) => void;
};

export function MembersList({ members, searchQuery, activeMemberId, onRowClick }: MembersListProps) {
    return (
        <PersonList
            items={members}
            searchQuery={searchQuery}
            activeId={activeMemberId}
            getId={(m) => m.id}
            getSelectionId={(m) => m.userId}
            getName={(m) => m.name}
            getSearchFields={(m) => [m.name, m.email]}
            onRowClick={onRowClick}
            selectable
            dragType="member"
            emptyState={<EmptyState message={searchQuery ? 'No members match your search' : 'No members found'} />}
            renderPerson={(member) => (
                <UserItem
                    name={member.name}
                    email={member.email}
                    userId={member.userId}
                    label={
                        <Badge variant={roleBadgeVariant[member.role] ?? 'outline'} className="text-xs">
                            {member.role}
                        </Badge>
                    }
                    className="flex-1"
                />
            )}
        />
    );
}
