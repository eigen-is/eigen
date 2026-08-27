import { escapeHtml } from '@workspace/lib/html';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useFormulaAutocomplete } from '../../hooks/useFormulaAutocomplete';
import { usePrevious } from '../../hooks/usePrevious';
import {
    cancelNormalSelected,
    en,
    getCellValue,
    getFlowdata,
    getInlineStringNoStyle,
    handleFormulaInput,
    isAllowEdit,
    isInlineStringCell,
    isShowHidenCR,
    moveHighlightCell,
    rangeHightlightselected,
    updateCell,
    valueShowEs,
} from '../../state';
import { ContentEditable } from '../SheetOverlay/ContentEditable';
import { FormulaHint } from '../SheetOverlay/FormulaHint';
import { FormulaSearch } from '../SheetOverlay/FormulaSearch';
import { cycleReferenceInEditor } from '../SheetOverlay/reference-cycle';
import { NameBox } from './NameBox';

export function FxEditor() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const [focused, setFocused] = useState(false);
    const lastKeyDownEventRef = useRef<KeyboardEvent>(null);
    const [isHidenRC, setIsHidenRC] = useState<boolean>(false);
    const firstSelection = context.selections?.[0];
    const prevFirstSelection = usePrevious(firstSelection);
    const prevSheetId = usePrevious(context.currentSheetId);
    const recentText = useRef('');
    const { info } = en;

    // biome-ignore lint/correctness/useExhaustiveDependencies: re-renders fx box only on real cell/sheet/selection changes; prev-selection comparison avoids collaborative-update echo
    useEffect(() => {
        // If selected row/column is in hidden state, don't allow editing
        setIsHidenRC(isShowHidenCR(context));
        if (
            JSON.stringify(prevFirstSelection) === JSON.stringify(firstSelection) &&
            context.currentSheetId === prevSheetId
        ) {
            // data change by a collabrative update should not trigger this effect
            return;
        }
        const d = getFlowdata(context);
        let value = '';
        if (firstSelection) {
            const r = firstSelection.row_focus;
            const c = firstSelection.column_focus;
            if (r == null || c == null) return;

            const cell = d?.[r]?.[c];
            if (cell) {
                if (isInlineStringCell(cell)) {
                    value = getInlineStringNoStyle(r, c, d);
                } else if (cell.f) {
                    value = getCellValue(r, c, d, 'f');
                } else {
                    const shown = valueShowEs(r, c, d);
                    value = shown == null ? '' : String(shown);
                }
            }
            refs.fxInput.current!.innerHTML = escapeHtml(value);
        } else {
            refs.fxInput.current!.innerHTML = '';
        }
    }, [context.sheets, context.currentSheetId, context.selections]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: callback only refreshed when sheet/selection-shape changes — derived helpers (allowEdit, etc.) are read fresh from `context`
    const onFocus = useCallback(() => {
        if (context.allowEdit === false) {
            return;
        }
        if (
            (context.selections?.length ?? 0) > 0 &&
            !context.cellSelectMoving &&
            isAllowEdit(context, context.selections)
        ) {
            setFocused(true);
            setContext((draftCtx) => {
                const last = draftCtx.selections![draftCtx.selections!.length - 1];

                if (last.row_focus == null || last.column_focus == null) return;
                draftCtx.editingCellPosition = [last.row_focus, last.column_focus];
                refs.globalCache.doNotFocus = true;
            });
        }
    }, [context.config, context.selections, context.sheets, context.currentSheetId, refs.globalCache, setContext]);

    const formulaAutocomplete = useFormulaAutocomplete({ targetRef: refs.fxInput, enabled: focused });

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (context.allowEdit === false) {
                return;
            }
            lastKeyDownEventRef.current = new KeyboardEvent(e.type, e.nativeEvent);
            const { key } = e;
            recentText.current = refs.fxInput.current!.innerText;
            if (key === 'ArrowLeft' || key === 'ArrowRight') {
                e.stopPropagation();
            }

            if (formulaAutocomplete.handleKeyDown(e)) return;

            if (key === 'F4' && context.editingCellPosition.length > 0) {
                // Cycle the reference at the caret (A1 → $A$1 → A$1 → $A1 → A1); keep the
                // browser default suppressed even when the caret isn't on a reference.
                e.preventDefault();
                cycleReferenceInEditor(refs.fxInput.current!, refs.cellInput.current, setContext);
                return;
            }

            setContext((draftCtx) => {
                if (context.editingCellPosition.length > 0) {
                    switch (key) {
                        case 'Enter': {
                            const lastEditingCellPosition = [...draftCtx.editingCellPosition];
                            updateCell(
                                draftCtx,
                                draftCtx.editingCellPosition[0],
                                draftCtx.editingCellPosition[1],
                                refs.fxInput.current!,
                            );
                            draftCtx.selections = [
                                {
                                    row: [lastEditingCellPosition[0], lastEditingCellPosition[0]],
                                    column: [lastEditingCellPosition[1], lastEditingCellPosition[1]],
                                    row_focus: lastEditingCellPosition[0],
                                    column_focus: lastEditingCellPosition[1],
                                },
                            ];
                            moveHighlightCell(draftCtx, 'down', 1, 'rangeOfSelect');
                            e.preventDefault();
                            e.stopPropagation();
                            break;
                        }
                        case 'Escape': {
                            cancelNormalSelected(draftCtx);
                            moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
                            e.preventDefault();
                            e.stopPropagation();
                            break;
                        }
                        case 'ArrowLeft': {
                            rangeHightlightselected(draftCtx, refs.fxInput.current!);
                            break;
                        }
                        case 'ArrowRight': {
                            rangeHightlightselected(draftCtx, refs.fxInput.current!);
                            break;
                        }
                        default:
                            break;
                    }
                }
            });
        },
        [
            context.allowEdit,
            context.editingCellPosition.length,
            formulaAutocomplete.handleKeyDown,
            refs.cellInput,
            refs.fxInput,
            setContext,
        ],
    );

    const onChange = useCallback(() => {
        const e = lastKeyDownEventRef.current;
        if (!e) return;
        const kcode = e.keyCode;
        if (!kcode) return;

        if (
            !(
                (kcode >= 112 && kcode <= 123) ||
                kcode <= 46 ||
                kcode === 144 ||
                kcode === 108 ||
                e.ctrlKey ||
                e.altKey ||
                (e.shiftKey && (kcode === 37 || kcode === 38 || kcode === 39 || kcode === 40))
            ) ||
            kcode === 8 ||
            kcode === 32 ||
            kcode === 46 ||
            (e.ctrlKey && kcode === 86)
        ) {
            setContext((draftCtx) => {
                handleFormulaInput(draftCtx, refs.cellInput.current!, refs.fxInput.current!, kcode, recentText.current);
            });
        }
    }, [refs.cellInput, refs.fxInput, setContext]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluates allowEdit only on the listed shape changes — internals of `context` are read directly
    const allowEdit = useMemo(() => {
        if (context.allowEdit === false) {
            return false;
        }
        if (isHidenRC) {
            return false;
        }
        if (!isAllowEdit(context, context.selections)) {
            return false;
        }
        return true;
    }, [context.config, context.selections, context.sheets, context.currentSheetId, isHidenRC]);

    return (
        // eigen-paper: the formula bar reads like the grid — light in dark mode too (globals.css)
        <aside className="eigen-paper">
            <div className="flex flex-row h-7 border-b border-border bg-muted">
                <NameBox />
                <div className="overflow-visible p-0 flex-1 flex items-center relative">
                    <ContentEditable
                        innerRef={(e) => {
                            refs.fxInput.current = e;
                        }}
                        className="flex-1 max-h-full overflow-y-auto pl-0.5 text-xs m-0 outline-none cursor-text whitespace-pre-wrap break-words box-border text-foreground text-left"
                        role="textbox"
                        id="luckysheet-functionbox-cell"
                        aria-label={info.currentCellInput}
                        onFocus={onFocus}
                        onKeyDown={onKeyDown}
                        onChange={onChange}
                        onBlur={() => setFocused(false)}
                        tabIndex={0}
                        allowEdit={allowEdit}
                    />
                    <FormulaSearch
                        anchorRef={refs.fxInput}
                        open={focused}
                        selectedIndex={formulaAutocomplete.selectedIndex}
                        onSelect={formulaAutocomplete.insertFormula}
                        onItemsChange={formulaAutocomplete.onItemsChange}
                    />
                    <FormulaHint anchorRef={refs.fxInput} open={focused} />
                </div>
            </div>
        </aside>
    );
}
