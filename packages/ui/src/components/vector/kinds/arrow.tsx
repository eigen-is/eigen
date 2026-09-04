// The arrow's own panel rows: its type (sharp / curved / elbow), its two arrowheads, and — once every
// selected arrow carries a label — the label's font. The generic capability rows (stroke, sketch,
// opacity) stay the panel's; these are the questions only an arrow answers.

import {
    ARROW_SHAPES,
    type Arrowhead,
    type ArrowShape,
    arrowShapeFields,
    arrowShapeOf,
    normalizeLinear,
    parsePoints,
    type Roundness,
    redockBindingsForElbow,
    type VectorArrowElement,
} from '@workspace/lib/vector';
import {
    FontRow,
    getMergedValue,
    MergedNumberInput,
    MergedSelect,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';
import { loadVectorFont, measureVectorText } from '../text-measure';
import type { KindPanelSectionProps } from './index';

// Derived from the canonical ARROW_SHAPES vocabulary so the row and the model never drift.
const ARROW_SHAPE_LABELS: Record<ArrowShape, string> = { sharp: 'Sharp', curved: 'Curved', elbow: 'Elbow' };
const ARROW_SHAPE_OPTIONS: { value: ArrowShape; label: string }[] = ARROW_SHAPES.map((value) => ({
    value,
    label: ARROW_SHAPE_LABELS[value],
}));
// An elbow reuses Edges as its CORNER style (sharp bends vs round arcs) — its shaft is always
// orthogonal, so roundness is free to mean the corners. A sharp/curved arrow's Type already says it.
const EDGES_OPTIONS: { value: Roundness; label: string }[] = [
    { value: 'sharp', label: 'Sharp' },
    { value: 'round', label: 'Rounded' },
];
const ARROWHEAD_OPTIONS: { value: Arrowhead; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'bar', label: 'Bar' },
    { value: 'circle', label: 'Circle' },
];

export function ArrowPanelSection({ elements, scene, onChange, onChangeEach }: KindPanelSectionProps) {
    // The panel mounts a kind's section only for a SOLE-kind selection, so this narrows rather than filters.
    const arrows = elements.filter((el): el is VectorArrowElement => el.type === 'arrow');
    // An elbow arrow's route lives in the unrotated local frame, so a pure-elbow selection also pins the
    // panel's Angle input (the panel's own gate).
    const allElbow = arrows.length > 0 && arrows.every((el) => el.elbow);
    // An empty label has no font to tune.
    const allLabeled = arrows.length > 0 && arrows.every((el) => el.text !== '');

    const shape = getMergedValue(arrows, (el) => arrowShapeOf(el));
    const roundness = getMergedValue(arrows, (el) => el.roundness);
    const startArrowhead = getMergedValue(arrows, (el) => el.startArrowhead);
    const endArrowhead = getMergedValue(arrows, (el) => el.endArrowhead);
    const fontFamily = getMergedValue(arrows, (el) => el.fontFamily);
    const fontSize = getMergedValue(arrows, (el) => el.fontSize);

    // arrowShapeFields owns the stored fields each shape writes back. Switching TO elbow first collapses
    // the arrow to its two endpoints — an elbow route is DERIVED from them, so interior vertices would
    // only linger as stray endpoint handles — and pins angle 0, all in the one sealed transact.
    // Switching AWAY keeps the two endpoints (nothing to restore). One undo step.
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

    // A font family / size change re-measures each arrow's own label and writes `labelWidth` (the sole
    // width source, height derives from the line count) in the SAME transact as the font — after the face
    // loads, or measureText reads fallback metrics. Per-element widths (each label differs), one undo step.
    const applyFont = async (patch: { fontSize?: number; fontFamily?: string }) => {
        await Promise.all(
            arrows.map((el) => loadVectorFont(patch.fontSize ?? el.fontSize, patch.fontFamily ?? el.fontFamily)),
        );
        onChangeEach((el) => {
            if (el.type !== 'arrow') return patch;
            const size = patch.fontSize ?? el.fontSize;
            const family = patch.fontFamily ?? el.fontFamily;
            return { ...patch, labelWidth: measureVectorText(el.text, size, family).width };
        });
    };

    return (
        <>
            {allLabeled && (
                /* Font + size only — the label is always centered and its colour comes from Stroke. */
                <PropertySection title="Text">
                    <FontRow
                        value={fontFamily}
                        onChange={(f) => {
                            applyFont({ fontFamily: f }).catch(() => {});
                        }}
                    />
                    <PropertyRow label="Size">
                        <MergedNumberInput
                            value={fontSize}
                            onChange={(v) => {
                                applyFont({ fontSize: v }).catch(() => {});
                            }}
                            min={8}
                            max={200}
                            step={1}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

            <PropertySection title="Shape">
                <PropertyRow label="Type">
                    <MergedSelect value={shape} onChange={applyShape} options={ARROW_SHAPE_OPTIONS} />
                </PropertyRow>
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
