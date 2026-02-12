import {DrivePath} from "@workspace/lib/types/drive";
import {EigenLoader} from "@workspace/ui";
import {DriveList} from "./drive-list";
import {DriveDetail, DriveDetailToolbar} from "./drive-detail";
import {DriveAccessDialog} from "./drive-access-dialog";
import {DriveCreateDoc} from "./drive-create-doc";
import {DriveCreateStickies} from "./drive-create-stickies";
import {DriveDeleteItem} from "./drive-delete-item";
import {DriveUploadFiles} from "./drive-upload-files";
import {DriveCreateFolder} from "./drive-create-folder";
import {DriveRenameItem} from "./drive-rename-item";
import {useMovePath} from "@workspace/lib/drive";
import {useDriveDialogs} from "./use-drive-dialogs";
import {getDriveDownloadUrl} from "@workspace/lib/api";
import {ColumnLayout, Column} from "../column-layout";
import {useLayout} from "../layout-context";

export type DriveLayoutProps = {
    ownerId: string;
    mountId: string;
    pathId?: string;
    folderContents: DrivePath[];
    isLoading: boolean;
    error: any;
    selectedPath?: DrivePath | null;
    currentPath?: DrivePath | null;
    onRowSelect: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    onBackToList: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
    allowCreateFolder?: boolean;
    allowDelete?: boolean;
    allowShare?: boolean;
    showBreadcrumb?: boolean;
    allowUpload?: boolean;
    allowCreateDoc?: boolean;
    allowCreateStickies?: boolean;
    allowRename?: boolean;
    allowMove?: boolean;
    pid?: string;
}

