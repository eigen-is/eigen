import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import {
    api,
    cancelActiveImgItem,
    cancelNormalSelected,
    deleteSheet,
    editSheetName,
    en,
    getSheetIndex,
    type Sheet,
} from '../../state';
import { ColorPickerMenuItem } from '../ColorPickerMenuItem';

type Props = {
    sheet: Sheet;
    isDropPlaceholder?: boolean;
};

export const SheetItem: React.FC<Props> = ({ sheet, isDropPlaceholder }) => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const [editing, setEditing] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const editable = useRef<HTMLSpanElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const { showAlert, hideAlert } = useAlert();
    const { info, sheetconfig } = en;

    useEffect(() => {
        setContext((draftCtx) => {
            const r = context.sheetScrollRecord[draftCtx?.currentSheetId];
            if (r) {
                draftCtx.scrollRequest = { left: r.scrollLeft ?? 0, top: r.scrollTop ?? 0 };
                draftCtx.selectionActive = r.selectionActive ?? false;
                draftCtx.selections = r.selections ?? undefined;
            } else {
                draftCtx.scrollRequest = { left: 0, top: 0 };
                draftCtx.selectionActive = false;
                draftCtx.selections = undefined;
            }
            draftCtx.formulaRangeSelections = [];
        });
    }, [context.sheetScrollRecord, setContext]);

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

    const onBlur = useCallback(() => {
        setContext((draftCtx) => {
            try {
                editSheetName(draftCtx, editable.current!);
            } catch (e) {
                if (e instanceof Error) showAlert(e.message);
            }
        });
        setEditing(false);
    }, [setContext, showAlert]);

    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
        if (e.key === 'Enter') editable.current?.blur();
        e.stopPropagation();
    }, []);

    const onDragStart = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            if (context.allowEdit === true) e.dataTransfer.setData('sheetId', `${sheet.id}`);
            e.stopPropagation();
        },
        [context.allowEdit, sheet.id],
    );

    const onDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            if (context.allowEdit === false) return;
            const draggingId = e.dataTransfer.getData('sheetId');
            setContext((draftCtx) => {
                const droppingId = sheet.id;
                let draggingSheet: Sheet | undefined;
                let droppingSheet: Sheet | undefined;
                const sorted = [...draftCtx.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const [i, f] of sorted.entries()) {
                    f.order = i;
                    if (f.id === draggingId) draggingSheet = f;
                    else if (f.id === droppingId) droppingSheet = f;
                }
                if (draggingSheet && droppingSheet) {
                    draggingSheet.order = droppingSheet.order! - 0.1;
                    const resorted = [...draftCtx.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
        [context.allowEdit, isDropPlaceholder, setContext, sheet.id],
    );

    const moveSheet = useCallback(
        (delta: number) => {
            if (context.allowEdit === false || !sheet) return;
            setContext((ctx) => {
                let currentOrder = -1;
                const sorted = ctx.sheets.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const [i, _sheet] of sorted.entries()) {
                    _sheet.order = i;
                    if (_sheet.id === sheet.id) currentOrder = i;
                }
                api.setSheetOrder(ctx, { [sheet.id!]: currentOrder + delta });
            });
        },
        [context.allowEdit, setContext, sheet],
    );

    const menuItems = settings.sheetTabContextMenu?.map((name, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: separator in static config menu
        if (name === '|') return <DropdownMenuSeparator key={`divide-${i}`} />;
        if (name === 'delete') {
            return (
                <DropdownMenuItem
                    key={name}
                    onClick={() => {
                        const shownSheets = context.sheets.filter((s) => s.hide === undefined || s.hide !== 1);
                        if (context.sheets.length > 1 && shownSheets.length > 1) {
                            showAlert(sheetconfig.confirmDelete, 'yesno', () => {
                                setContext(
                                    (ctx) => {
                                        deleteSheet(ctx, sheet.id!);
                                    },
                                    { deleteSheetOp: { id: sheet.id! } },
                                );
                                hideAlert();
                            });
                        } else {
                            showAlert(sheetconfig.noMoreSheet, 'ok');
                        }
                    }}
                >
                    {sheetconfig.delete}
                </DropdownMenuItem>
            );
        }
        if (name === 'rename')
            return (
                <DropdownMenuItem key={name} onClick={() => setEditing(true)}>
                    {sheetconfig.rename}
                </DropdownMenuItem>
            );
        if (name === 'copy') {
            return (
                <DropdownMenuItem
                    key={name}
                    onClick={() => {
                        if (context.allowEdit === false || !sheet?.id) return;
                        setContext(
                            (ctx) => {
                                api.copySheet(ctx, sheet.id!);
                            },
                            { addSheetOp: true },
                        );
                    }}
                >
                    {sheetconfig.copy}
                </DropdownMenuItem>
            );
        }
        if (name === 'hide') {
            return (
                <DropdownMenuItem
                    key={name}
                    onClick={() => {
                        if (context.allowEdit === false || !sheet) return;
                        setContext((ctx) => {
                            const shownSheets = ctx.sheets.filter((s) => s.hide === undefined || s.hide !== 1);
                            if (shownSheets.length > 1) api.hideSheet(ctx, sheet.id as string);
                            else showAlert(sheetconfig.noMoreSheet, 'ok');
                        });
                    }}
                >
                    {sheetconfig.hide}
                </DropdownMenuItem>
            );
        }
        if (name === 'move') {
            return (
                <React.Fragment key={name}>
                    <DropdownMenuItem onClick={() => moveSheet(-1.5)}>{sheetconfig.moveLeft}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => moveSheet(1.5)}>{sheetconfig.moveRight}</DropdownMenuItem>
                </React.Fragment>
            );
        }
        if (name === 'color') {
            return (
                <ColorPickerMenuItem
                    key={name}
                    label={sheetconfig.changeColor}
                    value={sheet.color ?? ''}
                    resetLabel={sheetconfig.resetColor}
                    onChange={(color) => {
                        if (context.allowEdit === false || !sheet?.id) return;
                        setContext((ctx) => {
                            const index = getSheetIndex(ctx, sheet.id!);
                            if (index != null) ctx.sheets[index].color = color || undefined;
                        });
                    }}
                />
            );
        }
        if (name === 'focus') {
            return (
                <DropdownMenuItem
                    key={name}
                    onClick={() => {
                        if (context.allowEdit === false || !sheet?.id) return;
                        setContext((ctx) => {
                            for (const f of ctx.sheets) f.status = sheet.id === f.id ? 1 : 0;
                        });
                    }}
                >
                    {sheetconfig.focus}
                </DropdownMenuItem>
            );
        }
        return null;
    });

    const selectSheet = useCallback(() => {
        if (isDropPlaceholder) return;
        setContext((draftCtx) => {
            draftCtx.sheetScrollRecord[draftCtx.currentSheetId] = {
                scrollLeft: draftCtx.scrollLeft,
                scrollTop: draftCtx.scrollTop,
                selectionActive: draftCtx.selectionActive,
                selections: draftCtx.selections,
                formulaRangeSelections: draftCtx.formulaRangeSelections,
            };
            draftCtx.dataVerificationDropDownList = false;
            draftCtx.currentSheetId = sheet.id!;
            cancelActiveImgItem(draftCtx, refs.globalCache);
            cancelNormalSelected(draftCtx);
        });
    }, [isDropPlaceholder, setContext, sheet, refs.globalCache]);

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
                isDropPlaceholder ? 'w-8' : 'cursor-pointer px-2 text-xs transition-colors',
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
                            aria-label={info.sheetOptions}
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
