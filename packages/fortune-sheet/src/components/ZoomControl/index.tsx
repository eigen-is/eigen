import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { Minus, Plus } from 'lucide-react';
import { useCallback, useContext } from 'react';
import { WorkbookContext } from '../../context';
import { type Context, getSheetIndex, locale, MAX_ZOOM_RATIO, MIN_ZOOM_RATIO } from '../../state';

const presets = [
    { text: '10%', value: 0.1 },
    { text: '30%', value: 0.3 },
    { text: '50%', value: 0.5 },
    { text: '70%', value: 0.7 },
    { text: '100%', value: 1 },
    { text: '150%', value: 1.5 },
    { text: '200%', value: 2 },
    { text: '300%', value: 3 },
    { text: '400%', value: 4 },
];

const buttonClass = 'flex cursor-pointer items-center justify-center w-6 h-6 hover:bg-muted rounded';

export function ZoomControl() {
    const { context, setContext } = useContext(WorkbookContext);
    const { info } = locale(context);

    const zoomTo = useCallback(
        (val: number) => {
            val = parseFloat(val.toFixed(1));
            if (val > MAX_ZOOM_RATIO || val < MIN_ZOOM_RATIO) {
                return;
            }
            setContext(
                (ctx: Context) => {
                    const index = getSheetIndex(ctx, ctx.currentSheetId);
                    if (index == null) {
                        return;
                    }
                    ctx.luckysheetfile[index].zoomRatio = val;
                    ctx.zoomRatio = val;
                },
                { noHistory: true },
            );
        },
        [setContext],
    );

    return (
        <aside title="Zoom settings" className="whitespace-nowrap flex items-center select-none">
            <button
                type="button"
                className={buttonClass}
                aria-label={info.zoomOut}
                onClick={(e) => {
                    zoomTo(context.zoomRatio - 0.1);
                    e.stopPropagation();
                }}
            >
                <Minus width={16} height={16} aria-hidden="true" />
            </button>
            <Popover>
                <PopoverTrigger asChild>
                    <button type="button" className={cn(buttonClass, 'w-12 text-xs')}>
                        {(context.zoomRatio * 100).toFixed(0)}%
                    </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-auto p-1 text-xs">
                    {presets.map((v) => (
                        <button
                            type="button"
                            key={v.text}
                            className="block w-full text-left px-2.5 py-1 rounded-sm cursor-pointer hover:bg-muted"
                            onClick={() => zoomTo(v.value)}
                        >
                            {v.text}
                        </button>
                    ))}
                </PopoverContent>
            </Popover>
            <button
                type="button"
                className={buttonClass}
                aria-label={info.zoomIn}
                onClick={(e) => {
                    zoomTo(context.zoomRatio + 0.1);
                    e.stopPropagation();
                }}
            >
                <Plus width={16} height={16} aria-hidden="true" />
            </button>
        </aside>
    );
}
