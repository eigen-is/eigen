import {type ComponentType, type ReactNode, useState} from 'react';
import {FileText, Folder, Pencil, Trash2, UserRoundPlus} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {useNavigate} from '@tanstack/react-router';
import {useAuth} from '@workspace/lib/auth';
import {useRootFolder} from '@workspace/lib/drive';
import {DriveDeleteItem} from '../drive/drive-delete-item';
import {DriveRenameItem} from '../drive/drive-rename-item';
import type {DrivePath} from '@workspace/lib/types/drive';

type FileMenuProps = {
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    createLabel: string;
    CreateDialog: ComponentType<{ path: DrivePath; open: boolean; onOpenChange: (open: boolean) => void }>;
    children?: ReactNode;
}

export function FileMenu({path, canWrite, onAccessDialogOpen, createLabel, CreateDialog, children}: FileMenuProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
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
                    <DropdownMenuItem onClick={() => rootFolder && setCreateOpen(true)}>
                        <FileText className="h-4 w-4 mr-2"/> {createLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate({to: `/`})}>
                        <Folder className="h-4 w-4 mr-2"/> Open
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                        <Pencil className="h-4 w-4 mr-2"/> Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={onAccessDialogOpen}>
                        <UserRoundPlus className="h-4 w-4 mr-2"/> Edit access
                    </DropdownMenuItem>
                    {children}
                    {canWrite && (
                        <>
                            <DropdownMenuSeparator/>
                            <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                                <Trash2 className="h-4 w-4 mr-2"/> Delete
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            {rootFolder && (
                <CreateDialog path={rootFolder} open={createOpen} onOpenChange={setCreateOpen}/>
            )}
            <DriveRenameItem path={path} open={renameOpen} onOpenChange={setRenameOpen}/>
            <DriveDeleteItem
                paths={[path]}
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                onAfterAction={(actionType) => {
                    if (actionType === 'delete') navigate({to: `/`});
                }}
            />
        </>
    );
}
