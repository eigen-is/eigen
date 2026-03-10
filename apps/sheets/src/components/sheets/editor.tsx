import {useCallback, useMemo, useRef, useState} from 'react';
import {Workbook, type WorkbookInstance} from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import {useSheet, type SheetData} from './hooks/use-sheet';
import {SheetToolbar} from './toolbar';
import {EigenLoader} from '@workspace/ui';
import type {DrivePath} from '@workspace/lib/types/drive';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
}

type ToolbarState = {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
}

export function SheetEditor({ownerId, path, canWrite, onAccessDialogOpen}: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);
    const [toolbarState, setToolbarState] = useState<ToolbarState>({
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
    });

    const {
        sheetData,
        synced,
        saveSheetData,
        handleRestore,
        undoManager,
    } = useSheet(ownerId, path.mountId, path.id);

    const updateToolbarFromSelection = useCallback(() => {
        const wb = workbookRef.current;
        if (!wb) return;
        try {
            const sel = wb.getSelection();
            if (sel && sel.length > 0) {
                const range = sel[0];
                const r = range.row?.[0] ?? 0;
                const c = range.column?.[0] ?? 0;
                const bold = wb.getCellValue(r, c, {type: 'bl'});
                const italic = wb.getCellValue(r, c, {type: 'it'});
                const underline = wb.getCellValue(r, c, {type: 'un'});
                const strikethrough = wb.getCellValue(r, c, {type: 'cl'});
                setToolbarState({
                    bold: !!bold,
                    italic: !!italic,
                    underline: !!underline,
                    strikethrough: !!strikethrough,
                });
            }
        } catch {
            // Selection API may not be ready
        }
    }, []);

    const handleChange = useCallback((data: Record<string, any>[]) => {
        saveSheetData(data as SheetData[]);
        updateToolbarFromSelection();
    }, [saveSheetData, updateToolbarFromSelection]);

    const handleBold = useCallback(() => {
        const wb = workbookRef.current;
        if (!wb) return;
        const sel = wb.getSelection();
        if (!sel || sel.length === 0) return;
        sel.forEach(range => {
            wb.setCellFormatByRange('bl', toolbarState.bold ? 0 : 1, range);
        });
    }, [toolbarState.bold]);

    const handleItalic = useCallback(() => {
        const wb = workbookRef.current;
        if (!wb) return;
        const sel = wb.getSelection();
        if (!sel || sel.length === 0) return;
        sel.forEach(range => {
            wb.setCellFormatByRange('it', toolbarState.italic ? 0 : 1, range);
        });
    }, [toolbarState.italic]);

    const handleUnderline = useCallback(() => {
        const wb = workbookRef.current;
        if (!wb) return;
        const sel = wb.getSelection();
        if (!sel || sel.length === 0) return;
        sel.forEach(range => {
            wb.setCellFormatByRange('un', toolbarState.underline ? 0 : 1, range);
        });
    }, [toolbarState.underline]);

    const handleStrikethrough = useCallback(() => {
        const wb = workbookRef.current;
        if (!wb) return;
        const sel = wb.getSelection();
        if (!sel || sel.length === 0) return;
        sel.forEach(range => {
            wb.setCellFormatByRange('cl', toolbarState.strikethrough ? 0 : 1, range);
        });
    }, [toolbarState.strikethrough]);


    const workbookOptions = useMemo(() => ({
        showtoolbar: false,
        showinfobar: false,
        showsheetbar: true,
        showstatisticBar: false,
        allowEdit: canWrite,
        column: 26,
        row: 100,
    }), [canWrite]);

    if (!synced || !sheetData) {
        return <EigenLoader/>;
    }

    return (
        <div className="flex flex-col h-full w-full">
            <SheetToolbar
                path={path}
                canWrite={canWrite}
                undoManager={undoManager}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
                toolbarState={toolbarState}
                onBold={handleBold}
                onItalic={handleItalic}
                onUnderline={handleUnderline}
                onStrikethrough={handleStrikethrough}
            />
            <div className="flex-1 overflow-hidden">
                <Workbook
                    ref={workbookRef}
                    data={sheetData}
                    onChange={handleChange}
                    {...workbookOptions}
                />
            </div>
        </div>
    );
}
