import { useCallback } from 'react';
import { Eye, Pencil } from 'lucide-react';
import { Button } from '@workspace/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';

export type DocumentEditMode = 'edit' | 'view';

export interface DocumentModeDropdownProps {
  editMode: DocumentEditMode;
  onEditModeChange: (mode: DocumentEditMode) => void;
}

export const DocumentModeDropdown = ({
  editMode,
  onEditModeChange,
}: DocumentModeDropdownProps) => {
  // Optimized handlers using useCallback
  const handleViewModeClick = useCallback(() => {
    onEditModeChange('view');
  }, [onEditModeChange]);

  const handleEditModeClick = useCallback(() => {
    onEditModeChange('edit');
  }, [onEditModeChange]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" title="Document Mode">
          {editMode === 'view' ? (
            <>
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline ml-2">View mode</span>
            </>
          ) : (
            <>
              <Pencil className="h-4 w-4" />
              <span className="hidden sm:inline ml-2">Edit mode</span>
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={handleViewModeClick}>
          <Eye className="h-4 w-4 mr-2" />
          <span>View mode</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleEditModeClick}>
          <Pencil className="h-4 w-4 mr-2" />
          <span>Edit mode</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
