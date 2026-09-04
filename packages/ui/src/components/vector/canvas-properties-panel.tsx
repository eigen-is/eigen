// The right-side w-64 properties panel for the canvas engine. It is mounted whenever the user can edit
// — with nothing selected it edits the canvas itself (the background row). It edits every selected
// element through the shared MIXED conventions: '—' in number inputs / color swatches / select
// placeholders and a data-mixed attribute on toggles. Each discrete control change is one updateElements
// transact across the selection (one undo step, `sealed` on both sides); the one continuous
// control, the Opacity slider, writes live inside a holdCapture gesture so one drag is one undo step.
//
// Every row gates on a CAPABILITY, never on a type list: `fill` opens the Fill block, `stroke` the Stroke
// section, `roughness` the Sketch section, `corners` the Shape section. What a capability cannot express
// — rich text's typography, the image's fit — comes from the kind's own PanelSection in ELEMENT_KIND_UI.

import type { Fill, FillPaint } from '@workspace/lib/types/background';
import {
    ARROW_SHAPES,
    type ArrangeOp,
    type Arrowhead,
    type ArrowShape,
    arrowShapeFields,
    arrowShapeOf,
    type Box,
    type Corners,
    capabilitiesOf,
    computeArrange,
    type FillStyle,
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
    serializeFill,
    TRANSPARENT_FILL,
    type VectorArrowElement,
    type VectorElement,
    type VectorLinearElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import {
    AlignSection,
    BackgroundFillBlock,
    ColorRow,
    FontRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    MergedSelect,
    MergedSlider,
    type MergedValue,
    numToStr,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    TransformSection,
    type ZOp,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import type { ReactNode } from 'react';
import type * as Y from 'yjs';
import { applyZOrder } from './hooks/selection-ops';
import { holdCapture, sealed, type VectorElementPatch } from './hooks/use-canvas-doc';
import { ELEMENT_KIND_UI } from './kinds';
import { loadVectorFont, measureVectorText } from './text-measure';

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
    // The elements the canvas shows — z-order reorders the selection relative to the rest
    // (computeZOrder needs both), so in frame mode this is that frame's elements, not the whole scene.
    elements: VectorElement[];
    selectedElements: VectorElement[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    undoManager: Y.UndoManager | null;
    // The scene's own settings, edited with nothing selected. In frame mode the scene background row
    // is not the question a user is asking — the FRAME's background is — so a host in frame mode
    // supplies its own section instead (the deck's SlideBackgroundPanel, whose apply-to scope speaks
    // deck words the engine must not).
    meta: VectorMeta;
    updateMeta: (fields: Partial<VectorMeta>) => void;
    viewport: 'infinite' | 'frame';
    // Panel title with nothing selected; defaults to the canvas.
    emptyTitle?: string;
    // Rendered instead of the canvas rows with nothing selected.
    emptySection?: ReactNode;
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
    meta,
    updateMeta,
    viewport,
    emptyTitle,
    emptySection,
    aspectLocked,
    onAspectLockChange,
}: CanvasPropertiesPanelProps) {
    const selectedIds = selectedElements.map((el) => el.id);
    const byId = new Map(selectedElements.map((el) => [el.id, el]));
    const has = selectedElements.length > 0;
    const all = (pick: (el: VectorElement) => boolean) => has && selectedElements.every(pick);
    // Every row gates on capabilitiesOf(el) — per ELEMENT, never off the kind's static table, because an
    // open freedraw paints no fill and so offers none.
    const showFill = all((el) => capabilitiesOf(el).fill);
    const showStroke = all((el) => capabilitiesOf(el).stroke);
    // A border can be switched off only where the element still has a body without it; a line or an
    // arrow IS its stroke, so its colour row offers no None swatch.
    const strokeOptional = all((el) => capabilitiesOf(el).strokeOptional);
    // The hatch row sits INSIDE the Fill block — it is the other half of the same stored fill — and shows
    // only for the kinds whose renderer honours it.
    const showFillStyle = showFill && all((el) => capabilitiesOf(el).fillStyle);
    const showSketch = all((el) => capabilitiesOf(el).roughness);
    // Corners follow the kind's own capability; the separate Edges row is the shaft curvature a line or
    // an arrow carries (round curve vs sharp polyline), never freedraw.
    const showCorners = all((el) => capabilitiesOf(el).corners);
    // One kind selected ⇒ its own rows; a mixed selection shows only the generic ones.
    const soleKind =
        has && selectedElements.every((el) => el.type === selectedElements[0].type) ? selectedElements[0].type : null;
    const KindSection = soleKind ? ELEMENT_KIND_UI[soleKind].PanelSection : undefined;
    // Stroke Style (dashed/dotted) is meaningless for a freehand stroke — hide it if any is selected.
    const anyFreedraw = selectedElements.some((el) => el.type === 'freedraw');
    const allRoundable = all((el) => el.type === 'line' || el.type === 'arrow');
    // Arrowheads apply to arrows only (both ends selectable per selection).
    const arrowEls = selectedElements.filter((el): el is VectorArrowElement => el.type === 'arrow');
    const allArrow = has && arrowEls.length === selectedElements.length;
    // An elbow arrow pins angle 0 (its route lives in the unrotated local frame), so a pure-elbow
    // selection disables the panel Angle input.
    const allElbow = allArrow && arrowEls.every((el) => el.elbow);
    // The Shape section: a box's Corners, an arrow's Type, and the Edges row for a line or an elbow arrow
    // (a sharp/curved arrow's Type already answers its curvature).
    const showEdges = allArrow ? allElbow : allRoundable;
    const showShape = showCorners || allArrow || showEdges;
    // A Text section (font + size only — the label is always centered, its colour comes from Stroke)
    // shows for arrows once every one carries a label; an empty label has no font to tune.
    const allArrowLabeled = allArrow && arrowEls.every((el) => el.text !== '');

    // Same fields on every selected element — one transact, one undo step.
    const applyToAll = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        sealed(undoManager, () => updateElements(selectedIds.map((id) => ({ id, fields }))));
    };

    // The same write UNSEALED, for a continuous control: MergedSlider seals at both ends of a drag itself,
    // so the moves in between coalesce into one undo step instead of one per pixel.
    const applyToAllLive = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        updateElements(selectedIds.map((id) => ({ id, fields })));
    };

    // One drag = one undo step: holdCapture opens the window, MergedSlider releases it on commit.
    const beginOpacityGesture = () => holdCapture(undoManager);

    // The arrow-type row. arrowShapeFields owns the stored fields each shape writes back. Switching
    // TO elbow first collapses the arrow to its two endpoints — an elbow route is DERIVED from them, so
    // interior vertices would only linger as stray endpoint handles — and pins angle 0, all in the one
    // sealed transact. Switching AWAY keeps the two endpoints (nothing to restore). One undo step.
    const applyArrowShape = (shape: ArrowShape) => {
        if (!arrowEls.length) return;
        const base = arrowShapeFields(shape);
        const allById = new Map(elements.map((el) => [el.id, el]));
        sealed(undoManager, () =>
            updateElements(
                arrowEls.map((el) => {
                    if (shape !== 'elbow') return { id: el.id, fields: base };
                    const pts = parsePoints(el.points);
                    const collapsed = pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : pts;
                    // A bound end's fixedPoint was stored for the straight read; re-dock it for the elbow read
                    // so the endpoint sits on the outline, not inside the shape. followBindings re-glues after.
                    const redocked = redockBindingsForElbow(el, allById);
                    return {
                        id: el.id,
                        fields: { ...base, ...redocked, angle: 0, ...normalizeLinear({ ...el, angle: 0 }, collapsed) },
                    };
                }),
            ),
        );
    };

    // Numeric transform writes. A width/height change routes linear elements through resizeLinearTo so
    // their points scale with the box; x/y/angle-only changes pass straight through.
    const applyTransform = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        const resizesLinear = fields.width !== undefined || fields.height !== undefined;
        sealed(undoManager, () =>
            updateElements(
                selectedIds.map((id) => {
                    const el = byId.get(id);
                    if (resizesLinear && el && isLinearElement(el)) {
                        return { id, fields: { ...fields, ...resizeLinearTo(el, fields) } };
                    }
                    return { id, fields };
                }),
            ),
        );
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
        sealed(undoManager, () => updateElements(patches));
    };

    // The two halves of the stored fill are edited separately, so each write preserves the other ON EACH
    // ELEMENT: re-painting a mixed-hatch selection must not collapse it to one hatch. One undo step.
    const applyFill = (next: (fill: Fill) => Fill) => {
        if (!selectedIds.length) return;
        sealed(undoManager, () =>
            updateElements(
                selectedElements
                    .filter((el) => 'fill' in el)
                    .map((el) => ({ id: el.id, fields: { fill: serializeFill(next(parseFill(el.fill))) } })),
            ),
        );
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
        sealed(undoManager, () =>
            updateElements(
                patches.map((p) => {
                    const el = byId.get(p.id);
                    if (el && isLinearElement(el)) {
                        return { id: p.id, fields: resizeLinearTo(el, p) };
                    }
                    return { id: p.id, fields: { x: p.x, y: p.y, width: p.width, height: p.height } };
                }),
            ),
        );
    };

    const tx = getMergedValue(selectedElements, (el) => Math.round(el.x));
    const ty = getMergedValue(selectedElements, (el) => Math.round(el.y));
    const tWidth = getMergedValue(selectedElements, (el) => Math.round(el.width));
    const tHeight = getMergedValue(selectedElements, (el) => Math.round(el.height));
    const tAngle = getMergedValue(selectedElements, (el) => Math.round(el.angle));

    const strokeColor = getMergedValue(selectedElements, (el) => el.strokeColor);
    const strokeWidth = getMergedValue(selectedElements, (el) => el.strokeWidth);
    const strokeStyle = getMergedValue(selectedElements, (el) => el.strokeStyle);
    // The fill merges as the STORED string and is parsed once, so a gradient survives the merge intact.
    const fillRaw: MergedValue<string> = getMergedValue(selectedElements, (el) => ('fill' in el ? el.fill : undefined));
    // A transparent solid is "no fill", which is BackgroundFillBlock's `null` — one vocabulary.
    const parsedFill = typeof fillRaw === 'string' ? parseFill(fillRaw) : null;
    const fillValue = parsedFill && !isTransparentFill(parsedFill) ? parsedFill : null;
    const fillStyle = getMergedValue(selectedElements, (el) => ('fill' in el ? parseFill(el.fill).style : undefined));
    const roughness = getMergedValue(selectedElements, (el) => ('roughness' in el ? el.roughness : undefined));
    const corners = getMergedValue(selectedElements, (el) => ('corners' in el ? el.corners : undefined));
    const roundness = getMergedValue(selectedElements, (el) => ('roundness' in el ? el.roundness : undefined));
    const opacity = getMergedValue(selectedElements, (el) => el.opacity);
    const arrowShape = getMergedValue(arrowEls, (el) => arrowShapeOf(el));
    const startArrowhead = getMergedValue(arrowEls, (el) => el.startArrowhead);
    const endArrowhead = getMergedValue(arrowEls, (el) => el.endArrowhead);
    const arrowFontFamily = getMergedValue(arrowEls, (el) => el.fontFamily);
    const arrowFontSize = getMergedValue(arrowEls, (el) => el.fontSize);

    // The kind's own label, from the registry — a second table here would drift from the toolbar's.
    const title = !has
        ? (emptyTitle ?? 'Canvas')
        : selectedElements.length === 1
          ? ELEMENT_KIND_UI[selectedElements[0].type].label
          : `${selectedElements.length} elements`;

    // Sections follow the canonical order documented on PropertiesPanel — geometry, content, paint,
    // appearance, actions.
    return (
        <PropertiesPanel title={title}>
            {has && (
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
            )}

            {KindSection && <KindSection elements={selectedElements} onChange={applyToAll} />}

            {allArrowLabeled && (
                <PropertySection title="Text">
                    <FontRow
                        value={arrowFontFamily}
                        onChange={(f) => {
                            applyArrowFont({ fontFamily: f }).catch(() => {});
                        }}
                    />
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

            {showFill && (
                /* BackgroundFillBlock IS the section: the paint (solid or two-stop linear gradient) plus,
                   for the kinds roughjs hatches, the hatch style — both halves of the one stored fill. */
                <BackgroundFillBlock
                    title="Fill"
                    value={fillValue}
                    mixed={isMixed(fillRaw)}
                    onChange={(next) => {
                        const paint: FillPaint = next === null || next.type === 'image' ? TRANSPARENT_FILL : next;
                        applyFill((fill) => ({ ...paint, style: fill.style }));
                    }}
                    allowedTypes={['solid', 'gradient']}
                >
                    {showFillStyle && (
                        <PropertyRow label="Style">
                            <MergedSelect
                                value={fillStyle}
                                onChange={(v) => applyFill((fill) => ({ ...fill, style: v }))}
                                options={FILL_STYLE_OPTIONS}
                            />
                        </PropertyRow>
                    )}
                </BackgroundFillBlock>
            )}

            {showStroke && (
                <PropertySection title="Stroke">
                    <ColorRow
                        label="Color"
                        value={strokeColor}
                        onChange={(c) => applyToAll({ strokeColor: c })}
                        allowNone={strokeOptional}
                    />
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
            )}

            {showShape && (
                <PropertySection title="Shape">
                    {showCorners && (
                        <PropertyRow label="Corners">
                            <MergedSelect
                                value={corners}
                                onChange={(v) => applyToAll({ corners: v })}
                                options={CORNERS_OPTIONS}
                            />
                        </PropertyRow>
                    )}
                    {/* Arrows carry the 3-way Type row (sharp/curved/elbow); lines keep Edges. An elbow
                        reuses Edges as its CORNER style (sharp bends vs round arcs) — its shaft is always
                        orthogonal, so roundness is free to mean the corners. */}
                    {allArrow && (
                        <PropertyRow label="Type">
                            <MergedSelect value={arrowShape} onChange={applyArrowShape} options={ARROW_SHAPE_OPTIONS} />
                        </PropertyRow>
                    )}
                    {showEdges && (
                        <PropertyRow label="Edges">
                            <MergedSelect
                                value={roundness}
                                onChange={(v) => applyToAll({ roundness: v })}
                                options={EDGES_OPTIONS}
                            />
                        </PropertyRow>
                    )}
                </PropertySection>
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

            {showSketch && (
                <PropertySection title="Sketch">
                    <PropertyRow label="Style">
                        <MergedSelect
                            value={numToStr(roughness)}
                            onChange={(v) => applyToAll({ roughness: Number(v) })}
                            options={ROUGHNESS_OPTIONS}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

            {has && (
                <PropertySection title="Appearance">
                    <PropertyRow label="Opacity">
                        <MergedSlider
                            aria-label="Opacity"
                            value={opacity}
                            onChange={(v) => applyToAllLive({ opacity: v })}
                            beginGesture={beginOpacityGesture}
                            min={0}
                            max={100}
                            step={1}
                        />
                    </PropertyRow>
                </PropertySection>
            )}

            {!has &&
                (emptySection ??
                    (viewport === 'infinite' && (
                        <PropertySection title="Background">
                            {/* The scene background is a plain colour (meta.background), not a Fill — a
                                frame's background is a Fill and its panel is the host's. Transparent is
                                its default and a rendered state, so None is the way back from a colour. */}
                            <ColorRow
                                label="Color"
                                value={meta.background}
                                onChange={(c) => updateMeta({ background: c })}
                                allowNone
                            />
                        </PropertySection>
                    )))}

            {has && (
                <PropertySection title="Arrange">
                    <ZOrderButtons onApply={handleZOrderApply} />
                </PropertySection>
            )}

            {selectedElements.length >= 2 && <AlignSection count={selectedElements.length} onApply={handleAlign} />}
        </PropertiesPanel>
    );
}
