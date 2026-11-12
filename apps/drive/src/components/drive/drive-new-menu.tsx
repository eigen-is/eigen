// The New button at the top of the Drive sidebar: a menu that creates a folder or a document, or uploads files, into
// the folder the user has open, else the drive root. The app shell draws it. After a new folder or an upload, the
// view moves to the folder it went into.

import { useMatch, useNavigate } from '@tanstack/react-router';
import { DEFAULT_MOUNT_ID, usePathInfo } from '@workspace/lib/drive';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { DriveCreateEigenDoc, useDriveUploadFiles } from '@workspace/ui/components/drive';
import { getCreateMenuItems } from '@workspace/ui/components/drive/create-menu';
import { DriveCreateFolder } from '@workspace/ui/components/drive/drive-create-folder';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { Plus } from 'lucide-react';
import { useState } from 'react';

type DriveNewMenuProps = {
    rootPath: DrivePath | null;
    condensed?: boolean;
};

export function DriveNewMenu({ rootPath, condensed = false }: DriveNewMenuProps) {
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [createType, setCreateType] = useState<EigenDocType | null>(null);
    const navigate = useNavigate();

    const routeMatch = useMatch({
        from: '/_auth/fs/$ownerId/$mountId/$pathId',
        shouldThrow: false,
    });

    const currentPathId = routeMatch?.params.pathId;
    const currentOwnerId = routeMatch?.params.ownerId;
    const currentMountId = routeMatch?.params.mountId;

    const { data: currentPath } = usePathInfo(
        currentOwnerId || rootPath?.ownerId || '',
        currentMountId || rootPath?.mountId || DEFAULT_MOUNT_ID,
        currentPathId || rootPath?.id || '',
    );

    const targetPath = currentPath || rootPath;

    const handleAfterAction = () => {
        navigate({
            to: '/fs/$ownerId/$mountId/$pathId',
            params: {
                ownerId: targetPath?.ownerId || '',
                mountId: targetPath?.mountId || DEFAULT_MOUNT_ID,
                pathId: targetPath?.id || '',
            },
        });
    };

    const uploads = useDriveUploadFiles(targetPath, handleAfterAction);

    const createItems = getCreateMenuItems({
        onCreateFolder: () => setCreateFolderOpen(true),
        onUploadFile: uploads.pickFiles,
        onCreateEigenDoc: Object.fromEntries(
            Object.values(EIGEN_DOC_TYPE_INFO).map((i) => [i.type, () => setCreateType(i.type)]),
        ),
    });

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <SidebarPrimaryButton icon={Plus} label="New" condensed={condensed} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align={condensed ? 'center' : 'start'}>
                    {createItems.map(({ kind, icon: Icon, label, onSelect }) => (
                        <DropdownMenuItem key={kind} onClick={onSelect}>
                            <Icon className="h-4 w-4" />
                            {label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>

            <DriveCreateFolder
                open={createFolderOpen}
                onOpenChange={setCreateFolderOpen}
                defaultOwnerId={targetPath?.ownerId}
                defaultFolderId={targetPath?.id}
                defaultMountId={targetPath?.mountId}
                onAfterCreate={handleAfterAction}
            />

            {createType && (
                <DriveCreateEigenDoc
                    type={createType}
                    open
                    onOpenChange={(open) => {
                        if (!open) setCreateType(null);
                    }}
                    defaultOwnerId={targetPath?.ownerId}
                    defaultFolderId={targetPath?.id}
                    defaultMountId={targetPath?.mountId}
                />
            )}

            {targetPath && uploads.input}
        </>
    );
}
