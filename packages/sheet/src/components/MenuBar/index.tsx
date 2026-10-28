// The workbook's menu bar: the Edit, View, Insert, Format and Data menus, the format toolbar in the middle
// and the host's own items at either end. While a cell is open, every menu hands the focus back to the cell
// editor as it closes.

import { AppBarMenu } from '@workspace/ui/components/layout/toolbar';
import { Menubar } from '@workspace/ui/components/menubar';
import { useFindBarRefocus } from '@workspace/ui/components/search/find-in-document-button';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useCellEditorRefocus } from '../../hooks/useCellEditorRefocus';
import { useEditorSelectionStyle } from '../../hooks/useEditorSelectionStyle';
import { DataMenu } from './data-menu';
import { FormatMenu } from './format-menu';
import { FormatToolbar } from './format-toolbar';
import { InsertMenu } from './insert-menu';
import { SheetEditMenu } from './sheet-edit-menu';
import { ViewMenu } from './view-menu';

type Props = {
    leftItems?: ReactNode;
    rightItems?: ReactNode;
};

// 1fr·auto·1fr grid: the equal side columns keep the center column at the bar's true
// center, so FormatToolbar sits dead-center regardless of the menu / right-icon widths.
// The center slot is always rendered so the columns stay put when the toolbar hides.
// Below FormatToolbar's seam nothing needs centering, so the side columns give way:
// the menu row scrolls in the leftover space and the right icons keep their width on-screen.
// The seam is a container query on the bar's own width, so a sidebar beside the workbook counts.
export function MenuBar({ leftItems, rightItems }: Props) {
    const { context } = useContext(WorkbookContext);
    const { focusFindBarRef, onCloseAutoFocus: refocusFindBar } = useFindBarRefocus();
    const refocusCellEditor = useCellEditorRefocus();
    // Read once for the toolbar and the Format menu, so a caret move reads the editor once.
    const caret = useEditorSelectionStyle();
    return (
        <div className="@container border-b border-border bg-background">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] @[1360px]:grid-cols-[1fr_auto_1fr] items-center gap-1 app-gutter-x h-12">
                <Menubar className="min-w-0 overflow-x-auto">
                    {leftItems}
                    <AppBarMenu
                        label="Edit"
                        contentClassName="w-56 sheet-mousedown-cancel"
                        onCloseAutoFocus={(event) => {
                            refocusFindBar(event);
                            if (!event.defaultPrevented) refocusCellEditor(event);
                        }}
                    >
                        <SheetEditMenu focusFindBarRef={focusFindBarRef} />
                    </AppBarMenu>

                    {/* View / Insert / Format / Data are wholly mutating — hidden for viewers, like
                        FormatToolbar. Edit stays (Copy / Find gate per-item); viewers still read
                        comments via the ungated Comments panel toggle. */}
                    {context.allowEdit && (
                        <>
                            <AppBarMenu
                                label="View"
                                contentClassName="w-56 sheet-mousedown-cancel"
                                onCloseAutoFocus={refocusCellEditor}
                            >
                                <ViewMenu />
                            </AppBarMenu>

                            <AppBarMenu
                                label="Insert"
                                contentClassName="w-56 sheet-mousedown-cancel"
                                onCloseAutoFocus={refocusCellEditor}
                            >
                                <InsertMenu />
                            </AppBarMenu>

                            <AppBarMenu
                                label="Format"
                                contentClassName="w-64 sheet-mousedown-cancel"
                                onCloseAutoFocus={refocusCellEditor}
                            >
                                <FormatMenu caret={caret} />
                            </AppBarMenu>

                            <AppBarMenu
                                label="Data"
                                contentClassName="w-56 sheet-mousedown-cancel"
                                onCloseAutoFocus={refocusCellEditor}
                            >
                                <DataMenu />
                            </AppBarMenu>
                        </>
                    )}
                </Menubar>

                <div className="flex justify-center">
                    <FormatToolbar caret={caret} />
                </div>

                <div className="flex items-center justify-self-end gap-1">{rightItems}</div>
            </div>
        </div>
    );
}
