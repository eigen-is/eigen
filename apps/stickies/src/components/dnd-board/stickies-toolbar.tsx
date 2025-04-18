import { useCallback, useEffect, useState } from 'react';
import {
  FileText,
  Folder,
  Files,
  Printer,
  Trash2,
  Undo,
  Redo,
  UserPlus,
  UserRoundPlus
} from 'lucide-react';
import { Button } from '@workspace/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Separator } from '@workspace/ui/components/separator';
import { TooltipButton } from '@workspace/ui';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/DocumentModeButton';
import { printElement } from '@workspace/ui/lib/printElement';
import * as Y from 'yjs';

interface StickiesToolbarProps {
  canWrite: boolean;
  undoManager: Y.UndoManager | null;
  onAccessDialogOpen: () => void;
}

/**
 * Toolbar component for the Stickies application
 */
export const StickiesToolbar = ({ canWrite, undoManager, onAccessDialogOpen }: StickiesToolbarProps) => {
  const commandKey = window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const printDocument = useCallback(() => printElement(document.querySelector('[data-stickies-board]')!), []);

  useEffect(() => {
    if (!undoManager || !undoManager.undoStack || !canWrite) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }
    const update = () => {
      setCanUndo(undoManager.undoStack.length > 1);
      setCanRedo(undoManager.redoStack.length > 0);
    };
    update(); // Initial state
    undoManager.on('stack-item-added', update);
    undoManager.on('stack-item-popped', update);
    undoManager.on('stack-item-updated', update);
    return () => {
      undoManager.off('stack-item-added', update);
      undoManager.off('stack-item-popped', update);
      undoManager.off('stack-item-updated', update);
    };
  }, [undoManager, canWrite]);

  // Helper component for toolbar separator
  const ToolbarSeparator = () => <div className="h-4 w-px bg-gray-200 mx-1" />;

  return (
    <div className="bg-white h-12 flex items-center justify-between px-4 border-b no-print">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="File">
              File
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
              <DropdownMenuItem><FileText/> New stickies</DropdownMenuItem>
              <DropdownMenuItem><Folder/> Open</DropdownMenuItem>
              <Separator/>
              <DropdownMenuItem onClick={onAccessDialogOpen}><UserRoundPlus/> Edit access</DropdownMenuItem>
              <DropdownMenuItem onClick={printDocument}><Printer/> Print</DropdownMenuItem>
              {canWrite && (
                  <>
                      <Separator/>
                      <DropdownMenuItem><Trash2/> Delete</DropdownMenuItem>
                  </>
              )}
          </DropdownMenuContent>
        </DropdownMenu>
        {canWrite && (
          <>
            {/* Separator */}
            <ToolbarSeparator/>

            <TooltipButton
              icon={Undo}
              tooltipText={`Undo (${commandKey}+Z)`}
              onClick={() => undoManager?.undo?.()}
              disabled={!canUndo}
            />

            <TooltipButton
              icon={Redo}
              tooltipText={`Redo (${commandKey}+Y)`}
              onClick={() => undoManager?.redo?.()}
              disabled={!canRedo}
            />
          </>
        )}  
      </div>

      <div className="flex items-center gap-1">
        {canWrite ? (
          <TooltipButton
            icon={UserPlus}
            tooltipText="Share"
            onClick={onAccessDialogOpen}
          />
        ) : (
          <DocumentModeButton canWrite={canWrite} />
        )}
      </div>
    </div>
  );
};
