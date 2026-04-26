import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
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
    locale,
    type Sheet,
} from '../../state';
import { ChangeColor } from '../ChangeColor';

type Props = {
    sheet: Sheet;
    isDropPlaceholder?: boolean;
};

type MenuItemComponents = {
    Item: typeof ContextMenuItem;
    Separator: typeof ContextMenuSeparator;
    Sub: typeof ContextMenuSub;
    SubTrigger: typeof ContextMenuSubTrigger;
    SubContent: typeof ContextMenuSubContent;
};

export const SheetItem: React.FC<Props> = ({ sheet, isDropPlaceholder }) => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const [editing, setEditing] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const editable = useRef<HTMLSpanElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const [svgColor, setSvgColor] = useState<string>('#c3c3c3');
    const { showAlert, hideAlert } = useAlert();
    const { info, sheetconfig } = locale(context);

    useEffect(() => {
        setContext((draftCtx) => {
            const r = context.sheetScrollRecord[draftCtx?.currentSheetId];
            if (r) {
                draftCtx.scrollLeft = r.scrollLeft ?? 0;
                draftCtx.scrollTop = r.scrollTop ?? 0;
                draftCtx.luckysheet_select_status = r.luckysheet_select_status ?? false;
                draftCtx.luckysheet_select_save = r.luckysheet_select_save ?? undefined;
            } else {
                draftCtx.scrollLeft = 0;
                draftCtx.scrollTop = 0;
                draftCtx.luckysheet_select_status = false;
                draftCtx.luckysheet_select_save = undefined;
            }
            draftCtx.luckysheet_selection_range = [];
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
                [...draftCtx.luckysheetfile]
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                    .forEach((f, i) => {
                        f.order = i;
                        if (f.id === draggingId) draggingSheet = f;
                        else if (f.id === droppingId) droppingSheet = f;
                    });
                if (draggingSheet && droppingSheet) {
                    draggingSheet.order = droppingSheet.order! - 0.1;
                    [...draftCtx.luckysheetfile]
                        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                        .forEach((f, i) => {
                            f.order = i;
                        });
                } else if (draggingSheet && isDropPlaceholder) {
                    draggingSheet.order = draftCtx.luckysheetfile.length;
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
                const sorted = ctx.luckysheetfile.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const [i, _sheet] of sorted.entries()) {
                    _sheet.order = i;
                    if (_sheet.id === sheet.id) currentOrder = i;
                }
                api.setSheetOrder(ctx, { [sheet.id!]: currentOrder + delta });
            });
        },
        [context.allowEdit, setContext, sheet],
    );

    const renderMenuItems = useCallback(
        (M: MenuItemComponents) => {
            return settings.sheetTabContextMenu?.map((name, i) => {
                // biome-ignore lint/suspicious/noArrayIndexKey: separator in static config menu
                if (name === '|') return <M.Separator key={`divide-${i}`} />;
                if (name === 'delete') {
                    return (
                        <M.Item
                            key={name}
                            onClick={() => {
                                const shownSheets = context.luckysheetfile.filter(
                                    (s) => s.hide === undefined || s.hide !== 1,
                                );
                                if (context.luckysheetfile.length > 1 && shownSheets.length > 1) {
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
                        </M.Item>
                    );
                }
                if (name === 'rename')
                    return (
                        <M.Item key={name} onClick={() => setEditing(true)}>
                            {sheetconfig.rename}
                        </M.Item>
                    );
                if (name === 'copy') {
                    return (
                        <M.Item
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
                        </M.Item>
                    );
                }
                if (name === 'hide') {
                    return (
                        <M.Item
                            key={name}
                            onClick={() => {
                                if (context.allowEdit === false || !sheet) return;
                                setContext((ctx) => {
                                    const shownSheets = ctx.luckysheetfile.filter(
                                        (s) => s.hide === undefined || s.hide !== 1,
                                    );
                                    if (shownSheets.length > 1) api.hideSheet(ctx, sheet.id as string);
                                    else showAlert(sheetconfig.noMoreSheet, 'ok');
                                });
                            }}
                        >
                            {sheetconfig.hide}
                        </M.Item>
                    );
                }
                if (name === 'move') {
                    return (
                        <React.Fragment key={name}>
                            <M.Item onClick={() => moveSheet(-1.5)}>{sheetconfig.moveLeft}</M.Item>
                            <M.Item onClick={() => moveSheet(1.5)}>{sheetconfig.moveRight}</M.Item>
                        </React.Fragment>
                    );
                }
                if (name === 'color') {
                    return (
                        <M.Sub key={name}>
                            <M.SubTrigger>{sheetconfig.changeColor}</M.SubTrigger>
                            <M.SubContent style={{ zIndex: 1010 }}>
                                {context.allowEdit && <ChangeColor triggerParentUpdate={() => {}} />}
                            </M.SubContent>
                        </M.Sub>
                    );
                }
                if (name === 'focus') {
                    return (
                        <M.Item
                            key={name}
                            onClick={() => {
                                if (context.allowEdit === false || !sheet?.id) return;
                                setContext((ctx) => {
                                    for (const f of ctx.luckysheetfile) f.status = sheet.id === f.id ? 1 : 0;
                                });
                            }}
                        >
                            {sheetconfig.focus}
                        </M.Item>
                    );
                }
                return null;
            });
        },
        [context, settings.sheetTabContextMenu, sheet, sheetconfig, showAlert, hideAlert, setContext, moveSheet],
    );

    const contextMenuItems: MenuItemComponents = {
        Item: ContextMenuItem,
        Separator: ContextMenuSeparator,
        Sub: ContextMenuSub,
        SubTrigger: ContextMenuSubTrigger,
        SubContent: ContextMenuSubContent,
    };
    const dropdownMenuItems: MenuItemComponents = {
        Item: DropdownMenuItem,
        Separator: DropdownMenuSeparator,
        Sub: DropdownMenuSub,
        SubTrigger: DropdownMenuSubTrigger,
        SubContent: DropdownMenuSubContent,
    };

    const selectSheet = useCallback(() => {
        if (isDropPlaceholder) return;
        setContext((draftCtx) => {
            draftCtx.sheetScrollRecord[draftCtx.currentSheetId] = {
                scrollLeft: draftCtx.scrollLeft,
                scrollTop: draftCtx.scrollTop,
                luckysheet_select_status: draftCtx.luckysheet_select_status,
                luckysheet_select_save: draftCtx.luckysheet_select_save,
                luckysheet_selection_range: draftCtx.luckysheet_selection_range,
            };
            draftCtx.dataVerificationDropDownList = false;
            draftCtx.currentSheetId = sheet.id!;
            cancelActiveImgItem(draftCtx, refs.globalCache);
            cancelNormalSelected(draftCtx);
        });
    }, [isDropPlaceholder, setContext, sheet, refs.globalCache]);

    const tabDiv = (
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
            ref={containerRef}
            className={
                isDropPlaceholder
                    ? 'fortune-sheettab-placeholder'
                    : `luckysheet-sheets-item${context.currentSheetId === sheet.id ? ' luckysheet-sheets-item-active' : ''}`
            }
            onClick={selectSheet}
            tabIndex={0}
            style={{
                borderLeft: dragOver ? '2px solid #0188fb' : '',
                display: sheet.hide === 1 ? 'none' : '',
            }}
        >
            <span
                className="luckysheet-sheets-item-name"
                spellCheck="false"
                suppressContentEditableWarning
                contentEditable={isDropPlaceholder ? false : editing}
                onDoubleClick={() => setEditing(true)}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                ref={editable}
                style={dragOver ? { pointerEvents: 'none' } : {}}
            >
                {sheet.name}
            </span>
            {context.allowEdit && !isDropPlaceholder && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <span
                            className="luckysheet-sheets-item-function"
                            onMouseEnter={() => setSvgColor('#5c5c5c')}
                            onMouseLeave={() => setSvgColor('#c3c3c3')}
                            onClick={(e) => e.stopPropagation()}
                            tabIndex={0}
                            aria-label={info.sheetOptions}
                        >
                            <ChevronDown width={12} height={12} style={{ color: svgColor }} aria-hidden="true" />
                        </span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" collisionPadding={8} style={{ zIndex: 1010 }}>
                        {renderMenuItems(dropdownMenuItems)}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {!!sheet.color && <div className="luckysheet-sheets-item-color" style={{ background: sheet.color }} />}
        </div>
    );

    if (isDropPlaceholder || !context.allowEdit) return tabDiv;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild onContextMenu={selectSheet}>
                {tabDiv}
            </ContextMenuTrigger>
            <ContextMenuContent collisionPadding={8} style={{ zIndex: 1010 }}>
                {renderMenuItems(contextMenuItems)}
            </ContextMenuContent>
        </ContextMenu>
    );
};
