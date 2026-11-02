// The workbook's app bar: the host's items and the Edit, View, Insert, Format and Data menus on the left, the format
// icon row in the middle and the host's other items on the right. The shared CenteredToolbar lays it out, as it does
// the other editors' bars. While a cell is open, every menu hands the focus back to the cell editor as it closes.

import { AppBarMenu, CenteredToolbar } from '@workspace/ui/components/layout/toolbar';
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

// The bar is a size container, so the icon row folds by the bar's own width, and a panel beside the workbook counts.
// Below 512px the menus get less padding, so all six fit beside the share buttons, and beside the phone's kebab on a
// 360px screen.
export function WorkbookMenuBar({ leftItems, rightItems }: Props) {
    const { context } = useContext(WorkbookContext);
    const { focusFindBarRef, onCloseAutoFocus: refocusFindBar } = useFindBarRefocus();
    const refocusCellEditor = useCellEditorRefocus();
    // Read once for the toolbar and the Format menu, so a caret move reads the editor once.
    const caret = useEditorSelectionStyle();
    return (
        <div className="@container flex items-center h-12 app-gutter-x border-b border-border bg-background">
            <CenteredToolbar
                left={
                    <Menubar className="@max-[512px]:**:data-[slot=menubar-trigger]:px-2">
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

                        {/* View, Insert, Format and Data only change the workbook, so a viewer doesn't see them, as
                            with FormatToolbar. Edit stays, as Copy and Find check each row. A viewer still reads
                            comments through the Comments panel. */}
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
                }
                center={<FormatToolbar caret={caret} />}
                right={rightItems}
            />
        </div>
    );
}
