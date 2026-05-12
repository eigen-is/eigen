import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { type Context, getSheetIndex, locale } from '../../state';

type ChangeColorProps = {
    triggerParentUpdate: (state: boolean) => void;
};

export function ChangeColor({ triggerParentUpdate: _triggerParentUpdate }: ChangeColorProps) {
    const { context, setContext } = useContext(WorkbookContext);
    const { sheetconfig } = locale(context);
    const [selectColor, setSelectColor] = useState<string | undefined>(
        context.luckysheetfile[getSheetIndex(context, context.currentSheetId) as number].color,
    );

    useEffect(() => {
        setContext((ctx: Context) => {
            if (ctx.allowEdit === false) return;
            const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
            ctx.luckysheetfile[index].color = selectColor;
        });
    }, [selectColor, setContext]);

    return (
        <div className="p-3">
            <ColorPicker
                value={selectColor ?? ''}
                resetLabel={sheetconfig.resetColor}
                onChange={(color) => setSelectColor(color || undefined)}
            />
        </div>
    );
}
