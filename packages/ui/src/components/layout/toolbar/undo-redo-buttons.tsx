import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Redo, Undo } from 'lucide-react';
import { TooltipButton } from './tooltip-button';

type UndoRedoButtonsProps = {
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
};

export function UndoRedoButtons({ canUndo, canRedo, onUndo, onRedo }: UndoRedoButtonsProps) {
    return (
        <>
            <TooltipButton
                icon={Undo}
                tooltipText={`Undo (${formatForDisplay('Mod+Z')})`}
                onClick={onUndo}
                disabled={!canUndo}
            />
            <TooltipButton
                icon={Redo}
                tooltipText={`Redo (${formatForDisplay('Mod+Y')})`}
                onClick={onRedo}
                disabled={!canRedo}
            />
        </>
    );
}
