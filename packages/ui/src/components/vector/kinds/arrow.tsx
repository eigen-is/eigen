// The properties panel's rows that only an arrow has: its type, such as sharp or elbow, its two arrowheads and,
// once every selected arrow has a label, the label's font. The rows every kind shares, such as stroke and
// opacity, stay the panel's own.

import type { Arrowhead, ArrowShape, VectorArrowElement } from '@workspace/lib/vector';
import {
    ARROW_SHAPES,
    arrowShapeFields,
    arrowShapeOf,
    EDGES_OPTIONS,
    normalizeLinear,
    parsePoints,
    redockBindingsForElbow,
} from '@workspace/lib/vector';
import {
    FontRow,
    FontSizeRow,
    getMergedValue,
    MergedSelect,
    PropertyRow,
    PropertySection,
    useHeldGesture,
} from '@workspace/ui/components/properties-panel';
import { useRef } from 'react';
import { measureLoadedVectorText } from '../text-measure';
import type { KindPanelSectionProps } from './index';

// Derived from the canonical ARROW_SHAPES vocabulary so the row and the model never drift.
const ARROW_SHAPE_LABELS: Record<ArrowShape, string> = { sharp: 'Sharp', curved: 'Curved', elbow: 'Elbow' };
const ARROW_SHAPE_OPTIONS: { value: ArrowShape; label: string }[] = ARROW_SHAPES.map((value) => ({
    value,
    label: ARROW_SHAPE_LABELS[value],
}));
const ARROWHEAD_OPTIONS: { value: Arrowhead; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'bar', label: 'Bar' },
    { value: 'circle', label: 'Circle' },
];

export function ArrowPanelSection({ elements, scene, slideWidth, onChange, onChangeEach }: KindPanelSectionProps) {
    const { hold, end: endGesture } = useHeldGesture();
    const pendingFontWrites = useRef(0);
    // The panel mounts a kind's section only when every selected element is of that kind, so this only narrows.
    const arrows = elements.filter((el): el is VectorArrowElement => el.type === 'arrow');
    // An elbow arrow's route lives in its unrotated local frame. So when every selected arrow is an elbow, the
    // panel also pins its Angle input, through a check of its own.
    const allElbow = arrows.length > 0 && arrows.every((el) => el.elbow);
    // An empty label has no font to tune.
    const allLabeled = arrows.length > 0 && arrows.every((el) => el.text !== '');

    const shape = getMergedValue(arrows, (el) => arrowShapeOf(el));
    const roundness = getMergedValue(arrows, (el) => el.roundness);
    const startArrowhead = getMergedValue(arrows, (el) => el.startArrowhead);
    const endArrowhead = getMergedValue(arrows, (el) => el.endArrowhead);
    const fontFamily = getMergedValue(arrows, (el) => el.fontFamily);

    // arrowShapeFields owns the stored fields each shape writes. A switch to elbow first collapses the arrow
    // to its two endpoints, because an elbow route is derived from them, and the points in between would only
    // linger as stray handles. It also sets the angle to 0, all in one sealed transact, so it is one undo step.
    // A switch away from elbow keeps the two endpoints, since there is nothing to restore.
    const applyShape = (next: ArrowShape) => {
        const base = arrowShapeFields(next);
        onChangeEach((el) => {
            if (next !== 'elbow' || el.type !== 'arrow') return base;
            const pts = parsePoints(el.points);
            const collapsed = pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : pts;
            // A bound end's fixedPoint was stored for the straight read; re-dock it for the elbow read so
            // the endpoint sits on the outline, not inside the shape. followBindings re-glues after.
            const redocked = redockBindingsForElbow(el, scene);
            return { ...base, ...redocked, angle: 0, ...normalizeLinear({ ...el, angle: 0 }, collapsed) };
        });
    };

    // A font family or size change measures each arrow's own label again and writes its `labelWidth` in the
    // same transact as the font, so it is one undo step. The height follows from the line count. It measures
    // once the slices of the label's text have loaded, or measureText reads the fallback's metrics.
    //
    // The Size field holds its own undo gesture only while it is focused. When the font has not loaded yet,
    // the write lands after the blur has released that gesture, so each digit would be its own undo step.
    // So the write takes the gesture back itself and keeps it until the last pending load has landed.
    const applyFont = async (fields: (el: VectorArrowElement) => { fontSize?: number; fontFamily?: string }) => {
        pendingFontWrites.current += 1;
        try {
            const patches = new Map(
                await Promise.all(
                    arrows.map(async (el) => {
                        const patch = fields(el);
                        const size = patch.fontSize ?? el.fontSize;
                        const family = patch.fontFamily ?? el.fontFamily;
                        const { width } = await measureLoadedVectorText(el.text, size, family);
                        return [el.id, { ...patch, labelWidth: width }] as const;
                    }),
                ),
            );
            hold();
            onChangeEach((el) => patches.get(el.id) ?? {});
        } finally {
            pendingFontWrites.current -= 1;
            if (pendingFontWrites.current === 0) endGesture();
        }
    };

    return (
        <>
            {allLabeled && (
                /* Only the font and size: the label is always centered, and its color comes from Stroke. */
                <PropertySection title="Text">
                    <FontRow
                        value={fontFamily}
                        onChange={(f) => {
                            applyFont(() => ({ fontFamily: f })).catch(() => {});
                        }}
                    />
                    <FontSizeRow
                        sizes={arrows.map((el) => el.fontSize)}
                        slideWidth={slideWidth}
                        onChange={(size) => {
                            applyFont((el) => ({ fontSize: size(el.fontSize) })).catch(() => {});
                        }}
                    />
                </PropertySection>
            )}

            {/* Titled for the kind, not "Shape". The panel's own Shape section sits below Stroke, and a kind's
                section renders above it, so a section of the same title would move between selections. */}
            <PropertySection title="Arrow">
                <PropertyRow label="Type">
                    <MergedSelect value={shape} onChange={applyShape} options={ARROW_SHAPE_OPTIONS} />
                </PropertyRow>
                {/* An elbow's shaft is always made of straight segments at right angles, so its Edges row sets
                    the corners, sharp bends or round arcs. For a sharp or curved arrow, Type already says it. */}
                {allElbow && (
                    <PropertyRow label="Edges">
                        <MergedSelect
                            value={roundness}
                            onChange={(v) => onChange({ roundness: v })}
                            options={EDGES_OPTIONS}
                        />
                    </PropertyRow>
                )}
            </PropertySection>

            <PropertySection title="Arrowheads">
                <PropertyRow label="Start">
                    <MergedSelect
                        value={startArrowhead}
                        onChange={(v) => onChange({ startArrowhead: v })}
                        options={ARROWHEAD_OPTIONS}
                    />
                </PropertyRow>
                <PropertyRow label="End">
                    <MergedSelect
                        value={endArrowhead}
                        onChange={(v) => onChange({ endArrowhead: v })}
                        options={ARROWHEAD_OPTIONS}
                    />
                </PropertyRow>
            </PropertySection>
        </>
    );
}
