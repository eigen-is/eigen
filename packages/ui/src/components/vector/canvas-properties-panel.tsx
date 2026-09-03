// The right-side w-64 properties panel for the vector editor — mirrors how slides mounts
// SlidePropertiesPanel (non-empty selection + canEdit). It edits every selected element through
// the shared MIXED conventions: '—' in number inputs / color swatches / select placeholders and a
// data-mixed attribute on toggles. Each control change is one updateElements transact across the
// selection (one undo step, stopCapturing sealed on both sides). Field scoping: fill /
// fill style / sketch are shapes-only, edges rect+diamond-only, font controls text-only, and
// strokeColor doubles as the text color.

import {
    ARROW_SHAPES,
    type ArrangeOp,
    type Arrowhead,
    type ArrowShape,
    arrowShapeFields,
    arrowShapeOf,
    type Box,
    type Corners,
    computeArrange,
    DEFAULT_FONT_FAMILY,
    ELEMENT_KINDS,
    type FillStyle,
    isClosedPath,
    isLinearElement,
    isTransparentFill,
    normalizeLinear,
    parseFill,
    parsePoints,
    type Roundness,
    redockBindingsForElbow,
    resizeLinear,
    STROKE_WIDTH_OPTIONS,
    type StrokeStyle,
    solidFill,
    type VectorArrowElement,
    type VectorElement,
    type VectorElementType,
    type VectorLinearElement,
} from '@workspace/lib/vector';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import {
    AlignSection,
    ColorRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    MergedSelect,
    type MergedValue,
    numToStr,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    TransformSection,
    type ZOp,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import type * as Y from 'yjs';
import type { VectorElementPatch } from './hooks/use-canvas-doc';
import { applyZOrder } from './hooks/use-canvas-keyboard';
import { loadVectorFont, measureVectorText } from './text-measure';

const TYPE_LABELS: Record<VectorElementType, string> = {
    rectangle: 'Rectangle',
    diamond: 'Diamond',
    ellipse: 'Ellipse',
    richtext: 'Text',
    image: 'Image',
    freedraw: 'Freehand',
    line: 'Line',
    arrow: 'Arrow',
};

// Discrete presets, the Excalidraw constants: strokeWidth 1/2/4 (STROKE_WIDTH_OPTIONS,
// shared from lib), roughness 0/1/2.
const ROUGHNESS_OPTIONS: { value: string; label: string }[] = [
    { value: '0', label: 'Architect' },
    { value: '1', label: 'Artist' },
    { value: '2', label: 'Cartoonist' },
];
const EDGES_OPTIONS: { value: Roundness; label: string }[] = [
    { value: 'sharp', label: 'Sharp' },
    { value: 'round', label: 'Rounded' },
];
// The box kinds' corner treatment — a different question from a shaft's curvature, hence its own row.
const CORNERS_OPTIONS: { value: Corners; label: string }[] = [
    { value: 'straight', label: 'Straight' },
    { value: 'curved', label: 'Curved' },
    { value: 'round', label: 'Round' },
];
// The arrow-type row — derived from the canonical ARROW_SHAPES vocabulary so the two never drift.
const ARROW_SHAPE_LABELS: Record<ArrowShape, string> = { sharp: 'Sharp', curved: 'Curved', elbow: 'Elbow' };
const ARROW_SHAPE_OPTIONS: { value: ArrowShape; label: string }[] = ARROW_SHAPES.map((value) => ({
    value,
    label: ARROW_SHAPE_LABELS[value],
}));
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
const ARROWHEAD_OPTIONS: { value: Arrowhead; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'bar', label: 'Bar' },
    { value: 'circle', label: 'Circle' },
];

// The solid colour the Fill swatch shows: '' for transparent (an unset swatch) and for a gradient,
// which has no single swatch colour. undefined on a kind that has no fill.
function fillColorOf(el: VectorElement): string | undefined {
    if (!ELEMENT_KINDS[el.type].capabilities.fill || !('fill' in el)) return undefined;
    const fill = parseFill(el.fill);
    return fill.type === 'solid' && !isTransparentFill(fill) ? fill.color : '';
}

// A width/height change on a linear element must rescale its points through resizeLinear, not
// overwrite the box; the box fills each unset field from the element so x/y/angle-only changes pass through.
function resizeLinearTo(el: VectorLinearElement | VectorArrowElement, patch: Partial<Box>) {
    return resizeLinear(el, {
        x: patch.x ?? el.x,
        y: patch.y ?? el.y,
        width: patch.width ?? el.width,
        height: patch.height ?? el.height,
        angle: patch.angle ?? el.angle,
    });
}

