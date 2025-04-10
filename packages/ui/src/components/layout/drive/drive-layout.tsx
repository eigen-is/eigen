import { useState, useRef } from "react";
import { toast } from "sonner";
import { DrivePath } from "@apps/api-server/types/drive";
import { EigenLoader } from "@workspace/ui";
import { useCreateFolder, useDeleteFile, useDeleteFolder, useInvalidateFolder, useCreateDoc, useCreateStickies } from '@workspace/lib/drive';
import { invalidateHomeSize } from "@workspace/lib/home";
import { useQueryClient } from "@tanstack/react-query";
import { DriveList } from "./drive-list";
import { DriveDetail } from "./drive-detail";
import { DriveCreateItemDialog } from "./drive-create-folder-item";
import { DeleteDialog } from "@workspace/ui/components/layout/delete/delete-dialog";
import { DriveAccessDialog } from "./drive-access-dialog";
import { useFileUpload } from "./file-upload";

export interface DriveLayoutProps {
  // Required data
  ownerId: string;
  pathId: string;
  
  // Data fetched by parent component
  folderContents: DrivePath[];
  isLoading: boolean;
  error: any;
  selectedPath: DrivePath | null;
  currentPath: DrivePath | null;
  
  // Navigation callbacks
  onRowClick: (path: DrivePath) => void;
  onBackToList: () => void;
  onAfterAction?: (actionType: string, data: any) => void;
  
  // Feature flags
  allowCreateFolder?: boolean;
  allowDelete?: boolean;
  allowShare?: boolean;
  allowUpload?: boolean;
  allowCreateDoc?: boolean;
  allowCreateStickies?: boolean;
  
  // UI options
  isMobile?: boolean;
  pid?: string;
}

