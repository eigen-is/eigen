import {useState} from "react";
import {DrivePath} from "@apps/api-server/types/drive";
import {EigenLoader} from "@workspace/ui";
import {DriveList} from "./drive-list";
import {DriveDetail} from "./drive-detail";
import {DriveAccessDialog} from "./drive-access-dialog";
import {DriveCreateDoc} from "./drive-create-doc";
import {DriveCreateStickies} from "./drive-create-stickies";
import {DriveDeleteItem} from "./drive-delete-item";
import {DriveUploadFiles} from "./drive-upload-files";
import {DriveCreateFolder} from "./drive-create-folder";

export interface DriveLayoutProps {
    // Required data
    ownerId: string;
    pathId?: string;

    // Data fetched by parent component
    folderContents: DrivePath[];
    isLoading: boolean;
    error: any;
    selectedPath?: DrivePath | null;
    currentPath?: DrivePath | null;

    // Navigation callbacks
    onRowSelect: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    onBackToList: () => void;
    onAfterAction?: (actionType: string, data: any) => void;

    // Feature flags
    allowCreateFolder?: boolean;
    allowDelete?: boolean;
    allowShare?: boolean;
    showBreadcrumb?: boolean;
    allowUpload?: boolean;
    allowCreateDoc?: boolean;
    allowCreateStickies?: boolean;

    // UI options
    isMobile?: boolean;
    pid?: string;
}

