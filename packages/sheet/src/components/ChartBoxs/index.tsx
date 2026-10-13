import { parseChartSpec } from '@workspace/lib/charts';
import { downloadBlob } from '@workspace/lib/download';
import type { SheetChart } from '@workspace/lib/sheets';
import { type Box, orderByFractionalIndex } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ObjectTransform } from '@workspace/ui/components/transform/object-transform';
import { cn } from '@workspace/ui/lib/utils';
import { EllipsisVertical } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import {
    type ChartBox as ChartBoxFields,
    chartSvg,
    deleteActiveChart,
    getSheetIndex,
    selectChart,
    updateChartBox,
} from '../../state';

// Resize floor (scene px === screen px; the grid is unzoomed).
const MIN_CHART_SIZE = 40;

// The charts of the current sheet over the grid, in their paint order and above the images, the way
// ImgBoxs lays out an image: the stored box in grid pixels from A1.
export function ChartBoxs() {
    const { context } = useContext(WorkbookContext);
    const index = getSheetIndex(context, context.currentSheetId);
    const charts = index == null ? [] : Object.values(context.sheets[index].charts ?? {});
    return (
        <div id="sheet-chart-boxes">
            {orderByFractionalIndex(charts).map((chart) => (
                <ChartBox key={chart.id} chart={chart} />
            ))}
        </div>
    );
}

function ChartBox({ chart }: { chart: SheetChart }) {
    const { context, setContext } = useContext(WorkbookContext);
    const active = context.activeChart?.id === chart.id;
    const canEdit = context.allowEdit !== false;

    // A move or resize previews locally and writes once at the end of the gesture.
    const [preview, setPreview] = useState<Box | null>(null);
    const box: Box = preview ?? { x: chart.x, y: chart.y, width: chart.width, height: chart.height, angle: 0 };
    const resized = box.width !== chart.width || box.height !== chart.height;
    const svg = chartSvg(context, resized ? { ...chart, width: box.width, height: box.height } : chart);

    // The selected chart holds the focus, so the workbook's keydown sees Delete.
    const container = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (active) container.current?.focus({ preventScroll: true });
    }, [active]);

    // ObjectTransform's Escape-cancel and no-move paths fire no onCommit, so their preview would stick.
    useEffect(() => {
        if (!active) return;
        const clear = () => setPreview((p) => (p ? null : p));
        document.addEventListener('pointerup', clear);
        window.addEventListener('blur', clear);
        return () => {
            document.removeEventListener('pointerup', clear);
            window.removeEventListener('blur', clear);
        };
    }, [active]);

    // A peer deleting the chart mid-drag unmounts it; the document listeners go with it.
    const drag = useRef<AbortController | null>(null);
    useEffect(() => () => drag.current?.abort(), []);

    const startMove = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        setContext((ctx) => selectChart(ctx, chart.id));
        if (!canEdit) return;
        const controller = new AbortController();
        drag.current?.abort();
        drag.current = controller;
        const start = { x: e.clientX, y: e.clientY };
        const moved = (ev: PointerEvent) => ({
            x: Math.max(0, chart.x + ev.clientX - start.x),
            y: Math.max(0, chart.y + ev.clientY - start.y),
        });
        document.addEventListener(
            'pointermove',
            (ev) => setPreview({ ...moved(ev), width: chart.width, height: chart.height, angle: 0 }),
            { signal: controller.signal },
        );
        document.addEventListener(
            'pointerup',
            (ev) => {
                controller.abort();
                setPreview(null);
                const { x, y } = moved(ev);
                if (x !== chart.x || y !== chart.y) setContext((ctx) => updateChartBox(ctx, chart.id, { x, y }));
            },
            { signal: controller.signal },
        );
        // A touch the browser took for a pan never ends in pointerup, so the next tap would commit a move.
        document.addEventListener(
            'pointercancel',
            () => {
                controller.abort();
                setPreview(null);
            },
            { signal: controller.signal },
        );
    };

    // White as the export draws it. The labels name Inter without embedding it: the font files are bundled
    // into the server's export only.
    const download = () => {
        const title = parseChartSpec(chart.spec)?.title;
        const white = svg.replace(/^<svg[^>]*>/, (open) => `${open}<rect width="100%" height="100%" fill="#fff"/>`);
        downloadBlob(new Blob([white], { type: 'image/svg+xml' }), `${title || 'Chart'}.svg`);
    };

    return (
        <div
            ref={container}
            data-chart-id={chart.id}
            data-active={active || undefined}
            tabIndex={-1}
            // pointer-events-auto: the pane-region wrapper is pointer-events none. touch-none only while
            // selected, so a finger on an unselected chart still pans the grid. select-none: a double-click
            // opens the editor and would otherwise select the drawing's text.
            className={cn(
                'group absolute pointer-events-auto bg-background outline-none select-none',
                canEdit && 'cursor-move',
                active && canEdit && 'touch-none',
            )}
            style={{ left: box.x, top: box.y, width: box.width, height: box.height, zIndex: active ? 20 : 19 }}
            onPointerDown={startMove}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
                e.stopPropagation();
                if (canEdit) setContext((ctx) => selectChart(ctx, chart.id, true));
            }}
            onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                setContext((ctx) => {
                    ctx.activeChart = undefined;
                });
            }}
        >
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the painter's own svg; parseChartSpec checks every color and label it draws */}
            <div dangerouslySetInnerHTML={{ __html: svg }} />
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Chart menu"
                        className={cn(
                            'absolute top-1 right-1 size-7 invisible group-hover:visible pointer-coarse:visible',
                            active && 'visible',
                        )}
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        <EllipsisVertical />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="sheet-mousedown-cancel">
                    {canEdit && (
                        <>
                            <DropdownMenuItem onClick={() => setContext((ctx) => selectChart(ctx, chart.id, true))}>
                                Edit the chart
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() =>
                                    setContext((ctx) => {
                                        selectChart(ctx, chart.id);
                                        deleteActiveChart(ctx);
                                    })
                                }
                            >
                                Delete chart
                            </DropdownMenuItem>
                        </>
                    )}
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Download chart</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            <DropdownMenuItem onClick={download}>SVG (.svg)</DropdownMenuItem>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </DropdownMenuContent>
            </DropdownMenu>
            {active && canEdit && (
                <ObjectTransform
                    box={box}
                    // The ring fills this already-positioned box; x and y in `box` still drive the resize.
                    boxToStyle={() => ({ left: 0, top: 0, width: box.width, height: box.height })}
                    screenDeltaToScene={(dx, dy) => ({ dx, dy })}
                    showRotate={false}
                    minSize={MIN_CHART_SIZE}
                    onTransform={setPreview}
                    onCommit={(next, start) => {
                        setPreview(null);
                        const fields: Partial<ChartBoxFields> = {};
                        if (next.x !== start.x) fields.x = next.x;
                        if (next.y !== start.y) fields.y = next.y;
                        if (next.width !== start.width) fields.width = next.width;
                        if (next.height !== start.height) fields.height = next.height;
                        if (Object.keys(fields).length > 0) {
                            setContext((ctx) => updateChartBox(ctx, chart.id, fields));
                        }
                    }}
                />
            )}
        </div>
    );
}