export function DriveLayout({
                                ownerId,
                                mountId,
                                folderContents,
                                isLoading,
                                error,
                                onRowSelect,
                                onRowActivate,
                                onBackToList,
                                onAfterAction,
                                pathId = 'unknown',
                                selectedPath = null,
                                currentPath = null,
                                allowCreateFolder = true,
                                allowDelete = true,
                                allowShare = true,
                                allowCreateDoc = true,
                                allowCreateStickies = true,
                                allowUpload = true,
                                allowRename = true,
                                allowMove = true,
                                pid = undefined,
                                showBreadcrumb = false,
                            }: DriveLayoutProps) {
    const {isMobile} = useLayout();
    const dialogs = useDriveDialogs();
    const movePath = useMovePath(ownerId, mountId, currentPath?.id);

    const handleFileUpload = () => {
        if (allowUpload && currentPath) {
            dialogs.upload.openDialog();
        }
    };

    const handleUploadFiles = (files: File[]) => {
        if (allowUpload && currentPath && files.length > 0) {
            dialogs.upload.openDialog(files);
        }
    };

    const handleDeletePath = (path: DrivePath) => {
        if (allowDelete) {
            dialogs.delete.openDialog(path);
        }
    };

    const handleRenamePath = (path: DrivePath) => {
        if (allowRename) {
            dialogs.rename.openDialog(path);
        }
    };

    const handleMovePath = async (path: DrivePath, targetItemId: string) => {
        if (!allowMove) return;
        await movePath.mutateAsync({pathId: path.id, targetParentId: targetItemId});
    };

    const handleDownloadPath = (path: DrivePath) => {
        if (path?.type === 'file' && path.id) {
            const downloadUrl = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = path.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    const handleShareClick = (path: DrivePath) => {
        if (allowShare) {
            dialogs.share.openDialog(path);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    const listProps = {
        items: folderContents,
        isLoading,
        error,
        onRowSelect,
        onRowActivate,
        activeRowId: pid,
        onCreateFolder: allowCreateFolder ? dialogs.createFolder.openDialog : undefined,
        onUploadFile: allowUpload ? handleFileUpload : undefined,
        onUploadFiles: allowUpload ? handleUploadFiles : undefined,
        onDelete: allowDelete ? handleDeletePath : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onCreateDoc: allowCreateDoc ? dialogs.createDoc.openDialog : undefined,
        onCreateStickies: allowCreateStickies ? dialogs.createStickies.openDialog : undefined,
        currentPath,
        ownerId,
        mountId,
        pathId,
        showBreadcrumb,
        onDownload: handleDownloadPath,
        allowDelete,
        allowUpload,
        onRename: allowRename ? handleRenamePath : undefined,
        onMove: allowMove ? handleMovePath : undefined,
    };

    const detailPath = selectedPath || currentPath;

    const detailProps = {
        path: detailPath,
        onDelete: allowDelete ? handleDeletePath : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onDownload: handleDownloadPath,
        onItemOpen: onRowActivate,
        allowDelete,
        onRename: allowRename ? handleRenamePath : undefined,
    };

    const mobileShowDetail = !!(selectedPath || (currentPath && currentPath?.type !== 'folder'));
    const desktopShowDetail = !!(pid || (currentPath && currentPath?.type !== 'folder'));
    const showDetail = isMobile ? mobileShowDetail : desktopShowDetail;

    const detailToolbar = (showDetail && detailPath) ? (
        <DriveDetailToolbar
            path={detailPath}
            onClose={onBackToList}
            onDelete={allowDelete ? handleDeletePath : undefined}
            onShareClick={allowShare ? handleShareClick : undefined}
            onDownload={handleDownloadPath}
            onItemOpen={onRowActivate}
            onRename={allowRename ? handleRenamePath : undefined}
            allowDelete={allowDelete}
        />
    ) : null;

    return (
        <>
            <ColumnLayout mobileColumn={mobileShowDetail ? 'detail' : 'list'}>
                <Column id="list" width="flex">
                    <div className="h-full overflow-hidden border-r">
                        <DriveList {...listProps} />
                    </div>
                </Column>
                {showDetail && (
                    <Column id="detail" width={isMobile ? 'flex' : '400px'} onBack={onBackToList} toolbar={detailToolbar}>
                        <DriveDetail {...detailProps} />
                    </Column>
                )}
            </ColumnLayout>

            {allowCreateFolder && currentPath && (
                <DriveCreateFolder
                    path={currentPath}
                    open={dialogs.createFolder.open}
                    onOpenChange={dialogs.createFolder.setOpen}
                    onSave={dialogs.createFolder.closeDialog}
                    onCancel={dialogs.createFolder.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowCreateDoc && currentPath && (
                <DriveCreateDoc
                    path={currentPath}
                    open={dialogs.createDoc.open}
                    onOpenChange={dialogs.createDoc.setOpen}
                    onSave={dialogs.createDoc.closeDialog}
                    onCancel={dialogs.createDoc.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowCreateStickies && currentPath && (
                <DriveCreateStickies
                    path={currentPath}
                    open={dialogs.createStickies.open}
                    onOpenChange={dialogs.createStickies.setOpen}
                    onSave={dialogs.createStickies.closeDialog}
                    onCancel={dialogs.createStickies.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowUpload && currentPath && (
                <DriveUploadFiles
                    path={currentPath}
                    open={dialogs.upload.open}
                    onOpenChange={dialogs.upload.setOpen}
                    initialFiles={dialogs.upload.files}
                    onAfterUpload={dialogs.upload.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowDelete && (
                <DriveDeleteItem
                    path={dialogs.delete.item}
                    open={dialogs.delete.open}
                    onOpenChange={dialogs.delete.setOpen}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowRename && (
                <DriveRenameItem
                    path={dialogs.rename.item}
                    open={dialogs.rename.open}
                    onOpenChange={dialogs.rename.setOpen}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowShare && (
                <DriveAccessDialog
                    open={dialogs.share.open}
                    onOpenChange={dialogs.share.setOpen}
                    path={dialogs.share.item}
                />
            )}
        </>
    );
}
