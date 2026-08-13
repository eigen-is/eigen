import type { OrgMember } from '@workspace/lib/types/admin';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { UserItem } from '@workspace/ui/components/user/user-item';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

type AddMemberDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    availableMembers: OrgMember[];
    onAdd: (userId: string) => void;
};

export function AddMemberDialog({ open, onOpenChange, availableMembers, onAdd }: AddMemberDialogProps) {
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        const sorted = [...availableMembers].sort((a, b) => a.name.localeCompare(b.name));
        if (!search) return sorted;
        const q = search.toLowerCase();
        return sorted.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
    }, [availableMembers, search]);

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                onOpenChange(v);
                if (!v) setSearch('');
            }}
        >
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Add Member to Team</DialogTitle>
                </DialogHeader>
                <Input
                    placeholder="Search by name or email..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                />
                <div className="max-h-64 overflow-y-auto -mx-2">
                    {filtered.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                            {availableMembers.length === 0
                                ? 'All members are already in this team.'
                                : 'No members match your search.'}
                        </p>
                    ) : (
                        filtered.map((m) => (
                            <button
                                key={m.userId}
                                type="button"
                                className="flex w-full items-center gap-3 px-2 py-2 rounded-md cursor-pointer text-left hover:bg-accent"
                                onClick={() => {
                                    onAdd(m.userId);
                                    setSearch('');
                                }}
                            >
                                <UserItem name={m.name} email={m.email} userId={m.userId} className="flex-1 min-w-0" />
                                <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                            </button>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
