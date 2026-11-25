// The dialog that adds users to a team one click at a time, from a team's Members section. It searches the users
// who are not members yet, and a click adds that one through useAddTeamMembers while the dialog stays open for the
// next.

import { useAddTeamMembers } from '@workspace/lib/admin';
import type { OrgMember } from '@workspace/lib/types/admin';
import { Button } from '@workspace/ui/components/button';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { UserItem } from '@workspace/ui/components/user';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

type AddMemberDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    teamId: string;
    availableMembers: readonly OrgMember[];
};

export function AddMemberDialog({ open, onOpenChange, teamId, availableMembers }: AddMemberDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Add member to team"
            description="Search your users and add one to the team."
        >
            {/* Mounted with the dialog, so each opening starts with an empty search. */}
            <MemberPicker teamId={teamId} availableMembers={availableMembers} />
        </FormDialog>
    );
}

function MemberPicker({ teamId, availableMembers }: { teamId: string; availableMembers: readonly OrgMember[] }) {
    const [search, setSearch] = useState('');
    const addMembers = useAddTeamMembers();

    const filtered = useMemo(() => {
        const sorted = [...availableMembers].sort((a, b) => a.name.localeCompare(b.name));
        if (!search) return sorted;
        const q = search.toLowerCase();
        return sorted.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
    }, [availableMembers, search]);

    return (
        <>
            <Input
                aria-label="Search users"
                placeholder="Search by name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
            />
            <div className="app-gutter-bleed max-h-64 overflow-y-auto">
                {filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                        {availableMembers.length === 0
                            ? 'All members are already in this team.'
                            : 'No members match your search.'}
                    </p>
                ) : (
                    filtered.map((m) => {
                        const adding = addMembers.isPending && !!addMembers.variables?.userIds.includes(m.userId);
                        return (
                            <Button
                                key={m.userId}
                                variant="ghost"
                                pending={adding}
                                disabled={addMembers.isPending && !adding}
                                className="h-auto w-full justify-start gap-3 px-2 py-2 text-left font-normal"
                                onClick={() => {
                                    addMembers.mutate({ teamId, userIds: [m.userId] });
                                    setSearch('');
                                }}
                            >
                                <UserItem name={m.name} email={m.email} userId={m.userId} className="flex-1 min-w-0" />
                                {!adding && <Plus className="text-muted-foreground" />}
                            </Button>
                        );
                    })
                )}
            </div>
        </>
    );
}
