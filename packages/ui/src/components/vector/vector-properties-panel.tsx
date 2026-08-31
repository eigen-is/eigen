// The right-side w-64 properties panel for the vector editor — mirrors how slides mounts
// SlidePropertiesPanel (non-empty selection + canWrite). It edits every selected element through
// the shared MIXED conventions: '—' in number inputs / color swatches / select placeholders and a
// data-mixed attribute on toggles. Each control change is one updateElements transact across the
// selection (one undo step, stopCapturing sealed on both sides). Field scoping follows §A: fill /
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
    computeArrange,
    DEFAULT_FONT_FAMILY,
    type FillStyle,
    isClosedPath,
    isLinearElement,
    isTransparent,
    normalizeLinear,
    parsePoints,
    type Roundness,
    redockBindingsForElbow,
    resizeLinear,
    STROKE_WIDTH_OPTIONS,
    type StrokeStyle,
    type VectorArrowElement,
    type VectorElement,
    type VectorElementType,
    type VectorLinearElement,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import {
    AlignmentPicker,
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
import type { VectorElementPatch } from './hooks/use-vector-doc';
import { applyZOrder } from './hooks/use-vector-keyboard';
import { loadVectorFont, measureVectorText } from './text-measure';

const TYPE_LABELS: Record<VectorElementType, string> = {
    rectangle: 'Rectangle',
    diamond: 'Diamond',
    ellipse: 'Ellipse',
    text: 'Text',
    image: 'Image',
    freedraw: 'Freehand',
    line: 'Line',
    arrow: 'Arrow',
};

// Discrete presets, the Excalidraw constants (SCOUT §6): strokeWidth 1/2/4 (STROKE_WIDTH_OPTIONS,
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
// The arrow-type row (UA4b) — derived from the canonical ARROW_SHAPES vocabulary so the two never drift.
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

// A width/height change on a linear element must rescale its points through resizeLinear (R2.6), not
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

type VectorPropertiesPanelProps = {
    // All elements — z-order reorders the selection relative to the rest (computeZOrder needs both).
    elements: VectorElement[];
    selectedElements: VectorElement[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    undoManager: Y.UndoManager | null;
    // Aspect lock (Override 3), owned by the editor so the panel checkbox and the canvas'
    // ObjectTransform resizeMode share one ephemeral setting.
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
};

export function VectorPropertiesPanel({
    elements,
    selectedElements,
    updateElements,
    undoManager,
    aspectLocked,
    onAspectLockChange,
}: VectorPropertiesPanelProps) {
    const selectedIds = selectedElements.map((el) => el.id);
    const byId = new Map(selectedElements.map((el) => [el.id, el]));
    const isShape = (t: VectorElementType) => t === 'rectangle' || t === 'diamond' || t === 'ellipse';
    const has = selectedElements.length > 0;
    const isClosedLinear = (el: VectorElement) => isLinearElement(el) && isClosedPath(parsePoints(el.points));
    // Paint sections (Stroke / Fill / Sketch) apply to shapes and linear elements; images/text opt out.
    const allPaintable = has && selectedElements.every((el) => isShape(el.type) || isLinearElement(el));
    // Fill only makes sense for shapes and CLOSED linear elements (an open stroke has nothing to fill).
    const showFill = has && selectedElements.every((el) => isShape(el.type) || isClosedLinear(el));
    // Stroke Style (dashed/dotted) is meaningless for a freehand stroke — hide it if any is selected.
    const anyFreedraw = selectedElements.some((el) => el.type === 'freedraw');
    // Edges (roundness) apply to rectangles/diamonds and lines/arrows (round curve vs sharp shaft),
    // never freedraw.
    const allEdged =
        has &&
        selectedElements.every(
            (el) => el.type === 'rectangle' || el.type === 'diamond' || el.type === 'line' || el.type === 'arrow',
        );
    const textEls = selectedElements.filter((el): el is VectorTextElement => el.type === 'text');
    const allText = has && textEls.length === selectedElements.length;
    // Arrowheads apply to arrows only (both ends selectable per selection).
    const arrowEls = selectedElements.filter((el): el is VectorArrowElement => el.type === 'arrow');
    const allArrow = has && arrowEls.length === selectedElements.length;
    // An elbow arrow pins angle 0 (its route lives in the unrotated local frame), so a pure-elbow
    // selection disables the panel Angle input.
    const allElbow = allArrow && arrowEls.every((el) => el.elbow);
    // A Text section (font + size only — the label is always centered, its colour comes from Stroke)
    // shows for arrows once every one carries a label (R3.12); an empty label has no font to tune.
    const allArrowLabeled = allArrow && arrowEls.every((el) => el.text !== '');

    // Same fields on every selected element — one transact, one undo step.
    const applyToAll = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        undoManager?.stopCapturing();
        updateElements(selectedIds.map((id) => ({ id, fields })));
        undoManager?.stopCapturing();
    };

    // The arrow-type row (UA4b). arrowShapeFields owns the stored fields each shape writes back. Switching
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
    // their points scale with the box (R2.6); x/y/angle-only changes pass straight through.
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

    // Font family / size changes MUST re-measure and store width/height (the server renderer trusts
    // stored dims) — and only after the resulting face is loaded, or measureText returns
    // fallback-font garbage. Per-element dims (each text differs) in the ONE transact as the font.
    const applyTextFont = async (patch: { fontSize?: number; fontFamily?: string }) => {
        if (!textEls.length) return;
        await Promise.all(
            textEls.map((el) => loadVectorFont(patch.fontSize ?? el.fontSize, patch.fontFamily ?? el.fontFamily)),
        );
        const patches = textEls.map((el) => {
            const fontSize = patch.fontSize ?? el.fontSize;
            const fontFamily = patch.fontFamily ?? el.fontFamily;
            const { width, height } = measureVectorText(el.text, fontSize, fontFamily);
            return { id: el.id, fields: { ...patch, width, height } };
        });
        undoManager?.stopCapturing();
        updateElements(patches);
        undoManager?.stopCapturing();
    };

    // The arrow-label mirror of applyTextFont (R3.6): a font family / size change re-measures each
    // arrow's own label and writes `labelWidth` (the sole width source, height derives from the line
    // count) in the SAME transact as the font — after the face loads, or measureText reads fallback
    // metrics. Per-element widths (each label differs) in one undo step.
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

    // Align / distribute / match-size over the shared arrange math (U7a). One transact, one undo step
    // (U6e seal). computeArrange no-ops below 2 (distribute below 3), so nothing to gate here.
    const handleAlign = (op: ArrangeOp) => {
        const patches = computeArrange(
            selectedElements.map((el) => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height })),
            op,
        );
        if (!patches.length) return;
        // Text dims are DERIVED from fontSize (the measurement util is the sole dim writer), so
        // match-size patches must never write width/height onto a text element; align/distribute
        // (x/y-only) still applies. A linear element's width/height goes through resizeLinearTo so its
        // points scale with the box (R2.6).
        undoManager?.stopCapturing();
        updateElements(
            patches.map((p) => {
                const el = byId.get(p.id);
                if (el && isLinearElement(el)) {
                    return { id: p.id, fields: resizeLinearTo(el, p) };
                }
                if (el?.type === 'text') return { id: p.id, fields: { x: p.x, y: p.y } };
                return { id: p.id, fields: { x: p.x, y: p.y, width: p.width, height: p.height } };
            }),
        );
        undoManager?.stopCapturing();
    };

    // Numeric transform (U4b) — x/y/angle write straight through applyToAll; width/height are
    // disabled for text (its dims are DERIVED from fontSize via the measurement util, the sole dim
    // writer), so applyToAll never receives them for a text selection.
    const tx = getMergedValue(selectedElements, (el) => Math.round(el.x));
    const ty = getMergedValue(selectedElements, (el) => Math.round(el.y));
    const tWidth = getMergedValue(selectedElements, (el) => Math.round(el.width));
    const tHeight = getMergedValue(selectedElements, (el) => Math.round(el.height));
    const tAngle = getMergedValue(selectedElements, (el) => Math.round(el.angle));

    const strokeColor = getMergedValue(selectedElements, (el) => el.strokeColor);
    const strokeWidth = getMergedValue(selectedElements, (el) => el.strokeWidth);
    const strokeStyle = getMergedValue(selectedElements, (el) => el.strokeStyle);
    const fillRaw = getMergedValue(selectedElements, (el) => el.backgroundColor);
    const fill: MergedValue<string> = isMixed(fillRaw) ? fillRaw : fillRaw && !isTransparent(fillRaw) ? fillRaw : '';
    const fillStyle = getMergedValue(selectedElements, (el) => el.fillStyle);
    const roughness = getMergedValue(selectedElements, (el) => el.roughness);
    const roundness = getMergedValue(selectedElements, (el) =>
        el.type === 'rectangle' || el.type === 'diamond' || el.type === 'line' || el.type === 'arrow'
            ? el.roundness
            : undefined,
    );
    const opacity = getMergedValue(selectedElements, (el) => el.opacity);
    const fontFamily = getMergedValue(textEls, (el) => el.fontFamily);
    const fontSize = getMergedValue(textEls, (el) => el.fontSize);
    const textAlign = getMergedValue(textEls, (el) => el.textAlign);
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
                // Text dims are derived — disable W/H (and, with them, the aspect checkbox); size
                // lives in fontSize. A linear element's W/H stay ENABLED — applyTransform routes them
                // through resizeLinear so its points scale with the box.
                // ANY text in the selection disables W/H: the write reaches every selected element,
                // and text dims are derived (measurement util is the sole writer).
                sizeDisabled={textEls.length > 0}
                // An elbow arrow's route lives in the unrotated local frame, so it pins angle 0 — the
                // Angle input is disabled for a pure-elbow selection (W/H stay editable).
                angleDisabled={allElbow}
                aspectLocked={aspectLocked}
                onAspectLockChange={onAspectLockChange}
            />

            {allText && (
                <PropertySection title="Text">
                    <ColorRow label="Color" value={strokeColor} onChange={(c) => applyToAll({ strokeColor: c })} />
                    <PropertyRow label="Font">
                        <FontPicker
                            value={isMixed(fontFamily) ? DEFAULT_FONT_FAMILY : (fontFamily ?? DEFAULT_FONT_FAMILY)}
                            onChange={(f) => {
                                applyTextFont({ fontFamily: f }).catch(() => {});
                            }}
                            className="h-7 w-full text-xs"
                        />
                    </PropertyRow>
                    <PropertyRow label="Size">
                        <MergedNumberInput
                            value={fontSize}
                            onChange={(v) => {
                                applyTextFont({ fontSize: v }).catch(() => {});
                            }}
                            min={8}
                            max={200}
                            step={1}
                        />
                    </PropertyRow>
                    <PropertyRow label="Align">
                        <AlignmentPicker
                            value={isMixed(textAlign) ? undefined : textAlign}
                            onChange={(a) => applyToAll({ textAlign: a })}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

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
                                onChange={(c) => applyToAll({ backgroundColor: c })}
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
                            allEdged && (
                                <PropertyRow label="Edges">
                                    <MergedSelect
                                        value={roundness}
                                        onChange={(v) => applyToAll({ roundness: v })}
                                        options={EDGES_OPTIONS}
                                    />
                                </PropertyRow>
                            )
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
