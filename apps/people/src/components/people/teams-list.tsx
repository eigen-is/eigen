import {useMemo, useRef, useState} from 'react';
import {cn} from '@workspace/ui/lib/utils';
import {SearchBar} from '@workspace/ui/components/layout/search-bar/search-bar';
import {useKeyboardListNavigation} from '@workspace/ui/hooks/use-keyboard-list-navigation';
import {useListSelection} from '@workspace/ui/hooks/use-list-selection';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Plus} from 'lucide-react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {useCreateTeam} from '@workspace/lib/people';
import {toast} from 'sonner';
import type {OrgTeam} from '@workspace/lib/types/people';
import {UserAvatar} from "@workspace/ui/components/layout/user-avatar.tsx";
import {teamOwnerId} from "@workspace/lib/types";

interface TeamsListToolbarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    organizationId?: string;
}

export function TeamsListToolbar({searchQuery, onSearchChange, organizationId}: TeamsListToolbarProps) {
    const [showCreate, setShowCreate] = useState(false);
    const [newTeamName, setNewTeamName] = useState('');
    const createTeam = useCreateTeam(organizationId);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTeamName.trim()) return;
        try {
            await createTeam.mutateAsync(newTeamName.trim());
            toast.success(`Team "${newTeamName.trim()}" created`);
            setNewTeamName('');
            setShowCreate(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to create team');
        }
    };

    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder="Search teams..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-white"
            />
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4"/>
            </Button>
            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Team</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <Input
                            placeholder="Team name"
                            value={newTeamName}
                            onChange={e => setNewTeamName(e.target.value)}
                            autoFocus
                            required
                        />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                            <Button type="submit" disabled={createTeam.isPending}>
                                {createTeam.isPending ? 'Creating...' : 'Create'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}

interface TeamsListProps {
    teams: OrgTeam[];
    searchQuery: string;
    activeTeamId?: string;
    onRowClick: (teamId: string) => void;
}

export function TeamsList({teams, searchQuery, activeTeamId, onRowClick}: TeamsListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    const filteredTeams = useMemo(() => {
        if (!searchQuery) return teams;
        const q = searchQuery.toLowerCase();
        return teams.filter(t => t.name.toLowerCase().includes(q));
    }, [teams, searchQuery]);

    const selection = useListSelection({items: filteredTeams, getId: (t) => t.id});

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
        items: filteredTeams,
        activeId: activeTeamId,
        getId: (t) => t.id,
        onSelect: (id) => onRowClick(id),
        containerRef: listRef,
        selection,
    });

    if (filteredTeams.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <p>{searchQuery ? 'No teams match your search.' : 'No teams yet. Create one to get started.'}</p>
            </div>
        );
    }

    return (
        <div
            className="flex-1 overflow-y-auto outline-none"
            ref={listRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
        >
            {filteredTeams.map((team, index) => (
                <div
                    key={team.id}
                    className={cn(
                        "flex items-center gap-3 px-4 py-3 eigen-list-item",
                        (activeTeamId === team.id || selectedIndex === index) && "eigen-list-item-active",
                        selection.isSelected(team.id) && "eigen-list-item-selected",
                    )}
                    onClick={(e) => {
                        selection.handleItemClick(team.id, e);
                        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                            onRowClick(team.id);
                        }
                    }}
                >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                        <UserAvatar userId={teamOwnerId(team.id)}/>
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{team.name}</p>
                        <p className="text-xs text-muted-foreground">
                            Created {team.createdAt.toLocaleDateString()}
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
}
