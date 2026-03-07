import {useState} from 'react';
import {History} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {Tooltip, TooltipContent, TooltipTrigger} from '@workspace/ui/components/tooltip';
import {fetchRevisionState, useCollabRevisions} from '@workspace/lib/collab';
import {formatDateTime} from '@workspace/lib/date';
import type {DrivePath} from '@workspace/lib/types/drive';

type RevisionHistoryProps = {
    path: DrivePath;
    onRestore: (state: Uint8Array) => void;
}

export function RevisionHistory({path, onRestore}: RevisionHistoryProps) {
    const [open, setOpen] = useState(false);
    const {data: revisions} = useCollabRevisions(path.ownerId, path.mountId, path.id, open);

    const handleRestore = async (revisionId: number) => {
        const state = await fetchRevisionState(path.ownerId, path.mountId, path.id, revisionId);
        if (!state) return;
        onRestore(state);
        setOpen(false);
    };

    return (
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
                        onClick={() => handleRestore(rev.id)}
                    >
                        <span>{rev.createdAt ? formatDateTime(new Date(rev.createdAt)) : `Revision #${rev.id}`}</span>
                        <span className="text-xs text-muted-foreground">Restore</span>
                    </DropdownMenuItem>
                )) : (
                    <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

