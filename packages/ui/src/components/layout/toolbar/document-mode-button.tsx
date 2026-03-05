import {Eye, Pencil} from 'lucide-react';
import {TooltipButton} from './tooltip-button.tsx';

export type DocumentModeButtonProps = {
    canWrite: boolean;
}

export const DocumentModeButton = ({canWrite}: DocumentModeButtonProps) => {
    return (
        <TooltipButton
            icon={canWrite ? Pencil : Eye}
            label={canWrite ? 'Editing' : 'Read-only'}
            tooltipText={canWrite
                ? 'You can edit this document because you are Editor'
                : "You can only read this document because you're set to Viewer"}
            variant="ghost"
            size="default"
            className="h-8"
        />
    );
};