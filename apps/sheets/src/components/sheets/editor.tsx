import {Workbook, type WorkbookInstance} from '@workspace/fortune-sheet';
import type {DrivePath} from '@workspace/lib/types/drive';
import {LoadingState} from '@workspace/ui';
import {useMemo, useRef} from 'react';
import {useSheet} from './hooks/use-sheet';
import {ToolbarLeftItems, ToolbarRightItems} from './toolbar';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
};

const TOOLBAR_ITEMS = [
    'undo',
    'redo',
    'format-painter',
    'clear-format',
    '|',
    'font',
    '|',
    'font-size',
    '|',
    'format',
    '|',
    'bold',
    'italic',
    'strike-through',
    'underline',
    '|',
    'font-color',
    'background',
    'border',
    'merge-cell',
    '|',
    'horizontal-align',
    'vertical-align',
    'text-wrap',
    '|',
    'freeze',
    'conditionFormat',
    'filter',
    'quick-formula',
    'search',
];

export function SheetEditor({ownerId, path, canWrite, onAccessDialogOpen}: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);

    const {initialData, synced, handleOp, onDataChange, handleRestore} = useSheet(
        ownerId,
        path.mountId,
        path.id,
        workbookRef,
    );

    const leftItems = useMemo(
        () => (
            <ToolbarLeftItems
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
            />
        ),
        [path, canWrite, onAccessDialogOpen, handleRestore],
    );

    const rightItems = useMemo(
        () => (
            <ToolbarRightItems
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
            />
        ),
        [path, canWrite, onAccessDialogOpen, handleRestore],
    );

    if (!synced || !initialData) {
        return <LoadingState/>;
    }

    return (
        <div className="flex flex-col h-full w-full">
            <div className="flex-1 overflow-hidden">
                <Workbook
                    ref={workbookRef}
                    data={initialData}
                    onChange={onDataChange}
                    onOp={handleOp}
                    showToolbar={true}
                    showFormulaBar={true}
                    showSheetTabs={true}
                    allowEdit={canWrite}
                    toolbarItems={TOOLBAR_ITEMS}
                    toolbarLeftItems={leftItems}
                    toolbarRightItems={rightItems}
                    defaultRowHeight={25}
                    defaultFontSize={11}
                    column={26}
                    row={100}
                />
            </div>
        </div>
    );
}
