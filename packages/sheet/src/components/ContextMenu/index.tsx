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
import { CommentMenuItems } from '@workspace/ui/components/layout/comments';
import type React from 'react';
import { useCallback, useContext } from 'react';
import { type SetContextOptions, WorkbookContext } from '../../context';
import { RowColError } from '../../engine';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
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
    showSelected,
    sortSelection,
} from '../../state';
import { CustomSort } from '../CustomSort';

const menuItemClass =
    'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground';

export const ContextMenu: React.FC = () => {
    const { showDialog } = useDialog();
    const { context, setContext, settings } = useContext(WorkbookContext);
    const { contextMenu } = context;
    const { showAlert } = useAlert();
    const { rightclick, drag, generalDialog, info } = locale(context);
    const getMenuElement = useCallback(
        (name: string, i: number) => {
            const selection = context.selections?.[0];
            if (name === '|') {
                return <DropdownMenuSeparator key={`divider-${i}`} />;
            }
            if (name === 'copy') {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                if ((draftCtx.selections?.length ?? 0) > 1) {
                                    showAlert(rightclick.noMulti, 'ok');
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
            if (name === 'paste') {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={async () => {
                            let clipboardText = '';
                            const sessionClipboardText = sessionStorage.getItem('localClipboard') || '';

                            try {
                                clipboardText = await navigator.clipboard.readText();
                            } catch {
                                console.warn('Clipboard access blocked. Attempting to use sessionStorage fallback.');
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
            if (name === 'insert-column') {
                return selection?.row_select
                    ? null
                    : (['left', 'right'] as const).map((dir) => (
                          <div
                              key={`add-col-${dir}`}
                              className={menuItemClass}
                              onClick={(e) => {
                                  const position = context.selections?.[0]?.column?.[0];
                                  if (position == null) return;
                                  const countStr = (e.currentTarget as HTMLDivElement).querySelector('input')?.value;
                                  if (countStr == null) return;
                                  const count = parseInt(countStr, 10);
                                  if (count < 1) return;
                                  const direction = dir === 'left' ? 'lefttop' : 'rightbottom';
                                  const insertRowColOp: SetContextOptions['insertRowColOp'] = {
                                      type: 'column',
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
                                          } catch (err) {
                                              if (err instanceof RowColError && err.code === 'maxExceeded')
                                                  showAlert(rightclick.columnOverLimit, 'ok');
                                              else if (err instanceof RowColError && err.code === 'readOnly')
                                                  showAlert(rightclick.cannotInsertOnColumnReadOnly, 'ok');
                                              draftCtx.contextMenu = {};
                                          }
                                      },
                                      {
                                          insertRowColOp,
                                      },
                                  );
                              }}
                          >
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
                              <span className={`luckysheet-cols-rows-shift-${dir}`}>{rightclick[dir]}</span>
                          </div>
                      ));
            }
            if (name === 'insert-row') {
                return selection?.column_select
                    ? null
                    : (['top', 'bottom'] as const).map((dir) => (
                          <div
                              key={`add-row-${dir}`}
                              className={menuItemClass}
                              onClick={(e) => {
                                  const position = context.selections?.[0]?.row?.[0];
                                  if (position == null) return;
                                  const countStr = e.currentTarget.querySelector('input')?.value;
                                  if (countStr == null) return;
                                  const count = parseInt(countStr, 10);
                                  if (count < 1) return;
                                  const direction = dir === 'top' ? 'lefttop' : 'rightbottom';
                                  const insertRowColOp: SetContextOptions['insertRowColOp'] = {
                                      type: 'row',
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
                                          } catch (err) {
                                              if (err instanceof RowColError && err.code === 'maxExceeded')
                                                  showAlert(rightclick.rowOverLimit, 'ok');
                                              else if (err instanceof RowColError && err.code === 'readOnly')
                                                  showAlert(rightclick.cannotInsertOnRowReadOnly, 'ok');
                                              draftCtx.contextMenu = {};
                                          }
                                      },
                                      { insertRowColOp },
                                  );
                              }}
                          >
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
                              <span className={`luckysheet-cols-rows-shift-${dir}`}>{rightclick[dir]}</span>
                          </div>
                      ));
            }
            if (name === 'delete-column') {
                return (
                    selection?.column_select && (
                        <DropdownMenuItem
                            key="delete-col"
                            onClick={() => {
                                if (!selection) return;
                                const [st_index, ed_index] = selection.column;
                                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                                    type: 'column',
                                    start: st_index,
                                    end: ed_index,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        if ((draftCtx.selections?.length ?? 0) > 1) {
                                            showAlert(rightclick.noMulti, 'ok');
                                            draftCtx.contextMenu = {};
                                            draftCtx.dataVerificationDropDownList = false;
                                            return;
                                        }
                                        const slen = ed_index - st_index + 1;
                                        const index = getSheetIndex(draftCtx, context.currentSheetId) as number;
                                        if ((draftCtx.sheets[index].data?.[0]?.length ?? 0) <= slen) {
                                            showAlert(rightclick.cannotDeleteAllColumn, 'ok');
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        try {
                                            deleteRowCol(draftCtx, deleteRowColOp);
                                        } catch (e) {
                                            if (e instanceof RowColError && e.code === 'readOnly') {
                                                showAlert(rightclick.cannotDeleteColumnReadOnly, 'ok');
                                            }
                                        }
                                        draftCtx.contextMenu = {};
                                    },
                                    { deleteRowColOp },
                                );
                            }}
                        >
                            {rightclick.deleteSelected}
                            {rightclick.column}
                        </DropdownMenuItem>
                    )
                );
            }
            if (name === 'delete-row') {
                return (
                    selection?.row_select && (
                        <DropdownMenuItem
                            key="delete-row"
                            onClick={() => {
                                if (!selection) return;
                                const [st_index, ed_index] = selection.row;
                                const deleteRowColOp: SetContextOptions['deleteRowColOp'] = {
                                    type: 'row',
                                    start: st_index,
                                    end: ed_index,
                                    id: context.currentSheetId,
                                };
                                setContext(
                                    (draftCtx) => {
                                        if ((draftCtx.selections?.length ?? 0) > 1) {
                                            showAlert(rightclick.noMulti, 'ok');
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        const slen = ed_index - st_index + 1;
                                        const index = getSheetIndex(draftCtx, context.currentSheetId) as number;
                                        if ((draftCtx.sheets[index].data?.length ?? 0) <= slen) {
                                            showAlert(rightclick.cannotDeleteAllRow, 'ok');
                                            draftCtx.contextMenu = {};
                                            return;
                                        }
                                        try {
                                            deleteRowCol(draftCtx, deleteRowColOp);
                                        } catch (e) {
                                            if (e instanceof RowColError && e.code === 'readOnly') {
                                                showAlert(rightclick.cannotDeleteRowReadOnly, 'ok');
                                            }
                                        }
                                        draftCtx.contextMenu = {};
                                    },
                                    { deleteRowColOp },
                                );
                            }}
                        >
                            {rightclick.deleteSelected}
                            {rightclick.row}
                        </DropdownMenuItem>
                    )
                );
            }
            if (name === 'hide-row') {
                return (
                    selection?.row_select === true &&
                    (['hideSelected', 'showHide'] as const).map((item) => (
                        <DropdownMenuItem
                            key={item}
                            onClick={() => {
                                setContext((draftCtx) => {
                                    let msg = '';
                                    if (item === 'hideSelected') {
                                        msg = hideSelected(draftCtx, 'row');
                                    } else if (item === 'showHide') {
                                        showSelected(draftCtx, 'row');
                                    }
                                    if (msg === 'noMulti') {
                                        showDialog(drag.noMulti);
                                    }
                                    draftCtx.contextMenu = {};
                                });
                            }}
                        >
                            {rightclick[item] + rightclick.row}
                        </DropdownMenuItem>
                    ))
                );
            }
            if (name === 'hide-column') {
                return (
                    selection?.column_select === true &&
                    (['hideSelected', 'showHide'] as const).map((item) => (
                        <DropdownMenuItem
                            key={item}
                            onClick={() => {
                                setContext((draftCtx) => {
                                    let msg = '';
                                    if (item === 'hideSelected') {
                                        msg = hideSelected(draftCtx, 'column');
                                    } else if (item === 'showHide') {
                                        showSelected(draftCtx, 'column');
                                    }
                                    if (msg === 'noMulti') {
                                        showDialog(drag.noMulti);
                                    }
                                    draftCtx.contextMenu = {};
                                });
                            }}
                        >
                            {rightclick[item] + rightclick.column}
                        </DropdownMenuItem>
                    ))
                );
            }
            if (name === 'set-row-height') {
                const rowHeight = selection?.height || context.defaultrowlen;
                const shownRowHeight = context.selections?.some(
                    (section) => section.height_move !== (rowHeight + 1) * (section.row[1] - section.row[0] + 1) - 1,
                )
                    ? ''
                    : rowHeight;
                return context.selections?.some((section) => section.row_select) ? (
                    <div
                        key="set-row-height"
                        className={menuItemClass}
                        onClick={(e) => {
                            const targetRowHeight = e.currentTarget.querySelector('input')?.value;
                            setContext((draftCtx) => {
                                if (
                                    targetRowHeight === undefined ||
                                    targetRowHeight === '' ||
                                    parseInt(targetRowHeight, 10) <= 0 ||
                                    parseInt(targetRowHeight, 10) > 545
                                ) {
                                    showAlert(info.tipRowHeightLimit, 'ok');
                                    draftCtx.contextMenu = {};
                                    return;
                                }
                                const numRowHeight = parseInt(targetRowHeight, 10);
                                const rowHeightList: Record<string, number> = {};
                                for (const section of draftCtx.selections ?? []) {
                                    for (let rowNum = section.row[0]; rowNum <= section.row[1]; rowNum += 1) {
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
                            style={{ width: '40px' }}
                        />
                        px
                    </div>
                ) : null;
            }
            if (name === 'set-column-width') {
                const colWidth = selection?.width || context.defaultcollen;
                const shownColWidth = context.selections?.some(
                    (section) =>
                        section.width_move !== (colWidth + 1) * (section.column[1] - section.column[0] + 1) - 1,
                )
                    ? ''
                    : colWidth;
                return context.selections?.some((section) => section.column_select) ? (
                    <div
                        key="set-column-width"
                        className={menuItemClass}
                        onClick={(e) => {
                            const targetColWidth = e.currentTarget.querySelector('input')?.value;
                            setContext((draftCtx) => {
                                if (
                                    targetColWidth === undefined ||
                                    targetColWidth === '' ||
                                    parseInt(targetColWidth, 10) <= 0 ||
                                    parseInt(targetColWidth, 10) > 2038
                                ) {
                                    showAlert(info.tipColumnWidthLimit, 'ok');
                                    draftCtx.contextMenu = {};
                                    return;
                                }
                                const numColWidth = parseInt(targetColWidth, 10);
                                const colWidthList: Record<string, number> = {};
                                for (const section of draftCtx.selections ?? []) {
                                    for (let colNum = section.column[0]; colNum <= section.column[1]; colNum += 1) {
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
                            style={{ width: '40px' }}
                        />
                        px
                    </div>
                ) : null;
            }
            if (name === 'clear') {
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
                                    if (msg === 'partMC') {
                                        showDialog(generalDialog.partiallyError, 'ok');
                                    } else if (msg === 'allowEdit') {
                                        showDialog(generalDialog.readOnlyError, 'ok');
                                    } else if (msg === 'dataNullError') {
                                        showDialog(generalDialog.dataNullError, 'ok');
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
            if (name === 'orderAZ') {
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
            if (name === 'orderZA') {
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
            if (name === 'sort') {
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                showDialog(<CustomSort />);
                                draftCtx.contextMenu = {};
                            });
                        }}
                    >
                        {rightclick.sortSelection}
                    </DropdownMenuItem>
                );
            }
            if (name === 'filter') {
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
            if (name === 'image') {
                if (!settings.hooks?.onInsertImage) return null;
                return (
                    <DropdownMenuItem
                        key={name}
                        onClick={() => {
                            setContext((draftCtx) => {
                                draftCtx.contextMenu = {};
                            });
                            settings.hooks!.onInsertImage!();
                        }}
                    >
                        {rightclick.image}
                    </DropdownMenuItem>
                );
            }
            if (name === 'link') {
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
            if (name === 'comment') {
                const last = context.selections?.[context.selections.length - 1];
                let row_index = last?.row_focus;
                let col_index = last?.column_focus;
                if (!last) {
                    row_index = 0;
                    col_index = 0;
                } else {
                    if (row_index == null) [row_index] = last.row;
                    if (col_index == null) [col_index] = last.column;
                }
                const r = row_index!;
                const c = col_index!;
                const fd = getFlowdata(context);
                const cell = fd?.[r]?.[c];
                const hasComment = (cell?.commentCardIds?.length ?? 0) > 0;
                const closeMenu = () =>
                    setContext((draftCtx) => {
                        draftCtx.contextMenu = {};
                    });
                const close = <T extends unknown[]>(fn?: (...args: T) => void) =>
                    fn
                        ? (...args: T) => {
                              closeMenu();
                              fn(...args);
                          }
                        : undefined;

                const info = hasComment ? (settings.hooks?.getCommentInfo?.(r, c) ?? null) : null;
                const item = info ? { card: info.card, entry: info.entry } : null;
                if (!item && !settings.hooks?.onAddComment) return null;
                return (
                    <CommentMenuItems
                        key={name}
                        primitives={{
                            Item: DropdownMenuItem,
                            Sub: DropdownMenuSub,
                            SubTrigger: DropdownMenuSubTrigger,
                            SubContent: DropdownMenuSubContent,
                        }}
                        item={item}
                        onAddComment={close(
                            settings.hooks?.onAddComment ? () => settings.hooks!.onAddComment!(r, c) : undefined,
                        )}
                        onOpen={close(
                            settings.hooks?.onViewComment ? () => settings.hooks!.onViewComment!(r, c) : undefined,
                        )}
                        onChangeColor={close(
                            settings.hooks?.onCommentColor
                                ? (_cardId: string, color: string) => settings.hooks!.onCommentColor!(r, c, color)
                                : undefined,
                        )}
                        onResolve={close(
                            settings.hooks?.onCommentResolve
                                ? () => settings.hooks!.onCommentResolve!(r, c)
                                : undefined,
                        )}
                        onReopen={close(
                            settings.hooks?.onCommentReopen ? () => settings.hooks!.onCommentReopen!(r, c) : undefined,
                        )}
                        onDelete={close(
                            settings.hooks?.onDeleteComment ? () => settings.hooks!.onDeleteComment!(r, c) : undefined,
                        )}
                    />
                );
            }
            return null;
        },
        [
            context,
            context.currentSheetId,
            context.selections,
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
        ],
    );

    const isOpen = Object.keys(context.contextMenu).length > 0;

    return (
        <DropdownMenu
            open={isOpen}
            onOpenChange={(open) => {
                if (!open)
                    setContext((draftCtx) => {
                        draftCtx.contextMenu = {};
                    });
            }}
        >
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
                onContextMenu={(e) => e.stopPropagation()}
            >
                {context.contextMenu.headerMenu === true
                    ? settings.headerContextMenu.map((menu, i) => getMenuElement(menu, i))
                    : settings.cellContextMenu.map((menu, i) => getMenuElement(menu, i))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
