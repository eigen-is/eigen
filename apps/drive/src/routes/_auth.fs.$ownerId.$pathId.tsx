import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {toast} from "sonner";
import {DriveDetail} from "@/components/drive/drive-detail.tsx";
import {DriveList} from "@/components/drive/drive-list.tsx";
import {
    useCreateFolder,
    useDeleteFile,
    useDeleteFolder,
    useFolderContent,
    useInvalidateFolder,
    useMediaQuery,
    usePathInfo,
    useRootFolder
} from '@workspace/lib/drive';
import {useEffect, useRef, useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {Button} from "@workspace/ui/components/button";
import {EigenLoader} from "@workspace/ui";
import {DrivePath} from "@apps/api-server/types/drive";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {invalidateHomeSize} from "@workspace/lib/home";
import {useQueryClient} from "@tanstack/react-query";
import {useFileUpload} from "@workspace/ui/components/layout/drive/file-upload";
import {DriveAccessDialog} from "./../components/drive/drive-access-dialog";

// Define search params type
export interface DriveSearchParams {
    pid?: string;
}

export const Route = createFileRoute('/_auth/fs/$ownerId/$pathId')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {ownerId,pathId} = Route.useParams();
    const {pid} = Route.useSearch();
    const navigate = useNavigate();

    // Get the root folder ID to replace "root" pathId
    const {data: rootFolder, isLoading: isRootLoading} = useRootFolder(ownerId);

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootFolder?.id) {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: rootFolder.id}
            });
        }
    }, [pathId, rootFolder, navigate]);

    const isMobile = useMediaQuery('(max-width: 768px)');
    // const isTablet = useMediaQuery('(max-width: 1024px) and (min-width: 769px)');
    const deleteFileMutation = useDeleteFile(ownerId);
    const deleteFolderMutation = useDeleteFolder(ownerId);
    const invalidateFolder = useInvalidateFolder();
    const queryClient = useQueryClient();

    // Use the file upload hook
    const { fileInputRef, handleFileUpload, processFiles, handleFileChange } = useFileUpload(
        ownerId,
        pathId,
        {
            onSuccess: (result) => {
                // Invalidate queries after successful upload
                invalidateFolder(pathId);
                invalidateHomeSize(queryClient);
                toast(`File "${result.fileName}" uploaded successfully`);
            },
            onError: (result) => {
                toast.error(`Failed to upload "${result.fileName}"`);
            }
        }
    );

    // Folder creation state and handlers
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const createFolderMutation = useCreateFolder(ownerId);

    // Delete confirmation dialog state
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [itemToDelete, setItemToDelete] = useState<DrivePath | null>(null);

    // Share dialog state
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);
    const [itemToShare, setItemToShare] = useState<DrivePath | null>(null);

    // Don't fetch data until we have the actual root folder ID (not "root")
    const skipDataFetch = pathId === 'root';
    
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useFolderContent(ownerId, skipDataFetch ? '' : pathId);
    const {data: selectedPath = null} = usePathInfo(ownerId, pid);
    const {data: currentPath = null} = usePathInfo(ownerId, pathId);

    // Show loading state while resolving root folder ID
    if ((pathId === 'root' && isRootLoading) || (isFolderContentLoading && !skipDataFetch)) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;

        const newFolderNameName = newFolderName.trim();
        try {
            await createFolderMutation.mutateAsync({
                parentId: pathId,
                folderName: newFolderNameName
            });

            // Reset state and show success message
            setCreateFolderOpen(false);
            toast(`Folder "${newFolderNameName}" created`);
        } catch (error) {
            console.error('Failed to create folder:', error);
            toast.error(`Failed to create folder "${newFolderNameName}"`);
        }
        setNewFolderName('');
    };

    // Function to open the create folder dialog
    const openCreateFolderDialog = () => {
        setCreateFolderOpen(true);
    };

    // Handle row click to show path details
    const handleRowClick = (path: DrivePath) => {
        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: path.id},
                search: {pid: undefined}
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId: pathId},
                search: {pid: path.id}
            });
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {ownerId, pathId}
        });
    };

    const handleDeletePath = async (path: DrivePath) => {
        // Open the delete confirmation dialog and store the path to be deleted
        setItemToDelete(path);
        setDeleteDialogOpen(true);
    };

    // Handle share icon click
    const handleShareClick = (path: DrivePath) => {
        setItemToShare(path);
        setAccessDialogOpen(true);
    };

    // Function to perform the actual delete after confirmation
    const confirmDelete = async () => {
        if (!itemToDelete) return;

        try {
            if (itemToDelete.type === 'file') {
                await deleteFileMutation.mutateAsync(itemToDelete.id);
                toast("File deleted");
            } else if (itemToDelete.type === 'folder') {
                await deleteFolderMutation.mutateAsync(itemToDelete.id);
                toast("Folder deleted");
            }

            // Close the dialog and reset state
            setDeleteDialogOpen(false);
            setItemToDelete(null);

            // Navigate back to the folder view
            navigate({
                to: Route.fullPath,
                params: {ownerId, pathId},
                search: {pid: undefined}
            });
        } catch (error) {
            console.error('Failed to delete item:', error);
            toast.error("Failed to delete item");
            setDeleteDialogOpen(false);
        }
    };

    const CreateFolderDialog = () => <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>New Folder</DialogTitle>
            </DialogHeader>
            <div className="py-4">
                <Label htmlFor="folderName">Folder Name</Label>
                <Input
                    id="folderName"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Enter folder name"
                    className="mt-2"
                    autoFocus
                    onKeyDown={(e) => {
                        console.log(e.key);
                        if (e.key === 'Enter' && newFolderName.trim() && !createFolderMutation.isPending) {
                            e.preventDefault();
                            handleCreateFolder();
                        }
                    }}
                />
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={() => {
                    setCreateFolderOpen(false);
                    setNewFolderName('');
                }}>
                    Cancel
                </Button>
                <Button
                    onClick={handleCreateFolder}
                    disabled={!newFolderName.trim() || createFolderMutation.isPending}
                >
                    {createFolderMutation.isPending ? "Creating..." : "Create"}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;

    // Desktop/Tablet: Two-column layout if detailpath is selected (sidebar already handled in _auth.tsx)
    return (
        <>
            {isMobile ? (
                (selectedPath || currentPath?.type !== 'folder') ? (
                    <div className="flex-1 h-full w-full">
                        <DriveDetail
                            path={selectedPath || currentPath}
                            isMobile={true}
                            onBackClick={handleBackToList}
                            onDelete={handleDeletePath}
                            onShareClick={handleShareClick}
                        />
                    </div>
                ) : (
                    <div className="flex-1 h-full w-full">
                        <DriveList
                            items={folderContents}
                            isLoading={isFolderContentLoading}
                            error={isFolderContentLoadingError}
                            onRowClick={handleRowClick}
                            activeRowId={pid}
                            onCreateFolder={openCreateFolderDialog}
                            onUploadFile={handleFileUpload}
                            onUploadFiles={processFiles}
                            onDelete={handleDeletePath}
                            onShareClick={handleShareClick}
                            currentPath={currentPath}
                        />
                    </div>
                )
            ) : (
                <>
                    <div className="flex h-full w-full">
                        {/* Path list column */}
                        {currentPath?.type === 'folder' && (
                            <div className={`${pid ? 'w-2/3' : 'w-full'} h-full overflow-hidden border-r`}>
                                <DriveList
                                    items={folderContents}
                                    isLoading={isFolderContentLoading}
                                    error={isFolderContentLoadingError}
                                    onRowClick={handleRowClick}
                                    activeRowId={pid}
                                    onCreateFolder={openCreateFolderDialog}
                                    onUploadFile={handleFileUpload}
                                    onUploadFiles={processFiles}
                                    onDelete={handleDeletePath}
                                    onShareClick={handleShareClick}
                                    currentPath={currentPath}
                                />
                            </div>)}
                        {(pid || currentPath?.type !== 'folder') && (
                            <div className="flex-1 h-full overflow-hidden">
                                <div className="h-full">
                                    <DriveDetail
                                        path={selectedPath || currentPath}
                                        className="border-none h-full"
                                        onDelete={handleDeletePath}
                                        onBackClick={handleBackToList}
                                        onShareClick={handleShareClick}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* Create Folder Dialog */}
            {CreateFolderDialog()}


            {/* Hidden file input element */}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
            />

            {/* Delete Confirmation Dialog */}
            <DeleteDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                title="Delete Item"
                description="Are you sure you want to delete"
                itemName={itemToDelete?.name}
                onDelete={confirmDelete}
            />
            
            {/* Access Control Edit Dialog */}
            <DriveAccessDialog 
                open={accessDialogOpen}
                onOpenChange={setAccessDialogOpen}
                path={itemToShare}
                acl={itemToShare?.acl || null}
            />
        </>
    );
}