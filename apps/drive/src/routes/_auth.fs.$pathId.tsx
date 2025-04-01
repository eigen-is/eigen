import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {toast} from "sonner";
import {DriveDetail} from "@/components/drive/drive-detail.tsx";
import {DriveList} from "@/components/drive/drive-list.tsx";
import {useMediaQuery} from "@/hooks/use-media-query.ts";
import {useCreateFolder, useDeleteFile, useFolderContent, usePathInfo, useRootFolder} from "@/hooks/use-drive.ts";
import {useState, useEffect} from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {Button} from "@workspace/ui/components/button";
import {EigenLoader} from "@workspace/ui";

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
                params: { pathId: rootFolder.id }
            });
        }
    }, [pathId, rootFolder, navigate]);

    const isMobile = useMediaQuery('(max-width: 768px)');
    // const isTablet = useMediaQuery('(max-width: 1024px) and (min-width: 769px)');
    const deleteFileMutation = useDeleteFile();

    // Folder creation state and handlers
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const createFolderMutation = useCreateFolder();
    
    // Don't fetch data until we have the actual root folder ID (not "root")
    const skipDataFetch = pathId === 'root';
    
    const {
        data: folderContents = [],
        isLoading: isFolderContentLoading,
        error: isFolderContentLoadingError
    } = useFolderContent(skipDataFetch ? '' : pathId);
    const {data: selectedPath = null} = usePathInfo(pid);

    // Show loading state while resolving root folder ID
    if ((pathId === 'root' && isRootLoading) || (isFolderContentLoading && !skipDataFetch)) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader />
            </div>
        );
    }

    // Handle folder creation
    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        
        try {
            await createFolderMutation.mutateAsync({
                parentId: pathId,
                folderName: newFolderName.trim()
            });
            
            // Reset state and show success message
            setNewFolderName('');
            setCreateFolderOpen(false);
            toast("Folder created");
        } catch (error) {
            console.error('Failed to create folder:', error);
            toast.error("Failed to create folder");
        }
    };
    
    // Function to open the create folder dialog
    const openCreateFolderDialog = () => {
        setCreateFolderOpen(true);
    };

    // Handle row click to show path details
    const handleRowClick = (itemId: string) => {
        // navigateToPath(pathId, { pid: itemId });
        console.log(itemId);
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: { pathId: pathId }
        });
    };

    const handleDeletePath = async () => {
        if (!selectedPath) return;
        
        try {
            if (selectedPath.type === 'file') {
                await deleteFileMutation.mutateAsync(selectedPath.id);
            } else {
                // Handle folder deletion when implemented
            }
            toast("Item deleted");
            navigate({
                to: Route.fullPath,
                params: { pathId: pathId }
            });
        } catch (error) {
            console.error('Failed to delete item:', error);
            toast.error("Failed to delete item");
        }
    };

    // On mobile: Show full-width path list / detail
    if (isMobile) {
        return (
            <>
                {selectedPath ? (
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
                        />
                    </div>
                )}
                
                {/* Create Folder Dialog */}
                <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Create New Folder</DialogTitle>
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
                            />
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
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
                </Dialog>
            </>
        );
    }

    // Desktop/Tablet: Two-column layout if detailpath is selected (sidebar already handled in _auth.tsx)
    return (
        <>
            <div className="flex h-full w-full">
                {/* Path list column */}
                <div className={`${selectedPath ? 'w-1/3' : 'w-full'} h-full overflow-hidden border-r`}>
                    <DriveList
                        items={folderContents}
                        isLoading={isFolderContentLoading}
                        error={isFolderContentLoadingError}
                        onRowClick={handleRowClick}
                        activeRowId={pid}
                        onCreateFolder={openCreateFolderDialog}
                    />
                </div>

                {selectedPath && (
                    <div className="flex-1 h-full overflow-hidden">
                        <div className="h-full">
                            <DriveDetail
                                path={selectedPath}
                                className="border-none h-full"
                                onDelete={handleDeletePath}
                            />
                        </div>
                    </div>
                )}
            </div>
            
            {/* Create Folder Dialog */}
            <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create New Folder</DialogTitle>
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
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
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
            </Dialog>
        </>
    );
}