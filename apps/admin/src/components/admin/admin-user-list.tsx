import { formatDate } from '@workspace/lib/date';
import { Badge } from '@workspace/ui/components/badge';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { DangerZone } from '@workspace/ui/components/layout/delete/danger-zone';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { UserDetailHero } from '@workspace/ui/components/layout/user-detail-hero';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { cn } from '@workspace/ui/lib/utils';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

type AdminUser = {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    role: string | null;
    createdAt: Date;
};

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
    const filtered = useMemo(() => {
        const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name));
        if (!searchQuery) return sorted;
        const q = searchQuery.toLowerCase();
        return sorted.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }, [users, searchQuery]);

    if (filtered.length === 0) {
        return <EmptyState message={searchQuery ? 'No users match your search.' : emptyMessage} />;
    }

    return (
        <div className="flex-1 overflow-y-auto">
            {filtered.map((user) => (
                <div
                    key={user.id}
                    className={cn(
                        'flex items-center gap-3 px-4 py-3 eigen-list-item',
                        activeUserId === user.id && 'eigen-list-item-active',
                    )}
                    onClick={() => onRowClick(user.id)}
                >
                    <UserItem name={user.name} email={user.email} className="flex-1 min-w-0" />
                    {user.role && (
                        <Badge variant="outline" className="shrink-0 text-xs">
                            {user.role}
                        </Badge>
                    )}
                </div>
            ))}
        </div>
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
    onDelete: () => void;
};

export function AdminUserDetail({ user, onDelete }: AdminUserDetailProps) {
    return (
        <div className="p-6 space-y-6">
            <UserDetailHero name={user.name} email={user.email} imageUrl={user.image} subtitle={user.email} />

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

            <DangerZone
                description="Permanently delete this user account and all associated data."
                buttonLabel="Delete user"
                confirmTitle="Delete User"
                confirmDescription={`Permanently delete ${user.name} (${user.email}) and all their data? This cannot be undone.`}
                onConfirm={onDelete}
            />
        </div>
    );
}
