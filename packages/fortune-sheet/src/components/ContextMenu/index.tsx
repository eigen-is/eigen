import {
    api,
    createFilter,
    deleteRowCol,
    deleteSelectedCellText,
    getFlowdata,
    getSheetIndex,
    handleCopy,
    handleLink,
    handlePasteByClick,
    hideSelected,
    insertRowCol,
    isAllowEdit,
    jfrefreshgrid,
    locale,
    removeActiveImage,
    showImgChooser,
    showSelected,
    sortSelection,
} from "../../core";
import React, {useCallback, useContext} from "react";
import {SetContextOptions, WorkbookContext} from "../../context";
import {useAlert} from "../../hooks/useAlert";
import {useDialog} from "../../hooks/useDialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {EIGEN_STICKIES_COLORS} from "@workspace/lib/constants/colors";
import {isLightColor} from "@workspace/ui/components/layout/media/color-picker";
import {Check, CircleOff} from "lucide-react";
import {CustomSort} from "../CustomSort";

export const ContextMenu: React.FC = () => {
    const {showDialog} = useDialog();
    const {context, setContext, settings} = useContext(WorkbookContext);
    const {contextMenu} = context;
    const {showAlert} = useAlert();
    const {rightclick, drag, generalDialog, info} = locale(context);
    const getMenuElement = useCallback(
        (name: string, i: number) => {
            const selection = context.luckysheet_select_save?.[0];
            if (name === "|") {
                return <DropdownMenuSeparator key={`divider-${i}`}/>;
            }
            if (name === "copy") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                if (draftCtx.luckysheet_select_save?.length! > 1) {
                                    showAlert(rightclick.noMulti, "ok");
                                    draftCtx.contextMenu = {};
                                    return;
                                }
                                handleCopy(draftCtx);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.copy}
                    </DropdownMenuItem>
                );
            }
            if (name === "paste") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={async () => {
                            let clipboardText = "";
                            const sessionClipboardText =
                                sessionStorage.getItem("localClipboard") || "";

                            try {
                                clipboardText = await navigator.clipboard.readText();
                            } catch (err) {
                                console.warn(
                                    "Clipboard access blocked. Attempting to use sessionStorage fallback."
                                );
                            }

                            const finalText = clipboardText || sessionClipboardText;

                            setContext((draftCtx) => {
                                handlePasteByClick(draftCtx, finalText);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.paste}
                    </DropdownMenuItem>
                );
            }
            if (name === "insert-column") {
                return selection?.row_select
                    ? null
                    : ["left", "right"].map((dir) => (
                        <div
                            key={`add-col-${dir}`}
                            className="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                            onClick={(e) => {
                                const position =
                                    context.luckysheet_select_save?.[0]?.column?.[0];
                                if (position == null) return;
                                const countStr = (e.currentTarget as HTMLDivElement).querySelector(
                                    "input"
                                )?.value;
                                if (countStr == null) return;
                                const count = parseInt(countStr, 10);
                                if (count < 1) return;
                                const direction = dir === "left" ? "lefttop" : "rightbottom";
                                const insertRowColOp: SetContextOptions["insertRowColOp"] = {
                                    type: "column",
                                    index: position,
                                    count,
                                    direction,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        try {
                                            insertRowCol(draftCtx, insertRowColOp);
                                            draftCtx.contextMenu = {};
                                        } catch (err: any) {
                                            if (err.message === "maxExceeded")
                                                showAlert(rightclick.columnOverLimit, "ok");
                                            else if (err.message === "readOnly")
                                                showAlert(
                                                    rightclick.cannotInsertOnColumnReadOnly,
                                                    "ok"
                                                );
                                            draftCtx.contextMenu = {};
                                        }
                                    },
                                    {
                                        insertRowColOp,
                                    }
                                );
                            }}
                        >
                            <>
                                {(context.lang ?? "").startsWith("zh") && (
                                    <>
                                        {rightclick.to}
                                        <span className={`luckysheet-cols-rows-shift-${dir}`}>
                        {(rightclick as any)[dir]}
                      </span>
                                    </>
                                )}
                                {`${rightclick.insert}  `}
                                <input
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    tabIndex={0}
                                    type="text"
                                    className="luckysheet-mousedown-cancel"
                                    placeholder={rightclick.number}
                                    defaultValue="1"
                                />
                                <span className="luckysheet-cols-rows-shift-word luckysheet-mousedown-cancel">
                    {`${rightclick.column}  `}
                  </span>
                                {!(context.lang ?? "").startsWith("zh") && (
                                    <span className={`luckysheet-cols-rows-shift-${dir}`}>
                      {(rightclick as any)[dir]}
                    </span>
                                )}
                            </>
                        </div>
                    ));
            }
            if (name === "insert-row") {
                return selection?.column_select
                    ? null
                    : ["top", "bottom"].map((dir) => (
                        <div
                            key={`add-row-${dir}`}
                            className="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                            onClick={(e) => {
                                const position =
                                    context.luckysheet_select_save?.[0]?.row?.[0];
                                if (position == null) return;
                                const countStr = e.currentTarget.querySelector("input")?.value;
                                if (countStr == null) return;
                                const count = parseInt(countStr, 10);
                                if (count < 1) return;
                                const direction = dir === "top" ? "lefttop" : "rightbottom";
                                const insertRowColOp: SetContextOptions["insertRowColOp"] = {
                                    type: "row",
                                    index: position,
                                    count,
                                    direction,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        try {
                                            insertRowCol(draftCtx, insertRowColOp);
                                            draftCtx.contextMenu = {};
                                        } catch (err: any) {
                                            if (err.message === "maxExceeded")
                                                showAlert(rightclick.rowOverLimit, "ok");
                                            else if (err.message === "readOnly")
                                                showAlert(rightclick.cannotInsertOnRowReadOnly, "ok");
                                            draftCtx.contextMenu = {};
                                        }
                                    },
                                    {insertRowColOp}
                                );
                            }}
                        >
                            <>
                                {(context.lang ?? "").startsWith("zh") && (
                                    <>
                                        {rightclick.to}
                                        <span className={`luckysheet-cols-rows-shift-${dir}`}>
                        {(rightclick as any)[dir]}
                      </span>
                                    </>
                                )}
                                {`${rightclick.insert}  `}
                                <input
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    tabIndex={0}
                                    type="text"
                                    className="luckysheet-mousedown-cancel"
                                    placeholder={rightclick.number}
                                    defaultValue="1"
                                />
                                <span className="luckysheet-cols-rows-shift-word luckysheet-mousedown-cancel">
                    {`${rightclick.row}  `}
                  </span>
                                {!(context.lang ?? "").startsWith("zh") && (
                                    <span className={`luckysheet-cols-rows-shift-${dir}`}>
                      {(rightclick as any)[dir]}
                    </span>
                                )}
                            </>
                        </div>
                    ));
            }
            if (name === "delete-column") {
                return (
                    selection?.column_select && (
                        <DropdownMenuItem
                            key="delete-col"
                            onClick={() => {
                                if (!selection) return;
                                const [st_index, ed_index] = selection.column;
                                const deleteRowColOp: SetContextOptions["deleteRowColOp"] = {
                                    type: "column",
                                    start: st_index,
                                    end: ed_index,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        if (draftCtx.luckysheet_select_save?.length! > 1) {
                                            showAlert(rightclick.noMulti, "ok");
                                            draftCtx.contextMenu = {};
                                            draftCtx.dataVerificationDropDownList = false;
                                            return;
                                        }
                                        const slen = ed_index - st_index + 1;
                                        const index = getSheetIndex(
                                            draftCtx,
                                            context.currentSheetId
                                        ) as number;
                                        if (
                                            draftCtx.luckysheetfile[index].data?.[0]?.length! <= slen
                                        ) {
                                            showAlert(rightclick.cannotDeleteAllColumn, "ok");
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        try {
                                            deleteRowCol(draftCtx, deleteRowColOp);
                                        } catch (e: any) {
                                            if (e.message === "readOnly") {
                                                showAlert(rightclick.cannotDeleteColumnReadOnly, "ok");
                                            }
                                        }
                                        draftCtx.contextMenu = {};
                                    },
                                    {deleteRowColOp}
                                );
                            }}
                        >
                            {rightclick.deleteSelected}
                            {rightclick.column}
                        </DropdownMenuItem>
                    )
                );
            }
            if (name === "delete-row") {
                return (
                    selection?.row_select && (
                        <DropdownMenuItem
                            key="delete-row"
                            onClick={() => {
                                if (!selection) return;
                                const [st_index, ed_index] = selection.row;
                                const deleteRowColOp: SetContextOptions["deleteRowColOp"] = {
                                    type: "row",
                                    start: st_index,
                                    end: ed_index,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        if (draftCtx.luckysheet_select_save?.length! > 1) {
                                            showAlert(rightclick.noMulti, "ok");
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        const slen = ed_index - st_index + 1;
                                        const index = getSheetIndex(
                                            draftCtx,
                                            context.currentSheetId
                                        ) as number;
                                        if (draftCtx.luckysheetfile[index].data?.length! <= slen) {
                                            showAlert(rightclick.cannotDeleteAllRow, "ok");
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        try {
                                            deleteRowCol(draftCtx, deleteRowColOp);
                                        } catch (e: any) {
                                            if (e.message === "readOnly") {
                                                showAlert(rightclick.cannotDeleteRowReadOnly, "ok");
                                            }
                                        }
                                        draftCtx.contextMenu = {};
                                    },
                                    {deleteRowColOp}
                                );
                            }}
                        >
                            {rightclick.deleteSelected}
                            {rightclick.row}
                        </DropdownMenuItem>
                    )
                );
            }
            if (name === "hide-row") {
                return (
                    selection?.row_select === true &&
                    ["hideSelected", "showHide"].map((item) => (
                        <DropdownMenuItem
                            key={item}
                            onClick={() => {
                                setContext((draftCtx) => {
                                    let msg = "";
                                    if (item === "hideSelected") {
                                        msg = hideSelected(draftCtx, "row");
                                    } else if (item === "showHide") {
                                        showSelected(draftCtx, "row");
                                    }
                                    if (msg === "noMulti") {
                                        showDialog(drag.noMulti);
                                    }
                                    draftCtx.contextMenu = {};
                                });
                            }}
                        >
                            {(rightclick as any)[item] + rightclick.row}
                        </DropdownMenuItem>
                    ))
                );
            }
            if (name === "hide-column") {
                return (
                    selection?.column_select === true &&
                    ["hideSelected", "showHide"].map((item) => (
                        <DropdownMenuItem
                            key={item}
                            onClick={() => {
                                setContext((draftCtx) => {
                                    let msg = "";
                                    if (item === "hideSelected") {
                                        msg = hideSelected(draftCtx, "column");
                                    } else if (item === "showHide") {
                                        showSelected(draftCtx, "column");
                                    }
                                    if (msg === "noMulti") {
                                        showDialog(drag.noMulti);
                                    }
                                    draftCtx.contextMenu = {};
                                });
                            }}
                        >
                            {(rightclick as any)[item] + rightclick.column}
                        </DropdownMenuItem>
                    ))
                );
            }
            if (name === "set-row-height") {
                const rowHeight = selection?.height || context.defaultrowlen;
                const shownRowHeight = context.luckysheet_select_save?.some(
                    (section) =>
                        section.height_move !==
                        (rowHeight + 1) * (section.row[1] - section.row[0] + 1) - 1
                )
                    ? ""
                    : rowHeight;
                return context.luckysheet_select_save?.some(
                    (section) => section.row_select
                ) ? (
                    <div
                        key="set-row-height"
                        className="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                        onClick={(e) => {
                            const targetRowHeight = e.currentTarget.querySelector("input")?.value;
                            setContext((draftCtx) => {
                                if (
                                    targetRowHeight === undefined ||
                                    targetRowHeight === "" ||
                                    parseInt(targetRowHeight, 10) <= 0 ||
                                    parseInt(targetRowHeight, 10) > 545
                                ) {
                                    showAlert(info.tipRowHeightLimit, "ok");
                                    draftCtx.contextMenu = {};
                                    return;
                                }
                                const numRowHeight = parseInt(targetRowHeight, 10);
                                const rowHeightList: Record<string, number> = {};
                                for (const section of draftCtx.luckysheet_select_save ?? []) {
                                    for (
                                        let rowNum = section.row[0];
                                        rowNum <= section.row[1];
                                        rowNum += 1
                                    ) {
                                        rowHeightList[rowNum] = numRowHeight;
                                    }
                                }
                                api.setRowHeight(draftCtx, rowHeightList, {}, true);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.row}
                        {rightclick.height}
                        <input
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            tabIndex={0}
                            type="number"
                            min={1}
                            max={545}
                            className="luckysheet-mousedown-cancel"
                            placeholder={rightclick.number}
                            defaultValue={shownRowHeight}
                            style={{width: "40px"}}
                        />
                        px
                    </div>
                ) : null;
            }
            if (name === "set-column-width") {
                const colWidth = selection?.width || context.defaultcollen;
                const shownColWidth = context.luckysheet_select_save?.some(
                    (section) =>
                        section.width_move !==
                        (colWidth + 1) * (section.column[1] - section.column[0] + 1) - 1
                )
                    ? ""
                    : colWidth;
                return context.luckysheet_select_save?.some(
                    (section) => section.column_select
                ) ? (
                    <div
                        key="set-column-width"
                        className="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                        onClick={(e) => {
                            const targetColWidth = e.currentTarget.querySelector("input")?.value;
                            setContext((draftCtx) => {
                                if (
                                    targetColWidth === undefined ||
                                    targetColWidth === "" ||
                                    parseInt(targetColWidth, 10) <= 0 ||
                                    parseInt(targetColWidth, 10) > 2038
                                ) {
                                    showAlert(info.tipColumnWidthLimit, "ok");
                                    draftCtx.contextMenu = {};
                                    return;
                                }
                                const numColWidth = parseInt(targetColWidth, 10);
                                const colWidthList: Record<string, number> = {};
                                for (const section of draftCtx.luckysheet_select_save ?? []) {
                                    for (
                                        let colNum = section.column[0];
                                        colNum <= section.column[1];
                                        colNum += 1
                                    ) {
                                        colWidthList[colNum] = numColWidth;
                                    }
                                }
                                api.setColumnWidth(draftCtx, colWidthList, {}, true);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.column}
                        {rightclick.width}
                        <input
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            tabIndex={0}
                            type="number"
                            min={1}
                            max={545}
                            className="luckysheet-mousedown-cancel"
                            placeholder={rightclick.number}
                            defaultValue={shownColWidth}
                            style={{width: "40px"}}
                        />
                        px
                    </div>
                ) : null;
            }
            if (name === "clear") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                const allowEdit = isAllowEdit(draftCtx);
                                if (!allowEdit) return;
                                if (draftCtx.activeImg != null) {
                                    removeActiveImage(draftCtx);
                                } else {
                                    const msg = deleteSelectedCellText(draftCtx);
                                    if (msg === "partMC") {
                                        showDialog(generalDialog.partiallyError, "ok");
                                    } else if (msg === "allowEdit") {
                                        showDialog(generalDialog.readOnlyError, "ok");
                                    } else if (msg === "dataNullError") {
                                        showDialog(generalDialog.dataNullError, "ok");
                                    }
                                }
                                draftCtx.contextMenu = {};
                                jfrefreshgrid(draftCtx, null, undefined);
                            });
                        }}
                    >
                        {rightclick.clearContent}
                    </DropdownMenuItem>
                );
            }
            if (name === "orderAZ") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                sortSelection(draftCtx, true);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.orderAZ}
                    </DropdownMenuItem>
                );
            }
            if (name === "orderZA") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                sortSelection(draftCtx, false);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.orderZA}
                    </DropdownMenuItem>
                );
            }
            if (name === "sort") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                showDialog(<CustomSort/>);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.sortSelection}
                    </DropdownMenuItem>
                );
            }
            if (name === "filter") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                createFilter(draftCtx);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.filterSelection}
                    </DropdownMenuItem>
                );
            }
            if (name === "image") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                showImgChooser();
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.image}
                    </DropdownMenuItem>
                );
            }
            if (name === "link") {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                handleLink(draftCtx);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.link}
                    </DropdownMenuItem>
                );
            }
            if (name === "comment") {
                const last = context.luckysheet_select_save?.[context.luckysheet_select_save.length - 1];
                let row_index = last?.row_focus;
                let col_index = last?.column_focus;
                if (!last) {
                    row_index = 0;
                    col_index = 0;
                } else {
                    if (row_index == null) [row_index] = last.row;
                    if (col_index == null) [col_index] = last.column;
                }
                const fd = getFlowdata(context);
                const cell = fd?.[row_index]?.[col_index];
                const hasComment = (cell?.commentChatNames?.length ?? 0) > 0;
                const closeMenu = () => setContext((draftCtx) => { draftCtx.contextMenu = {}; });

                if (!hasComment && settings.hooks?.onAddComment) {
                    return (
                        <DropdownMenuItem
                            key={name}
                            onClick={() => {
                                closeMenu();
                                settings.hooks!.onAddComment!(row_index!, col_index!);
                            }}
                        >
                            Add comment
                        </DropdownMenuItem>
                    );
                }
                if (hasComment) {
                    const info = settings.hooks?.getCommentInfo?.(row_index!, col_index!);
                    return (
                        <React.Fragment key={name}>
                            {settings.hooks?.onViewComment && (
                                <DropdownMenuItem onClick={() => {
                                    closeMenu();
                                    settings.hooks!.onViewComment!(row_index!, col_index!);
                                }}>
                                    View comment
                                </DropdownMenuItem>
                            )}
                            {settings.hooks?.onCommentColor && (
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger className="gap-2">
                                        Comment color
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        <div className="flex gap-1 p-2">
                                            <button
                                                type="button"
                                                className="h-4 w-4 rounded-full border border-border hover:scale-125 transition-transform flex items-center justify-center bg-background"
                                                title="No color"
                                                onClick={() => {
                                                    closeMenu();
                                                    settings.hooks!.onCommentColor!(row_index!, col_index!, null);
                                                }}
                                            >
                                                <CircleOff className="h-2.5 w-2.5 text-muted-foreground" />
                                            </button>
                                            {EIGEN_STICKIES_COLORS[0].map((c) => (
                                                <button
                                                    type="button"
                                                    key={c.value}
                                                    className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                                                    style={{ backgroundColor: c.value }}
                                                    title={c.label}
                                                    onClick={() => {
                                                        closeMenu();
                                                        settings.hooks!.onCommentColor!(row_index!, col_index!, c.value);
                                                    }}
                                                >
                                                    {info?.color === c.value && (
                                                        <Check className="h-2 w-2" style={{ color: isLightColor(c.value) ? '#000' : '#fff' }} />
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            )}
                            {info?.status === 'open' && settings.hooks?.onCommentResolve && (
                                <DropdownMenuItem onClick={() => {
                                    closeMenu();
                                    settings.hooks!.onCommentResolve!(row_index!, col_index!);
                                }}>
                                    Resolve comment
                                </DropdownMenuItem>
                            )}
                            {info?.status === 'resolved' && settings.hooks?.onCommentReopen && (
                                <DropdownMenuItem onClick={() => {
                                    closeMenu();
                                    settings.hooks!.onCommentReopen!(row_index!, col_index!);
                                }}>
                                    Reopen comment
                                </DropdownMenuItem>
                            )}
                            {settings.hooks?.onDeleteComment && (
                                <DropdownMenuItem variant="destructive" onClick={() => {
                                    closeMenu();
                                    settings.hooks!.onDeleteComment!(row_index!, col_index!);
                                }}>
                                    Delete comment
                                </DropdownMenuItem>
                            )}
                        </React.Fragment>
                    );
                }
                return null;
            }
            return null;
        },
        [
            context,
            context.currentSheetId,
            context.lang,
            context.luckysheet_select_save,
            context.defaultrowlen,
            context.defaultcollen,
            rightclick,
            info,
            setContext,
            settings,
            showAlert,
            showDialog,
            drag,
            generalDialog,
        ]
    );

    const isOpen = Object.keys(context.contextMenu).length > 0;

    return (
        <DropdownMenu open={isOpen} onOpenChange={(open) => {
            if (!open) setContext((draftCtx) => { draftCtx.contextMenu = {}; });
        }}>
            <DropdownMenuTrigger asChild>
                <div
                    style={{
                        position: 'fixed',
                        left: contextMenu.pageX,
                        top: contextMenu.pageY,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                    }}
                />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                side="bottom"
                align="start"
                collisionPadding={8}
                style={{ zIndex: 1010 }}
                onContextMenu={(e) => e.stopPropagation()}
            >
                {context.contextMenu.headerMenu === true
                    ? settings.headerContextMenu.map((menu, i) => getMenuElement(menu, i))
                    : settings.cellContextMenu.map((menu, i) => getMenuElement(menu, i))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

