import { escapeHtml } from '@workspace/lib/html';
import { isEqual } from 'es-toolkit/compat';
import type React from 'react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useFormulaAutocomplete } from '../../hooks/useFormulaAutocomplete';
import { usePrevious } from '../../hooks/usePrevious';
import {
    cancelNormalSelected,
    createRangeHightlight,
    getFlowdata,
    getFormulaHtml,
    getInlineStringHTML,
    getStyleByCell,
    handleFormulaInput,
    isAllowEdit,
    isInlineStringCell,
    israngeseleciton,
    isShowHidenCR,
    moveHighlightCell,
    moveToEnd,
    valueShowEs,
} from '../../state';
import { ContentEditable } from './ContentEditable';
import { FormulaHint } from './FormulaHint';
import { FormulaSearch } from './FormulaSearch';
import { cycleReferenceInEditor } from './reference-cycle';

export const InputBox: React.FC = () => {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const inputRef = useRef<HTMLDivElement>(null);
    const lastKeyDownEventRef = useRef<KeyboardEvent>(null);
    const prevEditingCellPosition = usePrevious<unknown[]>(context.editingCellPosition);
    const prevSheetId = usePrevious<string>(context.currentSheetId);
    const [isHidenRC, setIsHidenRC] = useState<boolean>(false);
    const firstSelection = context.selections?.[0];
    const row_index = firstSelection?.row_focus as number;
    const col_index = firstSelection?.column_focus as number;
    const preText = useRef('');

    // biome-ignore lint/correctness/useExhaustiveDependencies: cell-style memo keyed on sheet/file/cellUpdate; reads helpers off `context` directly
    const inputBoxStyle = useMemo(() => {
        if (firstSelection && context.editingCellPosition.length > 0) {
            const flowdata = getFlowdata(context);
            if (!flowdata) return {};
            return getStyleByCell(context, flowdata, firstSelection.row_focus!, firstSelection.column_focus!);
        }
        return {};
    }, [context.sheets, context.currentSheetId, context.editingCellPosition, firstSelection]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: cell-edit sync — collaborative-update guard relies on prev refs, not React deps; firing on every refs.* change would clobber the editor
    useLayoutEffect(() => {
        if (!context.allowEdit) {
            setContext((ctx) => {
                const flowdata = getFlowdata(ctx);
                if (flowdata != null && ctx.forceFormulaRef) {
                    const formulaHtml = getFormulaHtml(row_index, col_index, flowdata);
                    if (formulaHtml) createRangeHightlight(ctx, formulaHtml);
                }
            });
        }
        if (firstSelection && context.editingCellPosition.length > 0) {
            if (refs.globalCache.doNotUpdateCell) {
                delete refs.globalCache.doNotUpdateCell;
                return;
            }
            if (
                isEqual(prevEditingCellPosition, context.editingCellPosition) &&
                prevSheetId === context.currentSheetId
            ) {
                // data change by a collaborative update should not trigger this effect
                return;
            }
            const flowdata = getFlowdata(context);
            const cell = flowdata?.[row_index]?.[col_index];
            let value = '';
            // Set when `value` is markup we generated rather than raw cell text.
            let isGeneratedHtml = false;
            if (cell && !refs.globalCache.overwriteCell) {
                if (isInlineStringCell(cell)) {
                    value = getInlineStringHTML(row_index, col_index, flowdata);
                    isGeneratedHtml = true;
                } else if (cell.f) {
                    // Coloured spans, escaped at their leaves — render, do not escape again.
                    // createRangeHightlight parses those spans, so it wants the markup too.
                    value = getFormulaHtml(row_index, col_index, flowdata) ?? '';
                    isGeneratedHtml = true;
                    const formulaHtml = value;
                    setContext((ctx) => {
                        createRangeHightlight(ctx, formulaHtml);
                    });
                } else {
                    const shown = valueShowEs(row_index, col_index, flowdata);
                    value = shown == null ? '' : String(shown);
                }
            }
            refs.globalCache.overwriteCell = false;
            if (!refs.globalCache.ignoreWriteCell)
                inputRef.current!.innerHTML = isGeneratedHtml ? value : escapeHtml(value);
            refs.globalCache.ignoreWriteCell = false;
            if (!refs.globalCache.doNotFocus) {
                // Synchronously too: the innerHTML write leaves the caret at 0, and
                // fast typing can land before the timeout below — the keystrokes
                // would insert mid-value. The deferred pass still runs after the
                // click handler's focus-follow timeout settles focus on the input.
                moveToEnd(inputRef.current!);
                setTimeout(() => {
                    moveToEnd(inputRef.current!);
                });
            }
            delete refs.globalCache.doNotFocus;
        }
    }, [context.editingCellPosition, context.sheets, context.currentSheetId, firstSelection]);

    useEffect(() => {
        if (context.editingCellPosition.length === 0) {
            if (inputRef.current) {
                inputRef.current.innerHTML = '';
            }
        }
    }, [context.editingCellPosition]);

    // Disallow editing when the selected row/column is hidden
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-checks hidden-row/col status when selection changes
    useEffect(() => {
        setIsHidenRC(isShowHidenCR(context));
    }, [context.selections]);

    const [inputFocused, setInputFocused] = useState(false);
    const formulaAutocomplete = useFormulaAutocomplete({ targetRef: inputRef, enabled: inputFocused });

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            lastKeyDownEventRef.current = new KeyboardEvent(e.type, e.nativeEvent);
            preText.current = inputRef.current!.innerText;

            // Alt/Meta+Enter inserts a newline regardless of suggest visibility (originally `enterKeyControll`).
            if (e.key === 'Enter' && (e.altKey || e.metaKey) && context.editingCellPosition.length > 0) {
                document.execCommand('insertHTML', false, '\n '); // Trailing space forces a line break; removed by the subsequent delete
                document.execCommand('delete', false);
                e.stopPropagation();
                return;
            }

            if (formulaAutocomplete.handleKeyDown(e)) return;

            if (e.key === 'Escape' && context.editingCellPosition.length > 0) {
                setContext((draftCtx) => {
                    cancelNormalSelected(draftCtx);
                    moveHighlightCell(draftCtx, 'down', 0, 'rangeOfSelect');
                });
                e.preventDefault();
            } else if (e.key === 'F4' && context.editingCellPosition.length > 0) {
                // Cycle the reference at the caret (A1 → $A$1 → A$1 → $A1 → A1); keep the
                // browser default suppressed even when the caret isn't on a reference.
                e.preventDefault();
                cycleReferenceInEditor(inputRef.current!, refs.fxInput.current, setContext);
            } else if (
                context.editingCellPosition.length > 0 &&
                (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')
            ) {
                e.preventDefault();
            }
        },
        [context.editingCellPosition.length, formulaAutocomplete.handleKeyDown, refs.fxInput, setContext],
    );

    const onChange = useCallback(
        (__: unknown, isBlur?: boolean) => {
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
                    if (
                        (draftCtx.formulaCache.rangestart ||
                            draftCtx.formulaCache.rangedrag_column_start ||
                            draftCtx.formulaCache.rangedrag_row_start ||
                            israngeseleciton(draftCtx)) &&
                        isBlur
                    )
                        return;
                    if (!isAllowEdit(draftCtx, draftCtx.selections)) {
                        return;
                    }
                    handleFormulaInput(draftCtx, refs.fxInput.current, refs.cellInput.current!, kcode, preText.current);
                });
            }
        },
        [refs.cellInput, refs.fxInput, setContext],
    );

    const onPaste = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            if (context.editingCellPosition.length === 0) {
                e.preventDefault();
            }
        },
        [context.editingCellPosition],
    );

    const cfg = context.config || {};
    const rowReadOnly: Record<string, number> = cfg.rowReadOnly || {};
    const colReadOnly: Record<string, number> = cfg.colReadOnly || {};

    const edit = !((colReadOnly[col_index] || rowReadOnly[row_index]) && context.allowEdit === true);

    return (
        <div
            className="luckysheet-input-box"
            style={
                firstSelection && !context.rangeDialog?.show
                    ? {
                          left: firstSelection.left,
                          top: firstSelection.top,
                          zIndex: context.editingCellPosition.length === 0 ? -1 : 19,
                          // z:-1 no longer hides the box: inside the overlay layer's
                          // transformed content div (a stacking context) it can't sink
                          // below the canvas. opacity 0 hides it while keeping the cell
                          // input focusable at the cell position (display/visibility
                          // would break focus; off-screen focus auto-scrolls the grid),
                          // and pointer-events none keeps it unhittable like the old
                          // behind-the-canvas box (opacity 0 alone still hit-tests, and
                          // the box's stopPropagation would swallow focus-cell clicks).
                          // While editing it must be an explicit auto: the pane-region
                          // wrapper is pointer-events none, and inheriting that would
                          // kill caret clicks in the open editor.
                          opacity: context.editingCellPosition.length === 0 ? 0 : 1,
                          pointerEvents: context.editingCellPosition.length === 0 ? 'none' : 'auto',
                          display: 'block',
                      }
                    : { left: -10000, top: -10000, display: 'block' }
            }
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
        >
            <div
                className="luckysheet-input-box-inner"
                style={
                    firstSelection
                        ? {
                              minWidth: firstSelection?.width || 0,
                              minHeight: firstSelection?.height || 0,
                              ...inputBoxStyle,
                          }
                        : {}
                }
            >
                <ContentEditable
                    innerRef={(e) => {
                        inputRef.current = e;
                        refs.cellInput.current = e;
                    }}
                    className="luckysheet-cell-input"
                    id="luckysheet-rich-text-editor"
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    allowEdit={edit ? !isHidenRC : edit}
                />
            </div>
            <FormulaSearch
                anchorRef={inputRef}
                open={inputFocused}
                selectedIndex={formulaAutocomplete.selectedIndex}
                onSelect={formulaAutocomplete.insertFormula}
                onItemsChange={formulaAutocomplete.onItemsChange}
            />
            <FormulaHint anchorRef={inputRef} open={inputFocused} />
        </div>
    );
};
