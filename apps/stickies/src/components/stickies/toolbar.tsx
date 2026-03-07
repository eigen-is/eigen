import {useEffect, useState} from 'react';
import {formatForDisplay} from '@tanstack/react-hotkeys';
import {FileText, Folder, Pencil, Plus, Redo, Trash2, Undo, UserPlus, UserRoundPlus} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {Separator} from '@workspace/ui/components/separator';
import {TooltipButton} from '@workspace/ui';
import {DocumentModeButton} from '@workspace/ui/components/layout/toolbar/document-mode-button';
import {RevisionHistory} from '@workspace/ui/components/layout/collab/revision-history';
import * as Y from 'yjs';
import {useNavigate} from '@tanstack/react-router';
import {useAuth} from '@workspace/lib/auth';
import {useRootFolder} from '@workspace/lib/drive';
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';
import {DriveDeleteItem} from '@workspace/ui/components/layout/drive/drive-delete-item';
import {DriveRenameItem} from '@workspace/ui/components/layout/drive/drive-rename-item';
import type {DrivePath} from '@workspace/lib/types/drive';

type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    onAddColumn: () => void;
    path: DrivePath;
}

export function Toolbar({canWrite, undoManager, onAccessDialogOpen, onRestore, onAddColumn, path}: ToolbarProps) {
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const {user} = useAuth();
    const {data: rootFolder} = useRootFolder(user?.id || '');
    const navigate = useNavigate();

    useEffect(() => {
        if (!undoManager || !undoManager.undoStack || !canWrite) {
            setCanUndo(false);
            setCanRedo(false);
            return;
        }
        const update = () => {
            setCanUndo(undoManager.undoStack.length > 0);
            setCanRedo(undoManager.redoStack.length > 0);
        };
        update();
        undoManager.on('stack-item-added', update);
        undoManager.on('stack-item-popped', update);
        undoManager.on('stack-item-updated', update);
        return () => {
            undoManager.off('stack-item-added', update);
            undoManager.off('stack-item-popped', update);
            undoManager.off('stack-item-updated', update);
        };
    }, [undoManager, canWrite]);

    return (
        <div className="bg-white h-12 flex items-center justify-between px-4 border-b no-print">
            <div className="flex items-center gap-1">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" title="File">
                            File
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => rootFolder && setCreateStickiesOpen(true)}>
                            <FileText className="w-4 h-4 mr-2"/> New stickies
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate({to: `/`})}>
                            <Folder className="w-4 h-4 mr-2"/> Open
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => path && setRenameDialogOpen(true)}>
                            <Pencil className="w-4 h-4 mr-2"/> Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem onClick={onAccessDialogOpen}>
                            <UserRoundPlus className="w-4 h-4 mr-2"/> Edit access
                        </DropdownMenuItem>
                        {canWrite && (
                            <>
                                <DropdownMenuSeparator/>
                                <DropdownMenuItem onClick={() => path && setDeleteDialogOpen(true)}>
                                    <Trash2 className="w-4 h-4 mr-2"/> Delete
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
                {canWrite && (
                    <>
                        <Separator orientation="vertical" className="h-4"/>
                        <TooltipButton
                            icon={Undo}
                            tooltipText={`Undo (${formatForDisplay('Mod+Z')})`}
                            onClick={() => undoManager?.undo?.()}
                            disabled={!canUndo}
                        />
                        <TooltipButton
                            icon={Redo}
                            tooltipText={`Redo (${formatForDisplay('Mod+Y')})`}
                            onClick={() => undoManager?.redo?.()}
                            disabled={!canRedo}
                        />
                        <Separator orientation="vertical" className="h-4"/>
                        <TooltipButton
                            icon={Plus}
                            tooltipText="Add column"
                            onClick={onAddColumn}
                        />
                    </>
                )}
            </div>

            <div className="flex items-center gap-1">
                <RevisionHistory path={path} onRestore={onRestore}/>
                {canWrite ? (
                    <TooltipButton
                        icon={UserPlus}
                        tooltipText="Share"
                        onClick={onAccessDialogOpen}
                    />
                ) : (
                    <DocumentModeButton canWrite={canWrite}/>
                )}
            </div>

            {rootFolder && (
                <DriveCreateStickies
                    path={rootFolder}
                    open={createStickiesOpen}
                    onOpenChange={setCreateStickiesOpen}
                />
            )}

            {path && (
                <DriveDeleteItem
                    path={path}
                    open={deleteDialogOpen}
                    onOpenChange={setDeleteDialogOpen}
                    onAfterAction={(actionType) => {
                        if (actionType === 'delete') navigate({to: `/`});
                    }}
                />
            )}

            {path && (
                <DriveRenameItem
                    path={path}
                    open={renameDialogOpen}
                    onOpenChange={setRenameDialogOpen}
                />
            )}
        </div>
    );
}
