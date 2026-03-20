import {useState} from 'react';
import {History} from 'lucide-react';
import {formatForDisplay} from '@tanstack/react-hotkeys';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {Tooltip, TooltipContent, TooltipTrigger} from '@workspace/ui/components/tooltip';
import {ConfirmDialog} from '@workspace/ui/components/layout/delete/confirm-dialog';
import {fetchRevisionState, useCollabRevisions} from '@workspace/lib/collab';
import {formatDateTime} from '@workspace/lib/date';
import type {DrivePath} from '@workspace/lib/types/drive';

type RevisionHistoryProps = {
    path: DrivePath;
    onRestore: (state: Uint8Array) => void;
}

export function RevisionHistory({path, onRestore}: RevisionHistoryProps) {
    const [open, setOpen] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingRevisionId, setPendingRevisionId] = useState<number | null>(null);
    const {data: revisions} = useCollabRevisions(path.ownerId, path.mountId, path.id, open);

    const handleRevisionClick = (revisionId: number) => {
        setPendingRevisionId(revisionId);
        setOpen(false);
        setConfirmOpen(true);
    };

    const handleConfirmRestore = async () => {
        if (pendingRevisionId === null) return;
        const state = await fetchRevisionState(path.ownerId, path.mountId, path.id, pendingRevisionId);
        if (!state) return;
        onRestore(state);
        setConfirmOpen(false);
        setPendingRevisionId(null);
    };

    return (
        <>
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <History className="h-4 w-4"/>
                            </TooltipTrigger>
                            <TooltipContent>Version history</TooltipContent>
                        </Tooltip>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto min-w-[240px]">
                    {revisions && revisions.length > 0 ? revisions.map((rev) => (
                        <DropdownMenuItem
                            key={rev.id}
                            className="flex items-center justify-between gap-4"
                            onClick={() => handleRevisionClick(rev.id)}
                        >
                            <span>{rev.createdAt ? formatDateTime(new Date(rev.createdAt)) : `Revision #${rev.id}`}</span>
                            <span className="text-xs text-muted-foreground">Restore</span>
                        </DropdownMenuItem>
                    )) : (
                        <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={(value) => {
                    setConfirmOpen(value);
                    if (!value) setPendingRevisionId(null);
                }}
                title="Restore revision"
                description={`This will replace the current document content with the selected revision for all collaborators. Use ${formatForDisplay('Mod+Z')} to undo after restoring.`}
                confirmText="Restore"
                onConfirm={handleConfirmRestore}
            />
        </>
    );
}

