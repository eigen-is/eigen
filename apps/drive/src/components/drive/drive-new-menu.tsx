import { useMatch, useNavigate } from '@tanstack/react-router';
import { DEFAULT_MOUNT_ID, usePathInfo } from '@workspace/lib/drive';
import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import { type DrivePath, EIGEN_DOC_TYPE_INFO, type EigenDocType } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { DriveCreateEigenDoc } from '@workspace/ui/components/layout/drive/drive-create-eigendoc';
import { DriveCreateFolder } from '@workspace/ui/components/layout/drive/drive-create-folder';
import { DriveUploadFiles } from '@workspace/ui/components/layout/drive/drive-upload-files';
import { FolderPlus, Plus, Upload as UploadIcon } from 'lucide-react';
import { useState } from 'react';

type DriveNewMenuProps = {
    rootPath: DrivePath | null;
    condensed?: boolean;
};

export function DriveNewMenu({ rootPath, condensed = false }: DriveNewMenuProps) {
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [createType, setCreateType] = useState<EigenDocType | null>(null);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
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

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setUploadFiles(Array.from(e.target.files));
            setUploadOpen(true);
        }
    };

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

    return (
        <>
            <div className="px-3 py-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="default"
                            size={condensed ? 'icon' : 'default'}
                            className={condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}
                        >
                            <Plus className="h-4 w-4" />
                            {!condensed && <span>New</span>}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={condensed ? 'center' : 'start'}>
                        <DropdownMenuItem onClick={() => setCreateFolderOpen(true)}>
                            <FolderPlus className="h-4 w-4 mr-2" />
                            New folder
                        </DropdownMenuItem>
                        {Object.values(EIGEN_DOC_TYPE_INFO).map((info) => {
                            const Icon = EIGEN_DOC_ICONS[info.type];
                            return (
                                <DropdownMenuItem key={info.type} onClick={() => setCreateType(info.type)}>
                                    <Icon className="h-4 w-4 mr-2" />
                                    New {info.label.toLowerCase()}
                                </DropdownMenuItem>
                            );
                        })}
                        <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                            <UploadIcon className="h-4 w-4 mr-2" />
                            Upload file
                            <input type="file" className="hidden" onChange={handleFileChange} />
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

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
                    initialFiles={uploadFiles}
                    onAfterUpload={() => setUploadFiles([])}
                    onAfterAction={handleAfterAction}
                />
            )}
        </>
    );
}