export function DriveLayout({
                                ownerId,
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
                                isMobile = false,
                                pid = undefined,
                                showBreadcrumb = false,
                            }: DriveLayoutProps) {

    // Folder creation state and handlers
    const [createFolderOpen, setCreateFolderOpen] = useState(false);

    // Doc creation state and handlers
    const [createDocOpen, setCreateDocOpen] = useState(false);

    // Stickies creation state and handlers
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);

    // Delete confirmation dialog state
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [itemToDelete, setItemToDelete] = useState<DrivePath | null>(null);

    // Share dialog state
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [itemToShare, setItemToShare] = useState<DrivePath | null>(null);

    // State for file upload
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);

    // File upload handler
    const handleFileUpload = () => {
        if (allowUpload && currentPath) {
            setUploadOpen(true);
        }
    };

    // Handler for dropped files
    const handleUploadFiles = (files: File[]) => {
        if (allowUpload && currentPath && files.length > 0) {
            setUploadFiles(files);
            setUploadOpen(true);
        }
    };

    // Function to open the create folder dialog
    const openCreateFolderDialog = () => {
        if (allowCreateFolder) {
            setCreateFolderOpen(true);
        }
    };

    // Function to open the create doc dialog
    const openCreateDocDialog = () => {
        if (allowCreateDoc) {
            setCreateDocOpen(true);
        }
    };

    // Function to open the create stickies dialog
    const openCreateStickiesDialog = () => {
        if (allowCreateStickies) {
            setCreateStickiesOpen(true);
        }
    };

    // Handle delete path
    const handleDeletePath = (path: DrivePath) => {
        if (!allowDelete) return;

        // Open the delete confirmation dialog and store the path to be deleted
        setItemToDelete(path);
        setDeleteDialogOpen(true);
    };

    const handleDownloadPath = (path: DrivePath) => {
        if (path && path.type === 'file' && path.id) {
            const downloadUrl = `${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`;
            // Create a temporary anchor element to trigger the download
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = path.name || 'download'; // Use the file name or a default
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }

    // Handle share icon click
    const handleShareClick = (path: DrivePath) => {
        if (!allowShare) return;

        setItemToShare(path);
        setAccessDialogOpen(true);
    };

    // Show loading state
    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    return (
        <>
            {isMobile ? (
                (selectedPath || (currentPath && currentPath?.type !== 'folder')) ? (
                    <div className="flex-1 h-full w-full">
                        <DriveDetail
                            path={selectedPath || currentPath}
                            isMobile={true}
                            onBackClick={onBackToList}
                            onDelete={allowDelete ? handleDeletePath : () => {
                            }}
                            onShareClick={allowShare ? handleShareClick : () => {
                            }}
                            onDownload={handleDownloadPath}
                            onItemOpen={onRowActivate}
                            allowDelete={allowDelete}
                        />
                    </div>
                ) : (
                    <div className="flex-1 h-full w-full">
                        <DriveList
                            items={folderContents}
                            isLoading={isLoading}
                            error={error}
                            onRowSelect={onRowSelect}
                            onRowActivate={onRowActivate}
                            activeRowId={pid}
                            onCreateFolder={allowCreateFolder ? openCreateFolderDialog : undefined}
                            onUploadFile={allowUpload ? handleFileUpload : undefined}
                            onUploadFiles={allowUpload ? handleUploadFiles : undefined}
                            onDelete={allowDelete ? handleDeletePath : () => {
                            }}
                            onShareClick={allowShare ? handleShareClick : () => {
                            }}
                            onCreateDoc={allowCreateDoc ? openCreateDocDialog : undefined}
                            onCreateStickies={allowCreateStickies ? openCreateStickiesDialog : undefined}
                            currentPath={currentPath}
                            ownerId={ownerId}
                            pathId={pathId}
                            showBreadcrumb={showBreadcrumb}
                            onDownload={handleDownloadPath}
                            allowDelete={allowDelete}
                            allowUpload={allowUpload}
                        />
                    </div>
                )
            ) : (
                <>
                    <div className="flex h-full w-full">
                        {/* Path list column */}
                        {(!currentPath || currentPath?.type === 'folder') && (
                            <div className={`${pid ? 'w-2/3' : 'w-full'} h-full overflow-hidden border-r`}>
                                <DriveList
                                    items={folderContents}
                                    isLoading={isLoading}
                                    error={error}
                                    onRowSelect={onRowSelect}
                                    onRowActivate={onRowActivate}
                                    activeRowId={pid}
                                    onCreateFolder={allowCreateFolder ? openCreateFolderDialog : undefined}
                                    onUploadFile={allowUpload ? handleFileUpload : undefined}
                                    onUploadFiles={allowUpload ? handleUploadFiles : undefined}
                                    onDelete={allowDelete ? handleDeletePath : () => {
                                    }}
                                    onShareClick={allowShare ? handleShareClick : () => {
                                    }}
                                    onCreateDoc={allowCreateDoc ? openCreateDocDialog : undefined}
                                    onCreateStickies={allowCreateStickies ? openCreateStickiesDialog : undefined}
                                    currentPath={currentPath}
                                    ownerId={ownerId}
                                    pathId={pathId}
                                    showBreadcrumb={showBreadcrumb}
                                    onDownload={handleDownloadPath}
                                    allowDelete={allowDelete}
                                    allowUpload={allowUpload}
                                />
                            </div>)}
                        {(pid || currentPath?.type !== 'folder') && (
                            <div className="flex-1 h-full overflow-hidden">
                                <div className="h-full">
                                    <DriveDetail
                                        path={selectedPath || currentPath}
                                        className="border-none h-full"
                                        onDelete={allowDelete ? handleDeletePath : () => {
                                        }}
                                        onBackClick={onBackToList}
                                        onShareClick={allowShare ? handleShareClick : () => {
                                        }}
                                        onDownload={handleDownloadPath}
                                        onItemOpen={onRowActivate}
                                        allowDelete={allowDelete}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* Create Folder Dialog */}
            {allowCreateFolder && currentPath && (
                <DriveCreateFolder
                    path={currentPath}
                    open={createFolderOpen}
                    onOpenChange={setCreateFolderOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateFolderOpen(false)}
                    onAfterAction={onAfterAction}
                />
            )}

            {/* Create Doc Dialog */}
            {allowCreateDoc && currentPath && (
                <DriveCreateDoc
                    path={currentPath}
                    open={createDocOpen}
                    onOpenChange={setCreateDocOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateDocOpen(false)}
                    onAfterAction={onAfterAction}
                />
            )}

            {/* Create Stickies Dialog */}
            {allowCreateStickies && currentPath && (
                <DriveCreateStickies
                    path={currentPath}
                    open={createStickiesOpen}
                    onOpenChange={setCreateStickiesOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateStickiesOpen(false)}
                    onAfterAction={onAfterAction}
                />
            )}

            {/* File Upload Dialog */}
            {allowUpload && currentPath && (
                <DriveUploadFiles
                    path={currentPath}
                    open={uploadOpen}
                    onOpenChange={setUploadOpen}
                    initialFiles={uploadFiles}
                    onAfterUpload={() => setUploadFiles([])}
                    onAfterAction={onAfterAction}
                />
            )}

            {/* Delete Confirmation Dialog */}
            {allowDelete && (
                <DriveDeleteItem
                    path={itemToDelete}
                    open={deleteDialogOpen}
                    onOpenChange={setDeleteDialogOpen}
                    onAfterAction={onAfterAction}
                />
            )}

            {/* Access Control Edit Dialog */}
            {allowShare && (
                <DriveAccessDialog
                    open={accessDialogOpen}
                    onOpenChange={setAccessDialogOpen}
                    path={itemToShare}
                />
            )}
        </>
    );
}
