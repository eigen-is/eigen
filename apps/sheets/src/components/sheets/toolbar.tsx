import {UserRoundPlus} from 'lucide-react';
import {TooltipButton} from '@workspace/ui';
import {DocumentModeButton} from '@workspace/ui/components/layout/toolbar/document-mode-button';
import {FileMenu} from '@workspace/ui/components/layout/toolbar/file-menu';
import {RevisionHistory} from '@workspace/ui/components/layout/collab/revision-history';
import {DriveCreateSheets} from '@workspace/ui/components/layout/drive/drive-create-sheets';
import type {DrivePath} from '@workspace/lib/types/drive';

type ToolbarItemsProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
}

type ToolbarRightItemsProps = ToolbarItemsProps & {
    onRestore: (state: Uint8Array) => void;
}

export function ToolbarLeftItems({path, onAccessDialogOpen, canWrite}: ToolbarItemsProps) {
    return (
        <FileMenu
            path={path}
            canWrite={canWrite}
            onAccessDialogOpen={onAccessDialogOpen}
            createLabel="New sheet"
            CreateDialog={DriveCreateSheets}
        />
    );
}

export function ToolbarRightItems({path, canWrite, onAccessDialogOpen, onRestore}: ToolbarRightItemsProps) {
    return (
        <>
            <RevisionHistory path={path} onRestore={onRestore}/>
            {canWrite ? (
                <TooltipButton
                    icon={UserRoundPlus}
                    tooltipText="Share"
                    onClick={onAccessDialogOpen}
                />
            ) : (
                <DocumentModeButton canWrite={canWrite}/>
            )}
        </>
    );
}
