import { formatDate } from '@workspace/lib/date';
import type { AdminUser } from '@workspace/lib/types/admin';
import { Badge } from '@workspace/ui/components/badge';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { PersonList } from '@workspace/ui/components/layout/person-list';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { UserDetailHero } from '@workspace/ui/components/layout/user-detail-hero';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

type AdminUserListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    placeholder: string;
};

export function AdminUserListToolbar({ searchQuery, onSearchChange, placeholder }: AdminUserListToolbarProps) {
    return (
        <SearchBar
            placeholder={placeholder}
            value={searchQuery}
            onChange={onSearchChange}
            maxWidth="full"
            inputClassName="h-8 bg-background"
        />
    );
}

type AdminUserListProps = {
    users: AdminUser[];
    searchQuery: string;
    activeUserId?: string;
    onRowClick: (userId: string) => void;
    emptyMessage: string;
};

export function AdminUserList({ users, searchQuery, activeUserId, onRowClick, emptyMessage }: AdminUserListProps) {
    return (
        <PersonList
            items={users}
            searchQuery={searchQuery}
            activeId={activeUserId}
            getId={(u) => u.id}
            getName={(u) => u.name}
            getSearchFields={(u) => [u.name, u.email]}
            onRowClick={onRowClick}
            emptyState={<EmptyState message={searchQuery ? 'No users match your search.' : emptyMessage} />}
            renderPerson={(user) => (
                <UserItem
                    name={user.name}
                    email={user.email}
                    userId={user.id}
                    label={
                        user.role && (
                            <Badge variant="outline" className="text-xs">
                                {user.role}
                            </Badge>
                        )
                    }
                    className="flex-1"
                />
            )}
        />
    );
}

type AdminUserDetailToolbarProps = {
    user: AdminUser;
    onDelete: () => void;
};

export function AdminUserDetailToolbar({ user, onDelete }: AdminUserDetailToolbarProps) {
    const [showDelete, setShowDelete] = useState(false);
    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={Trash2} tooltipText="Delete user" onClick={() => setShowDelete(true)} />
            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Delete User"
                description={`Permanently delete ${user.name} (${user.email}) and all their data? This cannot be undone.`}
                onDelete={onDelete}
            />
        </div>
    );
}

type AdminUserDetailProps = {
    user: AdminUser;
};

export function AdminUserDetail({ user }: AdminUserDetailProps) {
    return (
        <div className="app-gutter space-y-6">
            <UserDetailHero name={user.name} email={user.email} userId={user.id} subtitle={user.email} />

            <div className="space-y-4">
                {user.role && (
                    <div>
                        <h3 className="text-sm font-medium text-muted-foreground mb-2">Role</h3>
                        <Badge variant="outline">{user.role}</Badge>
                    </div>
                )}
                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">Created</h3>
                    <p className="text-sm">{formatDate(user.createdAt)}</p>
                </div>
            </div>
        </div>
    );
}
