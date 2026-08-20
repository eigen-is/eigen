import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { EmptyState, SearchBar, SortHeader } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { UserAvatar } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CreateUserDialog } from './create-user-dialog';

// Org role → badge variant. Single source of truth: the guests page (admin-user-list.tsx)
// imports this instead of keeping its own copy.
export const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
    owner: 'default',
    admin: 'secondary',
    member: 'outline',
};

type AdminUsersToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    showCreateDialog: boolean;
    onShowCreateDialog: (show: boolean) => void;
    organizationId?: string;
};

export function AdminUsersToolbar({
    searchQuery,
    onSearchChange,
    showCreateDialog,
    onShowCreateDialog,
    organizationId,
}: AdminUsersToolbarProps) {
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder="Search users..."
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

type SortCol = 'name' | 'email' | 'role' | 'teams' | 'disk' | 'lastActive' | 'joined';
type SortState = { col: SortCol; dir: 1 | -1 };

// Static cumulative grid templates so Tailwind's JIT sees every class. Columns append on the
// right as the container widens; each track lines up, in DOM order, with the visible cells at
// that width (a display:none cell takes no grid track). DOM/column order matches the appearance
// widths below so growing the container never reorders the visible columns.
const gridCols = cn(
    'grid-cols-[minmax(0,1fr)]',
    '@[420px]:grid-cols-[minmax(0,1fr)_90px]',
    '@[550px]:grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.5fr)]',
    '@[650px]:grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.5fr)_110px]',
    '@[750px]:grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.5fr)_110px_minmax(0,1fr)]',
    '@[850px]:grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.5fr)_110px_minmax(0,1fr)_110px]',
    '@[950px]:grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.5fr)_110px_minmax(0,1fr)_110px_110px]',
);

// Per-column visibility, shared by header and body cells so they collapse together. Name is
// always visible; the rest appear at the width their track is added above.
const COL_VISIBILITY: Record<Exclude<SortCol, 'name'>, string> = {
    role: 'hidden @[420px]:flex',
    email: 'hidden @[550px]:flex',
    disk: 'hidden @[650px]:flex',
    teams: 'hidden @[750px]:flex',
    lastActive: 'hidden @[850px]:flex',
    joined: 'hidden @[950px]:flex',
};

type AdminUsersTableProps = {
    users: AdminUserRow[];
    usage: Record<string, HomeSizeResponse> | undefined;
    searchQuery: string;
    activeUserId?: string;
    onRowClick: (userId: string) => void;
};

export function AdminUsersTable({ users, usage, searchQuery, activeUserId, onRowClick }: AdminUsersTableProps) {
    const [sort, setSort] = useState<SortState>({ col: 'name', dir: 1 });

    const handleSort = (col: SortCol) => {
        setSort((prev) => (prev.col === col ? { col, dir: prev.dir === 1 ? -1 : 1 } : { col, dir: 1 }));
    };

    const visible = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const filtered = q
            ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
            : users;

        const diskUsed = (u: AdminUserRow) => usage?.[u.id]?.total.used ?? 0;
        const compare = (a: AdminUserRow, b: AdminUserRow): number => {
            switch (sort.col) {
                case 'name':
                    return a.name.localeCompare(b.name);
                case 'email':
                    return a.email.localeCompare(b.email);
                case 'role':
                    return (a.role ?? '').localeCompare(b.role ?? '');
                case 'teams':
                    return a.teams.join(', ').localeCompare(b.teams.join(', '));
                case 'disk':
                    return diskUsed(a) - diskUsed(b);
                case 'lastActive':
                    return (a.lastActiveAt?.getTime() ?? 0) - (b.lastActiveAt?.getTime() ?? 0);
                case 'joined':
                    return a.createdAt.getTime() - b.createdAt.getTime();
            }
        };
        return [...filtered].sort((a, b) => compare(a, b) * sort.dir);
    }, [users, usage, searchQuery, sort]);

    if (visible.length === 0) {
        return <EmptyState message={searchQuery ? 'No users match your search.' : 'No users found'} />;
    }

    const dir = sort.dir === 1 ? 'asc' : 'desc';

    return (
        <div className="@container flex-1 overflow-auto relative w-full text-sm focus:outline-none">
            <div className={cn('grid border-b app-gutter-x sticky top-0 z-10 bg-background', gridCols)}>
                <SortHeader
                    label="Name"
                    active={sort.col === 'name'}
                    dir={dir}
                    onClick={() => handleSort('name')}
                    className="flex pr-2"
                />
                <SortHeader
                    label="Role"
                    active={sort.col === 'role'}
                    dir={dir}
                    onClick={() => handleSort('role')}
                    className={cn('pr-2', COL_VISIBILITY.role)}
                />
                <SortHeader
                    label="Email"
                    active={sort.col === 'email'}
                    dir={dir}
                    onClick={() => handleSort('email')}
                    className={cn('pr-2', COL_VISIBILITY.email)}
                />
                <SortHeader
                    label="Disk"
                    active={sort.col === 'disk'}
                    dir={dir}
                    onClick={() => handleSort('disk')}
                    className={cn('pr-2', COL_VISIBILITY.disk)}
                />
                <SortHeader
                    label="Teams"
                    active={sort.col === 'teams'}
                    dir={dir}
                    onClick={() => handleSort('teams')}
                    className={cn('pr-2', COL_VISIBILITY.teams)}
                />
                <SortHeader
                    label="Last active"
                    active={sort.col === 'lastActive'}
                    dir={dir}
                    onClick={() => handleSort('lastActive')}
                    className={cn('pr-2', COL_VISIBILITY.lastActive)}
                />
                <SortHeader
                    label="Joined"
                    active={sort.col === 'joined'}
                    dir={dir}
                    onClick={() => handleSort('joined')}
                    className={cn('pr-2', COL_VISIBILITY.joined)}
                />
            </div>

            {visible.map((u) => (
                <button
                    key={u.id}
                    type="button"
                    onClick={() => onRowClick(u.id)}
                    className={cn(
                        'grid w-full app-gutter-x items-center text-left eigen-list-item',
                        gridCols,
                        activeUserId === u.id && 'eigen-list-item-active',
                    )}
                >
                    <div className="flex min-w-0 items-center gap-3 py-2 pr-2">
                        <UserAvatar name={u.name} email={u.email} userId={u.id} size="sm" />
                        <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">{u.name}</div>
                            <div className="truncate text-xs text-muted-foreground @[550px]:hidden">{u.email}</div>
                        </div>
                    </div>

                    <div className={cn('items-center pr-2', COL_VISIBILITY.role)}>
                        {u.role ? (
                            <Badge variant={roleBadgeVariant[u.role] ?? 'outline'} className="text-xs">
                                {u.role}
                            </Badge>
                        ) : (
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                                no organisation
                            </Badge>
                        )}
                    </div>

                    <div className={cn('min-w-0 items-center text-muted-foreground pr-2', COL_VISIBILITY.email)}>
                        <span className="truncate">{u.email}</span>
                    </div>

                    <div className={cn('items-center text-muted-foreground pr-2', COL_VISIBILITY.disk)}>
                        {usage ? formatFileSize(usage[u.id]?.total.used ?? 0) : '—'}
                    </div>

                    <div className={cn('min-w-0 items-center text-muted-foreground pr-2', COL_VISIBILITY.teams)}>
                        <span className="truncate">{u.teams.length > 0 ? u.teams.join(', ') : '—'}</span>
                    </div>

                    <div className={cn('items-center text-muted-foreground pr-2', COL_VISIBILITY.lastActive)}>
                        {u.lastActiveAt ? formatTimeAgo(u.lastActiveAt) : '—'}
                    </div>

                    <div className={cn('items-center text-muted-foreground pr-2', COL_VISIBILITY.joined)}>
                        {formatDate(u.createdAt)}
                    </div>
                </button>
            ))}
        </div>
    );
}
