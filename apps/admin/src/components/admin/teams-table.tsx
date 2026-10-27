// The list of the organization's teams on the Admin app's teams page, with the toolbar above it that
// searches the list and creates a team. A click on a row opens that team's detail. The table follows
// the users table: sortable headers, and columns that appear as the list grows wider.

import { formatDate } from '@workspace/lib/date';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import type { SortDir } from '@workspace/ui';
import { EmptyState, nextSortDir, SearchBar, SortHeader, TooltipButton } from '@workspace/ui';
import { UserAvatar } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CreateTeamDialog } from './create-team-dialog';

type AdminTeamsToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    organizationId?: string;
};

export function AdminTeamsToolbar({ searchQuery, onSearchChange, organizationId }: AdminTeamsToolbarProps) {
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder="Search teams..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
            />
            <TooltipButton
                icon={Plus}
                tooltipText="Create team"
                className="shrink-0"
                onClick={() => setShowCreateDialog(true)}
            />
            <CreateTeamDialog
                open={showCreateDialog}
                onOpenChange={setShowCreateDialog}
                organizationId={organizationId}
            />
        </div>
    );
}

type SortCol = 'name' | 'created';
type SortState = { col: SortCol; dir: SortDir };

const DEFAULT_DIR: Record<SortCol, SortDir> = { name: 'asc', created: 'desc' };

const gridCols = cn('grid-cols-[minmax(0,1fr)]', '@[420px]:grid-cols-[minmax(0,1fr)_110px]');
const createdVisibility = 'hidden @[420px]:flex';

type AdminTeamsTableProps = {
    teams: OrgTeam[];
    searchQuery: string;
    activeTeamId?: string;
    onRowClick: (teamId: string) => void;
};

export function AdminTeamsTable({ teams, searchQuery, activeTeamId, onRowClick }: AdminTeamsTableProps) {
    const [sort, setSort] = useState<SortState>({ col: 'name', dir: 'asc' });

    const handleSort = (col: SortCol) => {
        setSort((prev) => ({ col, dir: nextSortDir(col, prev.col, prev.dir, DEFAULT_DIR).dir }));
    };

    const visible = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const filtered = q ? teams.filter((t) => t.name.toLowerCase().includes(q)) : teams;
        const compare = (a: OrgTeam, b: OrgTeam): number =>
            sort.col === 'name' ? a.name.localeCompare(b.name) : a.createdAt.getTime() - b.createdAt.getTime();
        const factor = sort.dir === 'asc' ? 1 : -1;
        return [...filtered].sort((a, b) => compare(a, b) * factor);
    }, [teams, searchQuery, sort]);

    if (visible.length === 0) {
        return <EmptyState message={searchQuery ? 'No teams match your search.' : 'No teams yet'} />;
    }

    return (
        <div className="@container flex-1 overflow-auto relative w-full text-sm focus:outline-none">
            <div className={cn('grid border-b app-gutter-x sticky top-0 z-10 bg-background', gridCols)}>
                <SortHeader
                    label="Name"
                    active={sort.col === 'name'}
                    dir={sort.dir}
                    onClick={() => handleSort('name')}
                    className="flex pr-2"
                />
                <SortHeader
                    label="Created"
                    active={sort.col === 'created'}
                    dir={sort.dir}
                    onClick={() => handleSort('created')}
                    className={cn('pr-2', createdVisibility)}
                />
            </div>

            {visible.map((team) => (
                <button
                    key={team.id}
                    type="button"
                    onClick={() => onRowClick(team.id)}
                    className={cn(
                        'grid w-full app-gutter-x items-center text-left eigen-list-item',
                        gridCols,
                        activeTeamId === team.id && 'eigen-list-item-active',
                    )}
                >
                    <div className="flex min-w-0 items-center gap-3 py-2 pr-2">
                        <UserAvatar userId={teamOwnerId(team.id)} name={team.name} size="sm" />
                        <div className="truncate font-medium text-foreground">{team.name}</div>
                    </div>
                    <div className={cn('items-center text-muted-foreground pr-2', createdVisibility)}>
                        {formatDate(team.createdAt)}
                    </div>
                </button>
            ))}
        </div>
    );
}
