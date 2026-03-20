import {useCallback, useMemo, useRef} from 'react';
import {type Sheet, Workbook, type WorkbookInstance} from '@workspace/fortune-sheet';
import {useSheet} from './hooks/use-sheet';
import {ToolbarLeftItems, ToolbarRightItems} from './toolbar';
import {EigenLoader} from '@workspace/ui';
import type {DrivePath} from '@workspace/lib/types/drive';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
}

const TOOLBAR_ITEMS = [
    'undo', 'redo', 'format-painter', 'clear-format',
    '|',
    'format',
    '|',
    'bold', 'italic', 'strike-through', 'underline',
    '|',
    'font-color', 'background', 'border', 'merge-cell',
    '|',
    'horizontal-align', 'vertical-align', 'text-wrap',
    '|',
    'freeze', 'conditionFormat', 'filter',
    'quick-formula', 'search',
];

export function SheetEditor({ownerId, path, canWrite, onAccessDialogOpen}: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);

    const {
        initialData,
        synced,
        handleOp,
        saveSnapshot,
        handleRestore,
    } = useSheet(ownerId, path.mountId, path.id, workbookRef);

    const onChange = useCallback((data: Sheet[]) => {
        saveSnapshot(data);
    }, [saveSnapshot]);

    const leftItems = useMemo(() => (
        <ToolbarLeftItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen}/>
    ), [path, canWrite, onAccessDialogOpen]);

    const rightItems = useMemo(() => (
        <ToolbarRightItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} onRestore={handleRestore}/>
    ), [path, canWrite, onAccessDialogOpen, handleRestore]);

    if (!synced || !initialData) {
        return <EigenLoader/>;
    }

    return (
        <div className="flex flex-col h-full w-full">
            <div className="flex-1 overflow-hidden">
                <Workbook
                    ref={workbookRef}
                    data={initialData}
                    onChange={onChange}
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