export function DriveLayout({
  ownerId,
  pathId,
  folderContents,
  isLoading,
  error,
  selectedPath,
  currentPath,
  onRowClick,
  onBackToList,
  onAfterAction,
  allowCreateFolder = true,
  allowDelete = true,
  allowShare = true,
  allowCreateDoc = true,
  allowCreateStickies = true,
  allowUpload = true,
  isMobile = false,
  pid
}: DriveLayoutProps) {
  const queryClient = useQueryClient();
  const invalidateFolder = useInvalidateFolder();
  
  // Folder creation state and handlers
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const createFolderMutation = useCreateFolder(ownerId);
  
  // Doc creation state and handlers
  const [createDocOpen, setCreateDocOpen] = useState(false);
  const createDocMutation = useCreateDoc(ownerId);
  
  // Stickies creation state and handlers
  const [createStickiesOpen, setCreateStickiesOpen] = useState(false);
  const createStickiesMutation = useCreateStickies(ownerId);
  
  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<DrivePath | null>(null);
  
  // Share dialog state
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [itemToShare, setItemToShare] = useState<DrivePath | null>(null);
  
  // Initialize mutations for delete operations
  const deleteFileMutation = useDeleteFile(ownerId);
  const deleteFolderMutation = useDeleteFolder(ownerId);
  
  // Handle file uploads
  const { fileInputRef, handleFileUpload, processFiles, handleFileChange } = 
    allowUpload ? useFileUpload(
      ownerId,
      pathId,
      {
        onSuccess: (result) => {
          // Invalidate queries after successful upload
          invalidateFolder(pathId);
          invalidateHomeSize(queryClient);
          toast(`File "${result.fileName}" uploaded successfully`);
          
          if (onAfterAction) {
            onAfterAction('upload', result);
          }
        },
        onError: (result) => {
          toast.error(`Failed to upload "${result.fileName}"`);
        }
      }
    ) : {
      fileInputRef: useRef<HTMLInputElement>(null),
      handleFileUpload: () => {/* disabled */}, 
      processFiles: () => {/* disabled */}, 
      handleFileChange: () => {/* disabled */}
    };
  
  // Function to open the create folder dialog
  const openCreateFolderDialog = () => {
    if (allowCreateFolder) {
      setCreateFolderOpen(true);
    }
  };
  
  // Handler for folder creation
  const handleCreateFolder = (folderName: string) => {
    if (!allowCreateFolder) return;
    
    createFolderMutation.mutate({
      parentId: pathId,
      folderName: folderName
    }, {
      onSuccess: () => {
        toast.success(`Folder "${folderName}" created successfully`);
        setCreateFolderOpen(false);
        invalidateFolder(pathId);
        
        if (onAfterAction) {
          onAfterAction('create', { name: folderName });
        }
      },
      onError: () => {
        toast.error("Failed to create folder");
      }
    });
  };

  // Function to open the create doc dialog
  const openCreateDocDialog = () => {
    if (allowCreateDoc) {
      setCreateDocOpen(true);
    }
  };

  // Handler for doc creation
  const handleCreateDoc = (fileName: string) => {
    if (!allowCreateDoc) return;
    
    createDocMutation.mutate({
      parentId: pathId,
      fileName: fileName
    }, {
      onSuccess: () => {
        toast.success(`Doc "${fileName}" created successfully`);
        setCreateDocOpen(false);
        invalidateFolder(pathId);
        
        if (onAfterAction) {
          onAfterAction('create', { name: fileName });
        }
      },
      onError: () => {
        toast.error("Failed to create doc");
      }
    });
  };

  // Function to open the create stickies dialog
  const openCreateStickiesDialog = () => {
    if (allowCreateStickies) {
      setCreateStickiesOpen(true);
    }
  };
  
  // Handler for stickies creation
  const handleCreateStickies = (fileName: string) => {
    if (!allowCreateStickies) return;
    
    createStickiesMutation.mutate({
      parentId: pathId,
      fileName: fileName
    }, {
      onSuccess: () => {
        toast.success(`Stickies "${fileName}" created successfully`);
        setCreateStickiesOpen(false);
        invalidateFolder(pathId);
        
        if (onAfterAction) {
          onAfterAction('create', { name: fileName });
        }
      },
      onError: () => {
        toast.error("Failed to create stickies");
      }
    });
  };


  // Handle delete path
  const handleDeletePath = (path: DrivePath) => {
    if (!allowDelete) return;
    
    // Open the delete confirmation dialog and store the path to be deleted
    setItemToDelete(path);
    setDeleteDialogOpen(true);
  };
  
  // Function to perform the actual delete after confirmation
  const confirmDelete = () => {
    if (!itemToDelete || !allowDelete) return;
    
    // Use the appropriate mutation based on item type
    const mutation = itemToDelete.type === 'folder' ? deleteFolderMutation : deleteFileMutation;
    
    mutation.mutate(itemToDelete.id, {
      onSuccess: () => {
        toast.success(`${itemToDelete.type === 'folder' ? 'Folder' : 'File'} deleted successfully`);
        setDeleteDialogOpen(false);
        invalidateFolder(pathId);
        invalidateHomeSize(queryClient);
        
        if (onAfterAction) {
          onAfterAction('delete', itemToDelete);
        }
        
        setItemToDelete(null);
      },
      onError: () => {
        toast.error(`Failed to delete ${itemToDelete.type}`);
      }
    });
  };
  
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
        (selectedPath || currentPath?.type !== 'folder') ? (
          <div className="flex-1 h-full w-full">
            <DriveDetail
              path={selectedPath || currentPath}
              isMobile={true}
              onBackClick={onBackToList}
              onDelete={allowDelete ? handleDeletePath : () => {}}
              onShareClick={allowShare ? handleShareClick : () => {}}
            />
          </div>
        ) : (
          <div className="flex-1 h-full w-full">
            <DriveList
              items={folderContents}
              isLoading={isLoading}
              error={error}
              onRowClick={onRowClick}
              activeRowId={pid}
              onCreateFolder={allowCreateFolder ? openCreateFolderDialog : undefined}
              onUploadFile={allowUpload ? handleFileUpload : undefined}
              onUploadFiles={allowUpload ? processFiles : undefined}
              onDelete={allowDelete ? handleDeletePath : () => {}}
              onShareClick={allowShare ? handleShareClick : () => {}}
              onCreateDoc={allowCreateDoc ? openCreateDocDialog : undefined}
              onCreateStickies={allowCreateStickies ? openCreateStickiesDialog : undefined}
              currentPath={currentPath}
              ownerId={ownerId}
              pathId={pathId}
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
                  isLoading={isLoading}
                  error={error}
                  onRowClick={onRowClick}
                  activeRowId={pid}
                  onCreateFolder={allowCreateFolder ? openCreateFolderDialog : undefined}
                  onUploadFile={allowUpload ? handleFileUpload : undefined}
                  onUploadFiles={allowUpload ? processFiles : undefined}
                  onDelete={allowDelete ? handleDeletePath : () => {}}
                  onShareClick={allowShare ? handleShareClick : () => {}}
                  onCreateDoc={allowCreateDoc ? openCreateDocDialog : undefined}
                  onCreateStickies={allowCreateStickies ? openCreateStickiesDialog : undefined}
                  currentPath={currentPath}
                  ownerId={ownerId}
                  pathId={pathId}
                />
              </div>)}
            {(pid || currentPath?.type !== 'folder') && (
              <div className="flex-1 h-full overflow-hidden">
                <div className="h-full">
                  <DriveDetail
                    path={selectedPath || currentPath}
                    className="border-none h-full"
                    onDelete={allowDelete ? handleDeletePath : () => {}}
                    onBackClick={onBackToList}
                    onShareClick={allowShare ? handleShareClick : () => {}}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Create Folder Dialog */}
      {allowCreateFolder && (
        <DriveCreateItemDialog 
          open={createFolderOpen}
          onOpenChange={setCreateFolderOpen}
          onCreateItem={handleCreateFolder}
          isPending={createFolderMutation.isPending}
          type="Folder"
        />
      )}

      {/* Create Doc Dialog */}
      {allowCreateDoc && (
        <DriveCreateItemDialog 
          open={createDocOpen}
          onOpenChange={setCreateDocOpen}
          onCreateItem={handleCreateDoc}
          isPending={createDocMutation.isPending}
          type="Doc"
        />
      )}

      {/* Create Stickies Dialog */}
      {allowCreateStickies && (
        <DriveCreateItemDialog 
          open={createStickiesOpen}
          onOpenChange={setCreateStickiesOpen}
          onCreateItem={handleCreateStickies}
          isPending={createStickiesMutation.isPending}
          type="Stickies"
        />
      )}

      {/* Hidden file input element */}
      {allowUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {allowDelete && (
        <DeleteDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="Delete Item"
          description="Are you sure you want to delete"
          itemName={itemToDelete?.name}
          onDelete={confirmDelete}
        />
      )}
      
      {/* Access Control Edit Dialog */}
      {allowShare && (
        <DriveAccessDialog 
          open={accessDialogOpen}
          onOpenChange={setAccessDialogOpen}
          path={itemToShare}
          acl={itemToShare?.acl || null}
        />
      )}
    </>
  );
}
