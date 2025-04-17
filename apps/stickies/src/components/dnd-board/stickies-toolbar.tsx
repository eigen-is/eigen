import { useCallback } from 'react';
import {
  FileText,
  Folder,
  Files,
  Printer,
  Trash2,
  Undo,
  Redo,
  UserPlus
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

interface StickiesToolbarProps {
  canWrite: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

/**
 * Toolbar component for the Stickies application
 */
export const StickiesToolbar = ({ canWrite, onUndo, onRedo }: StickiesToolbarProps) => {
  const commandKey = window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const printDocument = useCallback(() => printElement(document.querySelector('[data-stickies-board]')!), []);

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
            <DropdownMenuItem><FileText/> New stickie</DropdownMenuItem>
            <DropdownMenuItem><Folder/> Open</DropdownMenuItem>
            <DropdownMenuItem><Files/> Make a copy</DropdownMenuItem>
            <Separator/>
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
              onClick={onUndo}
            />

            <TooltipButton
              icon={Redo}
              tooltipText={`Redo (${commandKey}+Y)`}
              onClick={onRedo}
            />
          </>
        )}  
      </div>

      <div className="flex items-center gap-1">
        {canWrite ? (
          <TooltipButton
            icon={UserPlus}
            tooltipText="Share"
          />
        ) : (
          <DocumentModeButton canWrite={canWrite} />
        )}
      </div>
    </div>
  );
};
