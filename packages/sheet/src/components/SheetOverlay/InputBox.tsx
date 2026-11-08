// The in-cell editor: a contenteditable over the cell being edited. openCellEditor fills it, the grid's
// keyboard handlers commit it, and it empties itself as it closes. While it is open on text, ⌘B, ⌘I and ⌘U
// format its selected characters, a format on a bare caret styles the text typed there next, text typed over a
// selection takes the style of its first character, and a paste inserts plain text. It waits off-screen while the
// range picker is open, so a press on the grid picks.

import { matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import type React from 'react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { useFormulaAutocomplete } from '../../hooks/useFormulaAutocomplete';
import {
    cancelNormalSelected,
    forgetEditorSelection,
    getFlowdata,
    getStyleByCell,
    handleBold,
    handleFormulaInput,
    handleItalic,
    handleUnderline,
    israngeseleciton,
    isSelectionOnHiddenRowCol,
    loadCellFont,
    moveHighlightCell,
    rememberEditorSelection,
    SHEET_HOTKEYS,
    typeStyledText,
    typesIntoEditor,
} from '../../state';
import { ContentEditable } from './ContentEditable';
import { FormulaHint } from './FormulaHint';
import { FormulaSearch } from './FormulaSearch';
import { cycleReferenceInEditor } from './reference-cycle';

const FORMAT_SHORTCUTS = [
    [SHEET_HOTKEYS.bold, handleBold],
    [SHEET_HOTKEYS.italic, handleItalic],
    [SHEET_HOTKEYS.underline, handleUnderline],
] as const;

export const InputBox: React.FC = () => {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { pickerOpen } = useDialog();
    const inputRef = useRef<HTMLDivElement>(null);
    const lastKeyDownEventRef = useRef<KeyboardEvent>(null);
    const [isOnHiddenRowCol, setIsOnHiddenRowCol] = useState<boolean>(false);
    // The editor opens on the last selected range, so its box and style follow that one.
    const selection = context.selections?.at(-1);
    const focusRow = selection?.row_focus;
    const focusColumn = selection?.column_focus;
    const preText = useRef('');

    // biome-ignore lint/correctness/useExhaustiveDependencies: cell-style memo keyed on sheet/file/cellUpdate; reads helpers off `context` directly
    const inputBoxStyle = useMemo(() => {
        if (focusRow != null && focusColumn != null && context.editingCellPosition.length > 0) {
            const flowdata = getFlowdata(context);
            if (!flowdata) return {};
            return getStyleByCell(context, flowdata, focusRow, focusColumn);
        }
        return {};
    }, [context.sheets, context.currentSheetId, context.editingCellPosition, selection]);

    // Here and not in cancelNormalSelected, because a peer's batch that fails rolls its close back, and the typed text
    // must survive that. A layout effect, so it can't run after the write of the next opener.
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (context.editingCellPosition.length === 0 && input) {
            input.innerHTML = '';
            forgetEditorSelection(input);
        }
    }, [context.editingCellPosition]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-checks hidden-row/col status when selection changes
    useEffect(() => {
        setIsOnHiddenRowCol(isSelectionOnHiddenRowCol(context));
    }, [context.selections]);

    // The selection is kept for a toolbar control that takes the focus, such as the size box.
    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        const remember = () => rememberEditorSelection(input);
        input.ownerDocument.addEventListener('selectionchange', remember);
        return () => input.ownerDocument.removeEventListener('selectionchange', remember);
    }, []);

    // Text typed where a format left a pending style, or over a styled selection, is inserted in its style,
    // so the browser's own insert is replaced by one that goes through the same input event.
    const [editingRow, editingColumn] = context.editingCellPosition;
    const editingCell = getFlowdata(context)?.[editingRow]?.[editingColumn];
    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        const typeStyled = (e: InputEvent) => {
            if (e.inputType !== 'insertText' || !e.data || !typeStyledText(input, editingCell, e.data)) return;
            e.preventDefault();
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        input.addEventListener('beforeinput', typeStyled);
        return () => input.removeEventListener('beforeinput', typeStyled);
    }, [editingCell]);

    const [inputFocused, setInputFocused] = useState(false);
    const formulaAutocomplete = useFormulaAutocomplete({ targetRef: inputRef, enabled: inputFocused });

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            const input = inputRef.current;
            if (!input) return;
            lastKeyDownEventRef.current = new KeyboardEvent(e.type, e.nativeEvent);
            preText.current = input.innerText;

            // Alt or Meta with Enter inserts a newline, whether or not the suggestions show.
            if (e.key === 'Enter' && (e.altKey || e.metaKey) && context.editingCellPosition.length > 0) {
                document.execCommand('insertHTML', false, '\n '); // Trailing space forces a line break; removed by the subsequent delete
                document.execCommand('delete', false);
                e.stopPropagation();
                return;
            }

            const formatShortcut = FORMAT_SHORTCUTS.find(([hotkey]) => matchesKeyboardEvent(e.nativeEvent, hotkey));
            if (formatShortcut && context.editingCellPosition.length > 0) {
                const [, format] = formatShortcut;
                e.preventDefault();
                setContext((draftCtx) => format(draftCtx, input));
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
                cycleReferenceInEditor(input, refs.fxInput.current, setContext);
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
            if (inputRef.current) loadCellFont(editingCell, inputRef.current.innerText);
            const e = lastKeyDownEventRef.current;
            if (!e?.keyCode || !typesIntoEditor(e)) return;

            setContext((draftCtx) => {
                if (
                    (draftCtx.formulaCache.rangestart ||
                        draftCtx.formulaCache.rangedrag_column_start ||
                        draftCtx.formulaCache.rangedrag_row_start ||
                        israngeseleciton(draftCtx)) &&
                    isBlur
                )
                    return;
                const input = refs.cellInput.current;
                if (!input || draftCtx.allowEdit === false) {
                    return;
                }
                handleFormulaInput(draftCtx, refs.fxInput.current, input, e.keyCode, preText.current);
            });
        },
        [editingCell, refs.cellInput, refs.fxInput, setContext],
    );

    // A paste into the open editor is its plain text, as in Google Sheets: it types as typed text would,
    // and the browser's undo keeps it. The grid pastes a closed cell.
    const onPaste = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            e.preventDefault();
            const input = inputRef.current;
            if (context.editingCellPosition.length === 0 || !input) return;
            const text = e.clipboardData.getData('text/plain');
            if (typeStyledText(input, editingCell, text)) input.dispatchEvent(new Event('input', { bubbles: true }));
            else document.execCommand('insertText', false, text);
        },
        [context.editingCellPosition, editingCell],
    );

    return (
        <div
            className="sheet-input-box"
            style={
                selection && !pickerOpen
                    ? {
                          left: selection.left,
                          top: selection.top,
                          zIndex: context.editingCellPosition.length === 0 ? -1 : 19,
                          // A closed editor stays focusable at its cell, because hiding it would break focus and
                          // focus off-screen scrolls the grid. It must not take clicks, or its stopPropagation would
                          // swallow them. An open one needs an explicit auto, since the pane-region wrapper sets none.
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
                className="sheet-input-box-inner"
                style={
                    selection
                        ? {
                              minWidth: selection.width || 0,
                              minHeight: selection.height || 0,
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
                    className="sheet-cell-input"
                    id="sheet-rich-text-editor"
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    allowEdit={!isOnHiddenRowCol}
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
