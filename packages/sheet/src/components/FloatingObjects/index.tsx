import { floatingItems, type SheetFloatingItem } from '@workspace/lib/sheets';
import type { ZOp } from '@workspace/lib/vector';
import { downloadChartImage } from '@workspace/ui/components/charts';
import { ObjectContextMenu, useContextMenu } from '@workspace/ui/components/context-menu';
import { useZOrderHotkeys } from '@workspace/ui/components/properties-panel';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import {
    copyActiveObject,
    deleteFloatingObject,
    deselectFloatingObject,
    duplicateFloatingObject,
    getSheetIndex,
    reorderFloatingObject,
    selectFloatingObject,
    sheetChartClipboardItem,
} from '../../state';
import { ChartContent } from './ChartContent';
import { FloatingObjectFrame } from './FloatingObjectFrame';
import { ImageContent } from './ImageContent';

const refOf = ({ kind, object }: SheetFloatingItem) => ({ kind, id: object.id });

// The current sheet's images and charts over the grid in their one paint order, DOM order being paint order, with
// one right-click and long-press menu and the z-order keys for the selected one.
export function FloatingObjects() {
    const { context, setContext, settings } = useContext(WorkbookContext);
    const index = getSheetIndex(context, context.currentSheetId);
    const items = index == null ? [] : floatingItems(context.sheets[index]);
    const { activeObject } = context;
    const canEdit = context.allowEdit !== false;
    const [ringLayer, setRingLayer] = useState<HTMLDivElement | null>(null);

    // The menu acts on the object it opened on, which it selects, so Cut and Copy reach the Workbook's listener.
    const contextMenu = useContextMenu<SheetFloatingItem>();
    const select = (item: SheetFloatingItem) => setContext((ctx) => selectFloatingObject(ctx, refOf(item)));
    const longPress = useLongPress<SheetFloatingItem>((item, x, y) => {
        select(item);
        contextMenu.openAt(item, x, y);
    });

    useZOrderHotkeys(canEdit && activeObject != null, (op: ZOp) => {
        if (activeObject) setContext((ctx) => reorderFloatingObject(ctx, activeObject, op));
    });

    const menuItem = contextMenu.item;
    const menuRef = menuItem && refOf(menuItem);
    // A chart that draws #REF! or too much data has no item, and no Download image.
    const menuChart = menuItem?.kind === 'chart' ? sheetChartClipboardItem(context, menuItem.object) : null;

    return (
        <div id="sheet-floating-objects">
            {items.map((item) => (
                <FloatingObjectFrame
                    key={item.object.id}
                    item={item}
                    active={activeObject?.kind === item.kind && activeObject.id === item.object.id}
                    ringLayer={ringLayer}
                    longPress={longPress.bind(item)}
                    onContextMenu={(e) => {
                        select(item);
                        contextMenu.handleContextMenu(e, item);
                    }}
                >
                    {(box) =>
                        item.kind === 'image' ? (
                            <ImageContent image={item.object} />
                        ) : (
                            <ChartContent chart={item.object} box={box} />
                        )
                    }
                </FloatingObjectFrame>
            ))}
            <div ref={setRingLayer} />
            <ObjectContextMenu
                contextMenu={contextMenu}
                canEdit={canEdit}
                imagePath={
                    menuItem?.kind === 'image'
                        ? settings.hooks?.resolveImagePath?.(menuItem.object.mediaName)
                        : undefined
                }
                onDownloadImage={menuChart ? () => downloadChartImage(menuChart) : undefined}
                onArrange={(op) => menuRef && setContext((ctx) => reorderFloatingObject(ctx, menuRef, op))}
                onCut={() => copyActiveObject(true)}
                onCopy={() => copyActiveObject(false)}
                onDuplicate={() => menuRef && setContext((ctx) => duplicateFloatingObject(ctx, menuRef))}
                onDelete={() =>
                    menuRef &&
                    setContext((ctx) => {
                        deleteFloatingObject(ctx, menuRef);
                        deselectFloatingObject(ctx);
                    })
                }
            />
        </div>
    );
}
