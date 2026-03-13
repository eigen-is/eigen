import {useState} from 'react';
import {
    FileText,
    Folder,
    Pencil,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {TooltipButton} from '@workspace/ui';
import {DocumentModeButton} from '@workspace/ui/components/layout/toolbar/document-mode-button';
import {RevisionHistory} from '@workspace/ui/components/layout/collab/revision-history';
import {DriveCreateSheets} from '@workspace/ui/components/layout/drive/drive-create-sheets';
import {DriveDeleteItem} from '@workspace/ui/components/layout/drive/drive-delete-item';
import {DriveRenameItem} from '@workspace/ui/components/layout/drive/drive-rename-item';
import {useNavigate} from '@tanstack/react-router';
import {useAuth} from '@workspace/lib/auth';
import {useRootFolder} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';

type ToolbarItemsProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
}

export function ToolbarLeftItems({path, onAccessDialogOpen, canWrite}: ToolbarItemsProps) {
    const [createSheetsOpen, setCreateSheetsOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const {user} = useAuth();
    const {data: rootFolder} = useRootFolder(user?.id || '');
    const navigate = useNavigate();

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost">File</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => rootFolder && setCreateSheetsOpen(true)}>
                        <FileText className="w-4 h-4 mr-2"/> New sheet
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

            {rootFolder && (
                <DriveCreateSheets
                    path={rootFolder}
                    open={createSheetsOpen}
                    onOpenChange={setCreateSheetsOpen}
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
        </>
    );
}

export function ToolbarRightItems({path, canWrite, onAccessDialogOpen, onRestore}: ToolbarItemsProps) {
    return (
        <>
            <RevisionHistory path={path} onRestore={onRestore}/>
            {canWrite ? (
                <TooltipButton
                    icon={UserRoundPlus}
                    tooltipText="Share"
                    onClick={onAccessDialogOpen}
                />
            ) : (
                <DocumentModeButton canWrite={canWrite}/>
            )}
        </>
    );
}