type CanvasPropertiesPanelProps = {
    // All elements — z-order reorders the selection relative to the rest (computeZOrder needs both).
    elements: VectorElement[];
    selectedElements: VectorElement[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    undoManager: Y.UndoManager | null;
    // Aspect lock, owned by the editor so the panel checkbox and the canvas'
    // ObjectTransform resizeMode share one ephemeral setting.
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
};

export function CanvasPropertiesPanel({
    elements,
    selectedElements,
    updateElements,
    undoManager,
    aspectLocked,
    onAspectLockChange,
}: CanvasPropertiesPanelProps) {
    const selectedIds = selectedElements.map((el) => el.id);
    const byId = new Map(selectedElements.map((el) => [el.id, el]));
    const has = selectedElements.length > 0;
    // Paint sections (Stroke / Fill / Sketch) are the roughjs-drawn kinds — capabilities.roughness is
    // exactly that family. An image and a rich-text box are DOM boxes; this path paints neither.
    const allPaintable = has && selectedElements.every((el) => ELEMENT_KINDS[el.type].capabilities.roughness);
    // Fill needs a fillable kind, and an OPEN linear element has nothing to fill.
    const showFill =
        has &&
        selectedElements.every(
            (el) =>
                ELEMENT_KINDS[el.type].capabilities.fill &&
                (!isLinearElement(el) || isClosedPath(parsePoints(el.points))),
        );
    // Stroke Style (dashed/dotted) is meaningless for a freehand stroke — hide it if any is selected.
    const anyFreedraw = selectedElements.some((el) => el.type === 'freedraw');
    // Corners follow the kind's own capability; the separate Edges row is the shaft curvature a line or
    // an arrow carries (round curve vs sharp polyline), never freedraw.
    const allCorners = has && selectedElements.every((el) => ELEMENT_KINDS[el.type].capabilities.corners);
    const allRoundable = has && selectedElements.every((el) => el.type === 'line' || el.type === 'arrow');
    // Arrowheads apply to arrows only (both ends selectable per selection).
    const arrowEls = selectedElements.filter((el): el is VectorArrowElement => el.type === 'arrow');
    const allArrow = has && arrowEls.length === selectedElements.length;
    // An elbow arrow pins angle 0 (its route lives in the unrotated local frame), so a pure-elbow
    // selection disables the panel Angle input.
    const allElbow = allArrow && arrowEls.every((el) => el.elbow);
    // A Text section (font + size only — the label is always centered, its colour comes from Stroke)
    // shows for arrows once every one carries a label; an empty label has no font to tune.
    const allArrowLabeled = allArrow && arrowEls.every((el) => el.text !== '');

    // Same fields on every selected element — one transact, one undo step.
    const applyToAll = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        undoManager?.stopCapturing();
        updateElements(selectedIds.map((id) => ({ id, fields })));
        undoManager?.stopCapturing();
    };

    // The arrow-type row. arrowShapeFields owns the stored fields each shape writes back. Switching
    // TO elbow first collapses the arrow to its two endpoints — an elbow route is DERIVED from them, so
    // interior vertices would only linger as stray endpoint handles — and pins angle 0, all in the one
    // sealed transact. Switching AWAY keeps the two endpoints (nothing to restore). One undo step.
    const applyArrowShape = (shape: ArrowShape) => {
        if (!arrowEls.length) return;
        const base = arrowShapeFields(shape);
        const allById = new Map(elements.map((el) => [el.id, el]));
        undoManager?.stopCapturing();
        updateElements(
            arrowEls.map((el) => {
                if (shape !== 'elbow') return { id: el.id, fields: base };
                const pts = parsePoints(el.points);
                const collapsed = pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : pts;
                // A bound end's fixedPoint was stored for the straight read; re-dock it for the elbow read so
                // the endpoint sits on the outline, not inside the shape. followBindings re-glues after.
                const redocked = redockBindingsForElbow(el, allById);
                return {
                    id: el.id,
                    fields: { ...base, ...redocked, angle: 0, ...normalizeLinear({ ...el, angle: 0 }, collapsed) },
                };
            }),
        );
        undoManager?.stopCapturing();
    };

    // Numeric transform writes. A width/height change routes linear elements through resizeLinearTo so
    // their points scale with the box; x/y/angle-only changes pass straight through.
    const applyTransform = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        const resizesLinear = fields.width !== undefined || fields.height !== undefined;
        undoManager?.stopCapturing();
        updateElements(
            selectedIds.map((id) => {
                const el = byId.get(id);
                if (resizesLinear && el && isLinearElement(el)) {
                    return { id, fields: { ...fields, ...resizeLinearTo(el, fields) } };
                }
                return { id, fields };
            }),
        );
        undoManager?.stopCapturing();
    };

    // A font family / size change re-measures each arrow's own label and writes `labelWidth` (the sole
    // width source, height derives from the line count) in the SAME transact as the font — after the face
    // loads, or measureText reads fallback metrics. Per-element widths (each label differs), one undo step.
    const applyArrowFont = async (patch: { fontSize?: number; fontFamily?: string }) => {
        if (!arrowEls.length) return;
        await Promise.all(
            arrowEls.map((el) => loadVectorFont(patch.fontSize ?? el.fontSize, patch.fontFamily ?? el.fontFamily)),
        );
        const patches = arrowEls.map((el) => {
            const fontSize = patch.fontSize ?? el.fontSize;
            const fontFamily = patch.fontFamily ?? el.fontFamily;
            const { width } = measureVectorText(el.text, fontSize, fontFamily);
            return { id: el.id, fields: { ...patch, labelWidth: width } };
        });
        undoManager?.stopCapturing();
        updateElements(patches);
        undoManager?.stopCapturing();
    };

    const handleZOrderApply = (op: ZOp) => applyZOrder(op, elements, selectedIds, updateElements, undoManager);

    // Align / distribute / match-size over the shared arrange math. One transact, one undo step.
    // computeArrange no-ops below 2 (distribute below 3), so nothing to gate here.
    const handleAlign = (op: ArrangeOp) => {
        const patches = computeArrange(
            selectedElements.map((el) => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height })),
            op,
        );
        if (!patches.length) return;
        // A linear element's width/height goes through resizeLinearTo so its points scale with the box.
        undoManager?.stopCapturing();
        updateElements(
            patches.map((p) => {
                const el = byId.get(p.id);
                if (el && isLinearElement(el)) {
                    return { id: p.id, fields: resizeLinearTo(el, p) };
                }
                return { id: p.id, fields: { x: p.x, y: p.y, width: p.width, height: p.height } };
            }),
        );
        undoManager?.stopCapturing();
    };

    const tx = getMergedValue(selectedElements, (el) => Math.round(el.x));
    const ty = getMergedValue(selectedElements, (el) => Math.round(el.y));
    const tWidth = getMergedValue(selectedElements, (el) => Math.round(el.width));
    const tHeight = getMergedValue(selectedElements, (el) => Math.round(el.height));
    const tAngle = getMergedValue(selectedElements, (el) => Math.round(el.angle));

    const strokeColor = getMergedValue(selectedElements, (el) => el.strokeColor);
    const strokeWidth = getMergedValue(selectedElements, (el) => el.strokeWidth);
    const strokeStyle = getMergedValue(selectedElements, (el) => el.strokeStyle);
    const fill: MergedValue<string> = getMergedValue(selectedElements, fillColorOf);
    const fillStyle = getMergedValue(selectedElements, (el) =>
        ELEMENT_KINDS[el.type].capabilities.fillStyle && 'fillStyle' in el ? el.fillStyle : undefined,
    );
    const roughness = getMergedValue(selectedElements, (el) =>
        ELEMENT_KINDS[el.type].capabilities.roughness && 'roughness' in el ? el.roughness : undefined,
    );
    const corners = getMergedValue(selectedElements, (el) =>
        ELEMENT_KINDS[el.type].capabilities.corners && 'corners' in el ? el.corners : undefined,
    );
    const roundness = getMergedValue(selectedElements, (el) => ('roundness' in el ? el.roundness : undefined));
    const opacity = getMergedValue(selectedElements, (el) => el.opacity);
    const arrowShape = getMergedValue(arrowEls, (el) => arrowShapeOf(el));
    const startArrowhead = getMergedValue(arrowEls, (el) => el.startArrowhead);
    const endArrowhead = getMergedValue(arrowEls, (el) => el.endArrowhead);
    const arrowFontFamily = getMergedValue(arrowEls, (el) => el.fontFamily);
    const arrowFontSize = getMergedValue(arrowEls, (el) => el.fontSize);

    const title =
        selectedElements.length === 1 ? TYPE_LABELS[selectedElements[0].type] : `${selectedElements.length} elements`;

    // Sections follow the canonical order documented on PropertiesPanel — geometry, content, paint,
    // appearance, actions. Text and the shape paint sections never coexist (a selection is all-text
    // or all-shapes), so they read as one slot.
    return (
        <PropertiesPanel title={title}>
            <TransformSection
                x={tx}
                y={ty}
                width={tWidth}
                height={tHeight}
                angle={tAngle}
                onChange={applyTransform}
                // An elbow arrow's route lives in the unrotated local frame, so it pins angle 0 — the
                // Angle input is disabled for a pure-elbow selection (W/H stay editable).
                angleDisabled={allElbow}
                aspectLocked={aspectLocked}
                onAspectLockChange={onAspectLockChange}
            />

            {allArrowLabeled && (
                <PropertySection title="Text">
                    <PropertyRow label="Font">
                        <FontPicker
                            value={
                                isMixed(arrowFontFamily)
                                    ? DEFAULT_FONT_FAMILY
                                    : (arrowFontFamily ?? DEFAULT_FONT_FAMILY)
                            }
                            onChange={(f) => {
                                applyArrowFont({ fontFamily: f }).catch(() => {});
                            }}
                            className="h-7 w-full text-xs"
                        />
                    </PropertyRow>
                    <PropertyRow label="Size">
                        <MergedNumberInput
                            value={arrowFontSize}
                            onChange={(v) => {
                                applyArrowFont({ fontSize: v }).catch(() => {});
                            }}
                            min={8}
                            max={200}
                            step={1}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

            {allPaintable && (
                <>
                    {showFill && (
                        <PropertySection title="Fill">
                            <ColorRow
                                label="Color"
                                value={fill}
                                onChange={(c) => applyToAll({ fill: solidFill(c) })}
                                showReset
                            />
                            <PropertyRow label="Style">
                                <MergedSelect
                                    value={fillStyle}
                                    onChange={(v) => applyToAll({ fillStyle: v })}
                                    options={FILL_STYLE_OPTIONS}
                                />
                            </PropertyRow>
                        </PropertySection>
                    )}

                    <PropertySection title="Stroke">
                        <ColorRow label="Color" value={strokeColor} onChange={(c) => applyToAll({ strokeColor: c })} />
                        <PropertyRow label="Width">
                            <MergedSelect
                                value={numToStr(strokeWidth)}
                                onChange={(v) => applyToAll({ strokeWidth: Number(v) })}
                                options={STROKE_WIDTH_OPTIONS}
                            />
                        </PropertyRow>
                        {/* A freehand stroke is a filled outline, not a dashable line — hide Style. */}
                        {!anyFreedraw && (
                            <PropertyRow label="Style">
                                <MergedSelect
                                    value={strokeStyle}
                                    onChange={(v) => applyToAll({ strokeStyle: v })}
                                    options={STROKE_STYLE_OPTIONS}
                                />
                            </PropertyRow>
                        )}
                    </PropertySection>

                    <PropertySection title="Sketch">
                        <PropertyRow label="Rough">
                            <MergedSelect
                                value={numToStr(roughness)}
                                onChange={(v) => applyToAll({ roughness: Number(v) })}
                                options={ROUGHNESS_OPTIONS}
                            />
                        </PropertyRow>
                        {/* Arrows carry the 3-way Type row (sharp/curved/elbow); lines & shapes keep Edges. An
                            elbow reuses Edges as its CORNER style (sharp bends vs round arcs) — its shaft is
                            always orthogonal, so roundness is free to mean the corners. */}
                        {allArrow ? (
                            <>
                                <PropertyRow label="Type">
                                    <MergedSelect
                                        value={arrowShape}
                                        onChange={applyArrowShape}
                                        options={ARROW_SHAPE_OPTIONS}
                                    />
                                </PropertyRow>
                                {allElbow && (
                                    <PropertyRow label="Edges">
                                        <MergedSelect
                                            value={roundness}
                                            onChange={(v) => applyToAll({ roundness: v })}
                                            options={EDGES_OPTIONS}
                                        />
                                    </PropertyRow>
                                )}
                            </>
                        ) : (
                            allRoundable && (
                                <PropertyRow label="Edges">
                                    <MergedSelect
                                        value={roundness}
                                        onChange={(v) => applyToAll({ roundness: v })}
                                        options={EDGES_OPTIONS}
                                    />
                                </PropertyRow>
                            )
                        )}
                        {allCorners && (
                            <PropertyRow label="Corners">
                                <MergedSelect
                                    value={corners}
                                    onChange={(v) => applyToAll({ corners: v })}
                                    options={CORNERS_OPTIONS}
                                />
                            </PropertyRow>
                        )}
                    </PropertySection>
                </>
            )}

            {allArrow && (
                <PropertySection title="Arrowheads">
                    <PropertyRow label="Start">
                        <MergedSelect
                            value={startArrowhead}
                            onChange={(v) => applyToAll({ startArrowhead: v })}
                            options={ARROWHEAD_OPTIONS}
                        />
                    </PropertyRow>
                    <PropertyRow label="End">
                        <MergedSelect
                            value={endArrowhead}
                            onChange={(v) => applyToAll({ endArrowhead: v })}
                            options={ARROWHEAD_OPTIONS}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

            <PropertySection title="Appearance">
                <PropertyRow label="Opacity">
                    <MergedNumberInput
                        value={opacity}
                        onChange={(v) => applyToAll({ opacity: v })}
                        min={0}
                        max={100}
                        step={10}
                    />
                </PropertyRow>
            </PropertySection>

            <PropertySection title="Arrange">
                <ZOrderButtons onApply={handleZOrderApply} />
            </PropertySection>

            {selectedElements.length >= 2 && <AlignSection count={selectedElements.length} onApply={handleAlign} />}
        </PropertiesPanel>
    );
}
