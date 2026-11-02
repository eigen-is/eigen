// One tab in the sheet tab strip: its name, renamed in place on a double click, its color, its context menu,
// and the drag and drop that moves it. A drop renumbers every sheet's order from 0.

import { MenuSections } from '@workspace/ui/components/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { Sheet } from '../../state';
import {
    api,
    cancelNormalSelected,
    changeSheet,
    deleteSheet,
    deselectFloatingObject,
    editSheetName,
    getSheetIndex,
    sheetOrder,
} from '../../state';

// The workbook always shows one sheet, so its last shown sheet can't be hidden or deleted.
const LAST_SHEET_DELETE =
    'A workbook always shows at least one sheet. To delete this sheet, add a sheet or show a hidden one first.';
const LAST_SHEET_HIDE =
    'A workbook always shows at least one sheet. To hide this sheet, add a sheet or show a hidden one first.';

type Props = {
    id: string;
    sheet: Sheet;
    isDropPlaceholder?: boolean;
};

export const SheetItem: React.FC<Props> = ({ id, sheet, isDropPlaceholder }) => {
    const { context, setContext } = useContext(WorkbookContext);
    const [editing, setEditing] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const editable = useRef<HTMLSpanElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const { showNotice } = useDialog();

    useEffect(() => {
        if (!editable.current) return;
        if (editing) {
            const range = document.createRange();
            range.selectNodeContents(editable.current);
            if (range.startContainer && document.body.contains(range.startContainer)) {
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            }
        }
        editable.current.dataset.oldText = editable.current.innerText;
    }, [editing]);

    // A refused name throws out of the write, which then applies nothing, and the notice opens outside the recipe.
    const onBlur = useCallback(() => {
        const input = editable.current;
        if (input) {
            try {
                setContext((draftCtx) => editSheetName(draftCtx, input));
            } catch (e) {
                if (e instanceof Error) showNotice(e.message);
            }
        }
        setEditing(false);
    }, [setContext, showNotice]);

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
        // The blur may open a notice whose OK button takes the focus at once, and the browser would send this Enter's
        // keypress on to that button and close the notice.
        if (e.key === 'Enter') {
            e.preventDefault();
            editable.current?.blur();
        }
        e.stopPropagation();
    }, []);

    const onDragStart = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            if (context.allowEdit === true) e.dataTransfer.setData('sheetId', id);
            e.stopPropagation();
        },
        [context.allowEdit, id],
    );

    const onDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            if (context.allowEdit === false) return;
            const draggingId = e.dataTransfer.getData('sheetId');
            setContext((draftCtx) => {
                let draggingSheet: Sheet | undefined;
                let droppingSheet: Sheet | undefined;
                const sorted = [...draftCtx.sheets].sort((a, b) => sheetOrder(a) - sheetOrder(b));
                for (const [i, f] of sorted.entries()) {
                    f.order = i;
                    if (f.id === draggingId) draggingSheet = f;
                    else if (f.id === id) droppingSheet = f;
                }
                if (draggingSheet && droppingSheet) {
                    draggingSheet.order = sheetOrder(droppingSheet) - 0.1;
                    const resorted = [...draftCtx.sheets].sort((a, b) => sheetOrder(a) - sheetOrder(b));
                    for (const [i, f] of resorted.entries()) {
                        f.order = i;
                    }
                } else if (draggingSheet && isDropPlaceholder) {
                    draggingSheet.order = draftCtx.sheets.length;
                }
            });
            setDragOver(false);
            e.stopPropagation();
        },
        [context.allowEdit, isDropPlaceholder, setContext, id],
    );

    const moveSheet = useCallback(
        (delta: number) => {
            if (context.allowEdit === false) return;
            setContext((ctx) => {
                let currentOrder = -1;
                const sorted = ctx.sheets.slice().sort((a, b) => sheetOrder(a) - sheetOrder(b));
                for (const [i, s] of sorted.entries()) {
                    s.order = i;
                    if (s.id === id) currentOrder = i;
                }
                api.setSheetOrder(ctx, { [id]: currentOrder + delta });
            });
        },
        [context.allowEdit, setContext, id],
    );

    const isLastShownSheet = context.sheets.filter((s) => s.hide !== 1).length < 2;

    const menuItems = (
        <MenuSections
            create={
                <>
                    <DropdownMenuItem onClick={() => setEditing(true)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            if (context.allowEdit === false) return;
                            setContext(
                                (ctx) => {
                                    api.copySheet(ctx, id);
                                },
                                { addSheetOp: true },
                            );
                        }}
                    >
                        Duplicate
                    </DropdownMenuItem>
                </>
            }
            organize={
                <>
                    <ColorPickerMenuItem
                        label="Change color"
                        value={sheet.color ?? ''}
                        resetLabel="Reset color"
                        contentClassName="sheet-mousedown-cancel"
                        onChange={(color) => {
                            if (context.allowEdit === false) return;
                            setContext((ctx) => {
                                const index = getSheetIndex(ctx, id);
                                if (index != null) ctx.sheets[index].color = color || undefined;
                            });
                        }}
                    />
                    <DropdownMenuItem
                        onClick={() => {
                            if (context.allowEdit === false) return;
                            if (isLastShownSheet) showNotice(LAST_SHEET_HIDE);
                            else setContext((ctx) => api.hideSheet(ctx, id));
                        }}
                    >
                        Hide
                    </DropdownMenuItem>
                </>
            }
            arrange={
                <>
                    <DropdownMenuItem onClick={() => moveSheet(-1.5)}>Move left</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => moveSheet(1.5)}>Move right</DropdownMenuItem>
                </>
            }
            destructive={
                <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                        if (isLastShownSheet) {
                            showNotice(LAST_SHEET_DELETE);
                            return;
                        }
                        showNotice(`Delete the sheet "${sheet.name}"?`, 'yesno', () => {
                            setContext((ctx) => deleteSheet(ctx, id), { deleteSheetOp: { id } });
                        });
                    }}
                >
                    Delete
                </DropdownMenuItem>
            }
        />
    );

    const selectSheet = useCallback(() => {
        if (isDropPlaceholder) return;
        setContext((draftCtx) => {
            changeSheet(draftCtx, id);
            deselectFloatingObject(draftCtx);
            cancelNormalSelected(draftCtx);
        });
    }, [isDropPlaceholder, setContext, id]);

    const onRootKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (editing || isDropPlaceholder) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                // Stop the key bubbling to the workbook grid handler (Space would otherwise start editing
                // the focused cell); mirrors the rename-span handler below.
                e.stopPropagation();
                selectSheet();
            }
        },
        [editing, isDropPlaceholder, selectSheet],
    );

    const isActive = !isDropPlaceholder && context.currentSheetId === sheet.id;

    return (
        <div
            role="button"
            aria-current={isActive || undefined}
            onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
            }}
            onDragEnter={(e) => {
                setDragOver(true);
                e.stopPropagation();
            }}
            onDragLeave={(e) => {
                setDragOver(false);
                e.stopPropagation();
            }}
            onDragEnd={(e) => {
                setDragOver(false);
                e.stopPropagation();
            }}
            onDrop={onDrop}
            onDragStart={onDragStart}
            draggable={context.allowEdit && !editing}
            key={sheet.id}
            className={cn(
                'relative flex shrink-0 items-center outline-hidden',
                isDropPlaceholder ? 'w-8' : 'cursor-pointer px-2 text-xs',
                !isDropPlaceholder &&
                    (isActive
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:bg-background hover:text-foreground'),
                dragOver && 'border-l-2 border-primary',
                sheet.hide === 1 && 'hidden',
            )}
            onClick={selectSheet}
            onKeyDown={onRootKeyDown}
            onContextMenu={
                context.allowEdit && !isDropPlaceholder
                    ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          selectSheet();
                          setMenuOpen(true);
                      }
                    : undefined
            }
            tabIndex={0}
        >
            <span
                className={cn(
                    'px-0.5 outline-hidden',
                    editing && 'min-w-2 select-text rounded-sm border border-input bg-background focus:border-ring',
                )}
                spellCheck="false"
                suppressContentEditableWarning
                contentEditable={isDropPlaceholder ? false : editing}
                onDoubleClick={() => setEditing(true)}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                ref={editable}
                style={dragOver ? { pointerEvents: 'none' } : undefined}
            >
                {sheet.name}
            </span>
            {context.allowEdit && !isDropPlaceholder && (
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger asChild>
                        <span
                            className="ml-0.5 inline-flex text-muted-foreground hover:text-foreground"
                            // Select this tab before opening its menu (like the right-click path), so
                            // color and every other action target this sheet, not the active one.
                            onClick={(e) => {
                                e.stopPropagation();
                                selectSheet();
                            }}
                            tabIndex={0}
                            aria-label="Sheet options"
                        >
                            <ChevronDown width={12} height={12} aria-hidden="true" />
                        </span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" collisionPadding={8}>
                        {menuItems}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {!!sheet.color && (
                <span
                    className="absolute inset-x-0 bottom-0 h-1"
                    style={{ backgroundColor: sheet.color }}
                    aria-hidden="true"
                />
            )}
        </div>
    );
};
