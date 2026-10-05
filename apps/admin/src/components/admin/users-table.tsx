import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import type { SortDir } from '@workspace/ui';
import { EmptyState, nextSortDir, SearchBar, SortHeader, TooltipButton } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { UserAvatar } from '@workspace/ui/components/user';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import { useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CreateUserDialog } from './create-user-dialog';

// Org role → badge variant for the role column (orphans render a plain outline badge inline).
const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
    owner: 'default',
    admin: 'secondary',
    member: 'outline',
};

type AdminUsersToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    organizationId?: string;
    // A guest account comes from its own code sign-in, so the guests page has nothing to create.
    guests?: boolean;
};

export function AdminUsersToolbar({ searchQuery, onSearchChange, organizationId, guests }: AdminUsersToolbarProps) {
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder={guests ? 'Search guests...' : 'Search users...'}
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
            />
            {!guests && (
                <>
                    <TooltipButton
                        icon={Plus}
                        tooltipText="Create User"
                        className="shrink-0"
                        onClick={() => setShowCreateDialog(true)}
                    />
                    <CreateUserDialog
                        open={showCreateDialog}
                        onOpenChange={setShowCreateDialog}
                        organizationId={organizationId}
                    />
                </>
            )}
        </div>
    );
}

type SortCol = 'name' | 'email' | 'role' | 'teams' | 'disk' | 'lastActive' | 'joined';
type SortState = { col: SortCol; dir: SortDir };

// Sort semantics mirror Drive's (via the shared nextSortDir helper): re-selecting the active column
// flips direction; switching to a new column uses that column's default — text ascending, size and
// date columns descending.
const DEFAULT_DIR: Record<SortCol, SortDir> = {
    name: 'asc',
    email: 'asc',
    role: 'asc',
    teams: 'asc',
    disk: 'desc',
    lastActive: 'desc',
    joined: 'desc',
};

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

// A guest has no role, no teams and no storage of its own (GuestHome sizes to zero), so the guests page
// keeps name, email and last active, on tracks that match those three.
const guestGridCols = cn(
    'grid-cols-[minmax(0,1fr)]',
    '@[550px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)]',
    '@[850px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_110px]',
);
const GUEST_COL_VISIBILITY: typeof COL_VISIBILITY = {
    ...COL_VISIBILITY,
    role: 'hidden',
    disk: 'hidden',
    teams: 'hidden',
    joined: 'hidden',
};

type AdminUsersTableProps = {
    users: AdminUserRow[];
    usage?: Record<string, HomeSizeResponse>;
    searchQuery: string;
    activeUserId?: string;
    onRowClick: (userId: string) => void;
    guests?: boolean;
};

export function AdminUsersTable({ users, usage, searchQuery, activeUserId, onRowClick, guests }: AdminUsersTableProps) {
    const [sort, setSort] = useState<SortState>({ col: 'name', dir: 'asc' });
    const grid = guests ? guestGridCols : gridCols;
    const visibility = guests ? GUEST_COL_VISIBILITY : COL_VISIBILITY;

    const handleSort = (col: SortCol) => {
        setSort((prev) => ({ col, dir: nextSortDir(col, prev.col, prev.dir, DEFAULT_DIR).dir }));
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
        const factor = sort.dir === 'asc' ? 1 : -1;
        return [...filtered].sort((a, b) => compare(a, b) * factor);
    }, [users, usage, searchQuery, sort]);

    // Only org members can be dropped onto a team (addTeamMember needs org membership); orphans
    // (no member row) still render but are excluded from selection and drag.
    const selectableUsers = useMemo(() => visible.filter((u) => u.memberId !== null), [visible]);
    const selection = useListSelection({ items: selectableUsers, getId: (u) => u.id });
    const drag = useListDrag({ selection, getId: (u) => u.id, dragType: 'member' });

    if (visible.length === 0) {
        const none = guests ? 'No guest users' : 'No users found';
        return <EmptyState message={searchQuery ? 'No users match your search.' : none} />;
    }

    const dir = sort.dir;

    return (
        <div className="@container flex-1 overflow-auto relative w-full text-sm focus:outline-none">
            <div className={cn('grid border-b app-gutter-x sticky top-0 z-10 bg-background', grid)}>
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
                    className={cn('pr-2', visibility.role)}
                />
                <SortHeader
                    label="Email"
                    active={sort.col === 'email'}
                    dir={dir}
                    onClick={() => handleSort('email')}
                    className={cn('pr-2', visibility.email)}
                />
                <SortHeader
                    label="Disk"
                    active={sort.col === 'disk'}
                    dir={dir}
                    onClick={() => handleSort('disk')}
                    className={cn('pr-2', visibility.disk)}
                />
                <SortHeader
                    label="Teams"
                    active={sort.col === 'teams'}
                    dir={dir}
                    onClick={() => handleSort('teams')}
                    className={cn('pr-2', visibility.teams)}
                />
                <SortHeader
                    label="Last active"
                    active={sort.col === 'lastActive'}
                    dir={dir}
                    onClick={() => handleSort('lastActive')}
                    className={cn('pr-2', visibility.lastActive)}
                />
                <SortHeader
                    label="Joined"
                    active={sort.col === 'joined'}
                    dir={dir}
                    onClick={() => handleSort('joined')}
                    className={cn('pr-2', visibility.joined)}
                />
            </div>

            {visible.map((u) => {
                const selectable = u.memberId !== null;
                return (
                    <button
                        key={u.id}
                        type="button"
                        onClick={(e) => {
                            // Modifier-click builds a multi-selection (mirrors PersonList); a plain
                            // click opens the detail pane.
                            if (selectable) {
                                selection.handleItemClick(u.id, e);
                                if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                            }
                            onRowClick(u.id);
                        }}
                        {...(selectable ? drag.getDragProps(u) : undefined)}
                        className={cn(
                            'grid w-full app-gutter-x items-center text-left eigen-list-item',
                            grid,
                            activeUserId === u.id && 'eigen-list-item-active',
                            selectable && selection.isSelected(u.id) && 'eigen-list-item-selected',
                        )}
                    >
                        <div className="flex min-w-0 items-center gap-3 py-2 pr-2">
                            <UserAvatar name={u.name} email={u.email} userId={u.id} size="sm" />
                            <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">{u.name}</div>
                                <div className="truncate text-xs text-muted-foreground @[550px]:hidden">{u.email}</div>
                            </div>
                        </div>

                        <div className={cn('items-center pr-2', visibility.role)}>
                            {u.role ? (
                                <Badge variant={roleBadgeVariant[u.role] ?? 'outline'} className="text-xs">
                                    {u.role}
                                </Badge>
                            ) : (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                    no organization
                                </Badge>
                            )}
                        </div>

                        <div className={cn('min-w-0 items-center text-muted-foreground pr-2', visibility.email)}>
                            <span className="truncate">{u.email}</span>
                        </div>

                        <div className={cn('items-center text-muted-foreground pr-2', visibility.disk)}>
                            {usage?.[u.id] ? formatFileSize(usage[u.id].total.used) : '—'}
                        </div>

                        <div className={cn('min-w-0 items-center text-muted-foreground pr-2', visibility.teams)}>
                            <span className="truncate">{u.teams.length > 0 ? u.teams.join(', ') : '—'}</span>
                        </div>

                        <div className={cn('items-center text-muted-foreground pr-2', visibility.lastActive)}>
                            {u.lastActiveAt ? formatTimeAgo(u.lastActiveAt) : '—'}
                        </div>

                        <div className={cn('items-center text-muted-foreground pr-2', visibility.joined)}>
                            {formatDate(u.createdAt)}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}
