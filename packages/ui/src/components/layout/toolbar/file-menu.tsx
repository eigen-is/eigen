import { formatForDisplay } from '@tanstack/react-hotkeys';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { fetchRevisionState, useCollabRevisions } from '@workspace/lib/collab';
import { formatDateTime } from '@workspace/lib/date';
import { useRootFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ConfirmDialog } from '@workspace/ui/components/layout/delete/confirm-dialog';
import { Download, FileText, Folder, History, Mail, Pencil, Trash2, UserRoundPlus } from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { DriveDeleteItem } from '../drive/drive-delete-item';
import { DriveEmailCollaborators } from '../drive/drive-email-collaborators';
import { DriveRenameItem } from '../drive/drive-rename-item';

type FileMenuProps = {
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore?: (state: Uint8Array) => void;
    onExport?: (format: string) => void;
    createLabel: string;
    CreateDialog: ComponentType<{ path: DrivePath; open: boolean; onOpenChange: (open: boolean) => void }>;
    children?: ReactNode;
};

export function FileMenu({
    path,
    canWrite,
    onAccessDialogOpen,
    onRestore,
    onExport,
    createLabel,
    CreateDialog,
    children,
}: FileMenuProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [emailOpen, setEmailOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingRevisionId, setPendingRevisionId] = useState<number | null>(null);
    const { user } = useAuth();
    const { data: rootFolder } = useRootFolder(user?.id || '');
    const { data: revisions } = useCollabRevisions(path.ownerId, path.mountId, path.id, menuOpen && !!onRestore);
    const navigate = useNavigate();

    const handleRevisionClick = (revisionId: number) => {
        setPendingRevisionId(revisionId);
        setMenuOpen(false);
        setConfirmOpen(true);
    };

    const handleConfirmRestore = async () => {
        if (pendingRevisionId === null || !onRestore) return;
        const state = await fetchRevisionState(path.ownerId, path.mountId, path.id, pendingRevisionId);
        if (!state) return;
        onRestore(state);
        setConfirmOpen(false);
        setPendingRevisionId(null);
    };

    return (
        <>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost">File</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => rootFolder && setCreateOpen(true)}>
                        <FileText className="h-4 w-4 mr-2" /> {createLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate({ to: `/` })}>
                        <Folder className="h-4 w-4 mr-2" /> Open
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                        <Pencil className="h-4 w-4 mr-2" /> Rename
                    </DropdownMenuItem>
                    {onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Download className="h-4 w-4 mr-2" /> Export
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <DropdownMenuItem onClick={() => onExport('docx')}>Export as DOCX</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onExport('pdf')}>Export as PDF</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onExport('html')}>Export as HTML</DropdownMenuItem>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onAccessDialogOpen}>
                        <UserRoundPlus className="h-4 w-4 mr-2" /> Edit access
                    </DropdownMenuItem>
                    {canWrite && (
                        <DropdownMenuItem onClick={() => setEmailOpen(true)}>
                            <Mail className="h-4 w-4 mr-2" /> Email collaborators
                        </DropdownMenuItem>
                    )}
                    {onRestore && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <History className="h-4 w-4 mr-2" /> Version history
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-64 overflow-y-auto min-w-[240px]">
                                {revisions && revisions.length > 0 ? (
                                    revisions.map((rev) => (
                                        <DropdownMenuItem
                                            key={rev.id}
                                            className="flex items-center justify-between gap-4"
                                            onClick={() => handleRevisionClick(rev.id)}
                                        >
                                            <span>
                                                {rev.createdAt
                                                    ? formatDateTime(new Date(rev.createdAt))
                                                    : `Revision #${rev.id}`}
                                            </span>
                                            <span className="text-xs text-muted-foreground">Restore</span>
                                        </DropdownMenuItem>
                                    ))
                                ) : (
                                    <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                                )}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    {children}
                    {canWrite && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                                <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            {rootFolder && <CreateDialog path={rootFolder} open={createOpen} onOpenChange={setCreateOpen} />}
            <DriveRenameItem path={path} open={renameOpen} onOpenChange={setRenameOpen} />
            <DriveEmailCollaborators path={path} open={emailOpen} onOpenChange={setEmailOpen} />
            <DriveDeleteItem
                paths={[path]}
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                onAfterAction={(actionType) => {
                    if (actionType === 'delete') navigate({ to: `/` });
                }}
            />
            {onRestore && (
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
            )}
        </>
    );
}
