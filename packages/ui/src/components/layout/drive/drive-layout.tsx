import {useCallback, useMemo} from "react";
import {DrivePath} from "@workspace/lib/types/drive";
import {LoadingState} from "../app/loading-state";
import {DriveList, DriveListToolbar} from "./drive-list";
import {DriveDetail, DriveDetailToolbar} from "./drive-detail";
import {defaultDriveSort} from "./drive-table";
import {DriveAccessDialog} from "./drive-access-dialog";
import {DriveCreateDoc} from "./drive-create-doc";
import {DriveCreateStickies} from "./drive-create-stickies";
import {DriveCreateChat} from "./drive-create-chat";
import {DriveCreateSlides} from "./drive-create-slides";
import {DriveCreateSheets} from "./drive-create-sheets";
import {DriveDeleteItem} from "./drive-delete-item";
import {DriveUploadFiles} from "./drive-upload-files";
import {DriveCreateFolder} from "./drive-create-folder";
import {DriveRenameItem} from "./drive-rename-item";
import {useMovePath} from "@workspace/lib/drive";
import {useDriveDialogs} from "./use-drive-dialogs";
import {getDriveDownloadUrl} from "@workspace/lib/api";
import {Column, ColumnLayout} from "../app/column-layout.tsx";
import {useLayout} from "../app/layout-context.tsx";

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
    allowCreateChat?: boolean;
    allowCreateSlides?: boolean;
    allowCreateSheets?: boolean;
    allowRename?: boolean;
    allowMove?: boolean;
    onQuickLook?: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
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
                                allowCreateChat = true,
                                allowCreateSlides = true,
                                allowCreateSheets = true,
                                allowUpload = true,
                                allowRename = true,
                                allowMove = true,
                                onQuickLook,
                                sortFn = defaultDriveSort,
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

    const handleDeletePaths = (paths: DrivePath[]) => {
        if (allowDelete && paths.length > 0) {
            dialogs.delete.openDialog(paths);
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

    const sortedContents = useMemo(() => [...folderContents].sort(sortFn), [folderContents, sortFn]);

    const wrappedQuickLook = useCallback((path: DrivePath) => {
        onQuickLook?.(path, sortedContents);
    }, [onQuickLook, sortedContents]);

    if (isLoading) {
        return <LoadingState/>;
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
        onDelete: allowDelete ? handleDeletePaths : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onCreateDoc: allowCreateDoc ? dialogs.createDoc.openDialog : undefined,
        onCreateStickies: allowCreateStickies ? dialogs.createStickies.openDialog : undefined,
        onCreateChat: allowCreateChat ? dialogs.createChat.openDialog : undefined,
        onCreateSlides: allowCreateSlides ? dialogs.createSlides.openDialog : undefined,
        onCreateSheets: allowCreateSheets ? dialogs.createSheets.openDialog : undefined,
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
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        sortFn,
    };

    const listToolbar = (
        <DriveListToolbar
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            showBreadcrumb={showBreadcrumb}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            activeRowId={pid}
            onCreateFolder={allowCreateFolder ? dialogs.createFolder.openDialog : undefined}
            onUploadFile={allowUpload ? handleFileUpload : undefined}
            onCreateDoc={allowCreateDoc ? dialogs.createDoc.openDialog : undefined}
            onCreateStickies={allowCreateStickies ? dialogs.createStickies.openDialog : undefined}
            onCreateChat={allowCreateChat ? dialogs.createChat.openDialog : undefined}
            onCreateSlides={allowCreateSlides ? dialogs.createSlides.openDialog : undefined}
            onCreateSheets={allowCreateSheets ? dialogs.createSheets.openDialog : undefined}
        />
    );

    const detailPath = selectedPath || currentPath;

    const detailProps = {
        path: detailPath,
        onDelete: allowDelete ? (p: DrivePath) => handleDeletePaths([p]) : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onDownload: handleDownloadPath,
        onItemOpen: onRowActivate,
        allowDelete,
        onRename: allowRename ? handleRenamePath : undefined,
    };

    const mobileShowDetail = !!(selectedPath || (currentPath && currentPath?.type !== 'folder'));
    const pidInFolder = pid ? folderContents.some(p => p.id === pid) : false;
    const desktopShowDetail = !!(pidInFolder || (currentPath && currentPath?.type !== 'folder'));
    const showDetail = isMobile ? mobileShowDetail : desktopShowDetail;

    const detailToolbar = (showDetail && detailPath) ? (
        <DriveDetailToolbar
            path={detailPath}
            onClose={onBackToList}
            onDelete={allowDelete ? (p: DrivePath) => handleDeletePaths([p]) : undefined}
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
                <Column id="list" width="flex" toolbar={listToolbar}>
                    <DriveList {...listProps} />
                </Column>
                {showDetail && (
                    <Column id="detail" width={isMobile ? 'flex' : '400px'} onBack={onBackToList}
                            toolbar={detailToolbar}>
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

            {allowCreateChat && currentPath && (
                <DriveCreateChat
                    path={currentPath}
                    open={dialogs.createChat.open}
                    onOpenChange={dialogs.createChat.setOpen}
                    onSave={dialogs.createChat.closeDialog}
                    onCancel={dialogs.createChat.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowCreateSlides && currentPath && (
                <DriveCreateSlides
                    path={currentPath}
                    open={dialogs.createSlides.open}
                    onOpenChange={dialogs.createSlides.setOpen}
                    onSave={dialogs.createSlides.closeDialog}
                    onCancel={dialogs.createSlides.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowCreateSheets && currentPath && (
                <DriveCreateSheets
                    path={currentPath}
                    open={dialogs.createSheets.open}
                    onOpenChange={dialogs.createSheets.setOpen}
                    onSave={dialogs.createSheets.closeDialog}
                    onCancel={dialogs.createSheets.closeDialog}
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
                    paths={dialogs.delete.items}
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
