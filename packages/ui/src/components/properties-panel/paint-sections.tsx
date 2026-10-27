// The paint rows every drawn object shares: a chart's label color, the fill and its hatch, the stroke and the
// sketch. The canvas panel shows them for any selection, merging each across it, and ChartSections for one chart, in
// Docs and Sheets; each host writes what a row hands back to its own store.

import { MAX_SKETCH_POINTS } from '@workspace/lib/charts';
import type { Fill, FillPaint } from '@workspace/lib/types/background';
import type { ChartLook } from '@workspace/lib/types/chart';
import type { FillStyle, StrokeStyle } from '@workspace/lib/vector';
import { isTransparentFill, parseFill, round, TRANSPARENT_FILL } from '@workspace/lib/vector';
import type { ReactNode } from 'react';
import { BackgroundFillBlock } from './background-fill-block';
import { ColorRow } from './color-row';
import { MergedNumberInput } from './merged-number-input';
import { MergedSelect, numToStr } from './merged-select';
import type { MergedValue } from './merged-value';
import { isMixed } from './merged-value';
import { PropertyRow, PropertySection } from './properties-panel';

// Discrete presets, the Excalidraw constants: roughness 0/1/2.
const ROUGHNESS_OPTIONS: { value: string; label: string }[] = [
    { value: '0', label: 'Architect' },
    { value: '1', label: 'Artist' },
    { value: '2', label: 'Cartoonist' },
];
const STROKE_STYLE_OPTIONS: { value: StrokeStyle; label: string }[] = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
];
const FILL_STYLE_OPTIONS: { value: FillStyle; label: string }[] = [
    { value: 'solid', label: 'Solid' },
    { value: 'hachure', label: 'Hachure' },
    { value: 'cross-hatch', label: 'Cross-hatch' },
    { value: 'zigzag', label: 'Zigzag' },
];

type PaintSectionsProps = {
    // The stored fill; undefined leaves the Fill section out.
    fill?: MergedValue<string>;
    // The fill's hatch half; undefined leaves its row out.
    fillStyle?: MergedValue<FillStyle>;
    // A chart's hatch is its bars' and slices', so its row shows with no background; a shape's fills its body.
    marksHatch?: boolean;
    strokeColor: MergedValue<string>;
    // Any px, as a pptx's 1 pt line stores 2.67 on a 10 in deck: shown to the hundredth, stored as typed.
    strokeWidth: MergedValue<number>;
    // undefined leaves the dash row out.
    strokeStyle?: MergedValue<StrokeStyle>;
    strokeOptional: boolean;
    roughness: MergedValue<number>;
    // A chart's label color; undefined leaves the Labels section out.
    color?: MergedValue<string>;
    // The chart has more points than the sketch draws.
    sketchCapped?: boolean;
    // The two halves of the fill are written apart, so each write keeps the other half of each fill.
    onFill: (next: (fill: Fill) => Fill) => void;
    onChange: (patch: Partial<ChartLook>) => void;
    // The host's rows between Stroke and Sketch, the canvas's Shape section.
    children?: ReactNode;
};

export function PaintSections({
    fill,
    fillStyle,
    marksHatch = false,
    strokeColor,
    strokeWidth,
    strokeStyle,
    strokeOptional,
    roughness,
    color,
    sketchCapped = false,
    onFill,
    onChange,
    children,
}: PaintSectionsProps) {
    // A transparent solid is "no fill", which is BackgroundFillBlock's `null`.
    const parsedFill = typeof fill === 'string' && !isMixed(fill) ? parseFill(fill) : null;
    const fillValue = parsedFill && !isTransparentFill(parsedFill) ? parsedFill : null;
    return (
        <>
            {color !== undefined && (
                <PropertySection title="Labels">
                    <ColorRow label="Color" value={color} onChange={(c) => onChange({ color: c })} />
                </PropertySection>
            )}

            {fill !== undefined && (
                <BackgroundFillBlock
                    title="Fill"
                    value={fillValue}
                    mixed={isMixed(fill)}
                    onChange={(next) => {
                        const paint: FillPaint = next === null || next.type === 'image' ? TRANSPARENT_FILL : next;
                        onFill((current) => ({ ...paint, style: current.style }));
                    }}
                    allowedTypes={['solid', 'gradient']}
                    keepChildren={marksHatch}
                >
                    {fillStyle !== undefined && (
                        <PropertyRow label="Style">
                            <MergedSelect
                                value={fillStyle}
                                onChange={(style) => onFill((current) => ({ ...current, style }))}
                                options={FILL_STYLE_OPTIONS}
                            />
                        </PropertyRow>
                    )}
                </BackgroundFillBlock>
            )}

            <PropertySection title="Stroke">
                <ColorRow
                    label="Color"
                    value={strokeColor}
                    onChange={(c) => onChange({ strokeColor: c })}
                    allowNone={strokeOptional}
                />
                <PropertyRow label="Width">
                    <MergedNumberInput
                        value={typeof strokeWidth === 'number' ? round(strokeWidth) : strokeWidth}
                        onChange={(v) => onChange({ strokeWidth: v })}
                        // The field shows the decimals of its step, and a pptx's 1 pt line of 2.67 px needs two.
                        step={0.01}
                        min={0}
                        max={100}
                    />
                </PropertyRow>
                {strokeStyle !== undefined && (
                    <PropertyRow label="Style">
                        <MergedSelect
                            value={strokeStyle}
                            onChange={(v) => onChange({ strokeStyle: v })}
                            options={STROKE_STYLE_OPTIONS}
                        />
                    </PropertyRow>
                )}
            </PropertySection>

            {children}

            <PropertySection title="Sketch">
                <PropertyRow label="Style">
                    <MergedSelect
                        value={numToStr(roughness)}
                        onChange={(v) => onChange({ roughness: Number(v) })}
                        options={ROUGHNESS_OPTIONS}
                    />
                </PropertyRow>
                {sketchCapped && (
                    <p className="text-xs text-muted-foreground">
                        Past {MAX_SKETCH_POINTS} points the data draws without the sketch; the axes and legend keep it.
                    </p>
                )}
            </PropertySection>
        </>
    );
}
