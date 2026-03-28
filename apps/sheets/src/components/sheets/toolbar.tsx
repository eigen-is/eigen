import type { DrivePath } from '@workspace/lib/types/drive';
import { TooltipButton } from '@workspace/ui';
import { DriveCreateSheets } from '@workspace/ui/components/layout/drive/drive-create-sheets';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { UserRoundPlus } from 'lucide-react';

type ToolbarItemsProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
};

export function ToolbarLeftItems({ path, onAccessDialogOpen, onRestore, canWrite }: ToolbarItemsProps) {
    return (
        <FileMenu
            path={path}
            canWrite={canWrite}
            onAccessDialogOpen={onAccessDialogOpen}
            onRestore={onRestore}
            createLabel="New sheet"
            CreateDialog={DriveCreateSheets}
        />
    );
}

export function ToolbarRightItems({ canWrite, onAccessDialogOpen }: ToolbarItemsProps) {
    return canWrite ? (
        <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
    ) : (
        <DocumentModeButton canWrite={canWrite} />
    );
}
