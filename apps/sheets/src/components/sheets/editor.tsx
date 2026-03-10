import {useCallback, useRef} from 'react';
import {Workbook, type WorkbookInstance} from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import {useSheet} from './hooks/use-sheet';
import {SheetToolbar} from './toolbar';
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
    'currency-format', 'percentage-format', 'number-decrease', 'number-increase', 'format',
    '|',
    'font', '|', 'font-size',
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

    const onOp = useCallback((ops: any[]) => {
        handleOp(ops);
    }, [handleOp]);

    const onChange = useCallback((data: Record<string, any>[]) => {
        saveSnapshot(data as any);
    }, [saveSnapshot]);

    if (!synced || !initialData) {
        return <EigenLoader/>;
    }

    return (
        <div className="flex flex-col h-full w-full">
            <SheetToolbar
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
            />
            <div className="flex-1 overflow-hidden">
                <Workbook
                    ref={workbookRef}
                    data={initialData}
                    onChange={onChange}
                    onOp={onOp}
                    showToolbar={true}
                    showFormulaBar={true}
                    showSheetTabs={true}
                    allowEdit={canWrite}
                    toolbarItems={TOOLBAR_ITEMS}
                    column={26}
                    row={100}
                />
            </div>
        </div>
    );
}
