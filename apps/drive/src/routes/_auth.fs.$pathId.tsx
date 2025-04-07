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
import {useUpload} from "@workspace/ui/components/layout/upload-provider/upload-provider";
import {uploadWithProgress} from "@workspace/ui/components/layout/upload-provider/upload-with-progress";
import {DrivePath} from "@apps/api-server/types/drive";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {invalidateHomeSize} from "@workspace/lib/home";
import {useQueryClient} from "@tanstack/react-query";

// Define search params type
export interface DriveSearchParams {
    pid?: string;
}

export const Route = createFileRoute('/_auth/fs/$pathId')({
    component: DriveRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const pid = typeof search.pid === 'string' ? search.pid : undefined;
        return {pid} as DriveSearchParams;
    },
});

function DriveRoute() {
    const {pathId} = Route.useParams();
    const {pid} = Route.useSearch();
    const navigate = useNavigate();

    // Get the root folder ID to replace "root" pathId
    const {data: rootFolder, isLoading: isRootLoading} = useRootFolder();

    // If pathId is "root", navigate to the actual root folder ID when available
    useEffect(() => {
        if (pathId === 'root' && rootFolder?.id) {
            navigate({
                to: Route.fullPath,
                params: {pathId: rootFolder.id}
            });
        }
    }, [pathId, rootFolder, navigate]);

    const isMobile = useMediaQuery('(max-width: 768px)');
    // const isTablet = useMediaQuery('(max-width: 1024px) and (min-width: 769px)');
    const deleteFileMutation = useDeleteFile();
    const deleteFolderMutation = useDeleteFolder();
    const invalidateFolder = useInvalidateFolder();
    const upload = useUpload();
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Folder creation state and handlers
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const createFolderMutation = useCreateFolder();

    // Delete confirmation dialog state
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [itemToDelete, setItemToDelete] = useState<DrivePath | null>(null);

    // Don't fetch data until we have the actual root folder ID (not "root")
    const skipDataFetch = pathId === 'root';
    const queryClient = useQueryClient();

    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useFolderContent(skipDataFetch ? '' : pathId);
    const {data: selectedPath = null} = usePathInfo(pid);
    const {data: currentPath = null} = usePathInfo(pathId);

    // Show loading state while resolving root folder ID
    if ((pathId === 'root' && isRootLoading) || (isFolderContentLoading && !skipDataFetch)) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    // Handle folder creation
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

    // Function to handle file upload
    const handleFileUpload = () => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    // Common function to process uploads for multiple files
    const processFiles = async (files: File[]) => {
        if (files.length === 0) return;

        const multipleFiles = files.length > 1;
        const url = multipleFiles ?
            `${import.meta.env.VITE_API_HOST}/drive/files/${pathId}` :
            `${import.meta.env.VITE_API_HOST}/drive/file/${pathId}`;

        const name = multipleFiles ? ' multiple files' : files[0].name;
        const uploadHandler = upload.createUpload(name);

        try {
            // Create a FormData object for this file
            const formData = new FormData();
            if (multipleFiles) {
                for (const file of files) {
                    formData.append('files', file);
                }
            } else {
                formData.append('file', files[0]);
            }

            // Use the uploadWithProgress helper with authentication
            await uploadWithProgress({
                url,
                formData,
                headers: {
                    'credentials': 'include'
                },
                onProgress: (progress: number) => {
                    // Update the progress in the UI for this specific file
                    uploadHandler.updateProgress(progress);
                },
                onSuccess: async () => {
                    // Mark upload as complete
                    uploadHandler.complete();

                    // invalidate the folder contents query to refresh the list
                    invalidateFolder(pathId);
                    invalidateHomeSize(queryClient);

                    return {success: true, fileName: name};
                },
                onError: (err) => {
                    // Mark upload as failed
                    uploadHandler.error();
                    return {success: false, fileName: name, error: err};
                }
            });
        } catch (err: any) {
            uploadHandler.error();
            return {success: false, fileName: name, error: err};
        }
    };

    // Function to process the selected files
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        // Use the common processFiles function
        await processFiles(Array.from(files));

        // Clean up the file input value so the same files can be selected again if needed
        e.target.value = '';
    };

    // Handle row click to show path details
    const handleRowClick = (path: DrivePath) => {
        // navigateToPath(pathId, { pid: itemId });
        console.log(path.id);
        if (path.type === 'folder') {
            navigate({
                to: Route.fullPath,
                params: {pathId: path.id},
                search: {pid: undefined}
            });
        } else {
            navigate({
                to: Route.fullPath,
                params: {pathId: pathId},
                search: {pid: path.id}
            });
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {pathId: pathId}
        });
    };

    const handleDeletePath = async (path: DrivePath) => {
        // Open the delete confirmation dialog and store the path to be deleted
        setItemToDelete(path);
        setDeleteDialogOpen(true);
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
                params: {pathId: pathId},
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
                selectedPath ? (
                    <div className="flex-1 h-full w-full">
                        <DriveDetail
                            path={selectedPath}
                            isMobile={true}
                            onBackClick={handleBackToList}
                            onDelete={handleDeletePath}
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
                            currentPath={currentPath}
                        />
                    </div>
                )
            ) : (
                !selectedPath ? (
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
                            currentPath={currentPath}
                        />
                    </div>
                ) : (
                    <>
                        <div className="flex h-full w-full">
                            {/* Path list column */}
                            <div className={`${selectedPath ? 'w-2/3' : 'w-full'} h-full overflow-hidden border-r`}>
                                <DriveList
                                    items={folderContents}
                                    isLoading={isFolderContentLoading}
                                    error={isFolderContentLoadingError}
                                    onRowClick={handleRowClick}
                                    activeRowId={pid}
                                    onCreateFolder={openCreateFolderDialog}
                                    onUploadFile={handleFileUpload}
                                    onUploadFiles={processFiles}
                                    currentPath={currentPath}
                                    onDelete={handleDeletePath}
                                />
                            </div>

                            <div className="flex-1 h-full overflow-hidden">
                                <div className="h-full">
                                    <DriveDetail
                                        path={selectedPath}
                                        className="border-none h-full"
                                        onDelete={handleDeletePath}
                                    />
                                </div>
                            </div>
                        </div>
                    </>
                )
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
        </>
    );
}