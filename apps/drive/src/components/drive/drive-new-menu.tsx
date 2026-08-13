import { useMatch, useNavigate } from '@tanstack/react-router';
import { DEFAULT_MOUNT_ID, usePathInfo } from '@workspace/lib/drive';
import { type DrivePath, EIGEN_DOC_TYPE_INFO, type EigenDocType } from '@workspace/lib/types/drive';
import { getCreateMenuItems } from '@workspace/ui/components/drive/create-menu';
import { DriveCreateEigenDoc } from '@workspace/ui/components/drive/drive-create-eigendoc';
import { DriveCreateFolder } from '@workspace/ui/components/drive/drive-create-folder';
import { DriveUploadFiles } from '@workspace/ui/components/drive/drive-upload-files';
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
    const [uploadOpen, setUploadOpen] = useState(false);
    const navigate = useNavigate();

    const routeMatch = useMatch({
        from: '/_auth/fs/$ownerId/$mountId/$pathId',
        shouldThrow: false,
    });

    const currentPathId = routeMatch?.params?.pathId;
    const currentOwnerId = routeMatch?.params?.ownerId;
    const currentMountId = routeMatch?.params?.mountId;

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

    const createItems = getCreateMenuItems({
        onCreateFolder: () => setCreateFolderOpen(true),
        onUploadFile: () => setUploadOpen(true),
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
                            <Icon className="h-4 w-4 mr-2" />
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
                    open={true}
                    onOpenChange={(open) => {
                        if (!open) setCreateType(null);
                    }}
                    defaultOwnerId={targetPath?.ownerId}
                    defaultFolderId={targetPath?.id}
                    defaultMountId={targetPath?.mountId}
                />
            )}

            {targetPath && (
                <DriveUploadFiles
                    path={targetPath}
                    open={uploadOpen}
                    onOpenChange={setUploadOpen}
                    onAfterAction={handleAfterAction}
                />
            )}
        </>
    );
}
