// The right-side w-64 properties panel for the canvas engine. It is mounted whenever the user can edit
// — with nothing selected it edits the canvas itself (the background row). It edits every selected
// element through the shared MIXED conventions: '—' in number inputs / color swatches / select
// placeholders and a data-mixed attribute on toggles. Each discrete control change is one updateElements
// transact across the selection (one undo step, `sealed` on both sides); the one continuous
// control, the Opacity slider, writes live inside a holdCapture gesture so one drag is one undo step.
//
// Every row gates on a CAPABILITY, never on a type list: `fill` opens the Fill block, `strokeStyle` its
// dash row, `roughness` the Sketch section, `corners` the Shape section. The Stroke section itself needs
// no gate — every kind paints one. What a capability cannot express — rich text's typography, the
// image's fit — comes from the kind's own PanelSection in ELEMENT_KIND_UI.

import type { Fill, FillPaint } from '@workspace/lib/types/background';
import {
    type ArrangeOp,
    type Box,
    type Corners,
    capabilitiesOf,
    computeArrange,
    EDGES_OPTIONS,
    type FillStyle,
    isLinearElement,
    isTransparentFill,
    parseFill,
    resizeLinear,
    STROKE_WIDTH_OPTIONS,
    type StrokeStyle,
    serializeFill,
    TRANSPARENT_FILL,
    type VectorArrowElement,
    type VectorElement,
    type VectorLinearElement,
} from '@workspace/lib/vector';
import {
    AlignSection,
    BackgroundFillBlock,
    ColorRow,
    getMergedValue,
    isMixed,
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

// Discrete presets, the Excalidraw constants: strokeWidth 1/2/4 (STROKE_WIDTH_OPTIONS,
// shared from lib), roughness 0/1/2.
const ROUGHNESS_OPTIONS: { value: string; label: string }[] = [
    { value: '0', label: 'Architect' },
    { value: '1', label: 'Artist' },
    { value: '2', label: 'Cartoonist' },
];
// The box kinds' corner treatment — a different question from a shaft's curvature, hence its own row.
const CORNERS_OPTIONS: { value: Corners; label: string }[] = [
    { value: 'straight', label: 'Straight' },
    { value: 'curved', label: 'Curved' },
    { value: 'round', label: 'Round' },
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
    // Panel title with nothing selected; defaults to the canvas.
    emptyTitle?: string;
    // What the panel shows with nothing selected — the host's own question about the surface, which
    // the engine has no words for: the drawing canvas' background colour, the deck's slide background
    // with its apply-to scope.
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
    emptyTitle,
    emptySection,
    aspectLocked,
    onAspectLockChange,
}: CanvasPropertiesPanelProps) {
    const selectedIds = selectedElements.map((el) => el.id);
    const byId = new Map(selectedElements.map((el) => [el.id, el]));
    // Every element in scope, for a kind section that must resolve one the selection does not hold (an
    // arrow's bound shape, when its route is re-docked).
    const sceneById = new Map(elements.map((el) => [el.id, el]));
    const has = selectedElements.length > 0;
    const all = (pick: (el: VectorElement) => boolean) => has && selectedElements.every(pick);
    // Every row gates on capabilitiesOf(el) — per ELEMENT, never off the kind's static table, because an
    // open freedraw paints no fill and so offers none.
    const showFill = all((el) => capabilitiesOf(el).fill);
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
    // Stroke Style (dashed/dotted) is meaningless for a freehand stroke: it is a filled outline, not a
    // drawn line, and the capability is what says so.
    const showStrokeStyle = all((el) => capabilitiesOf(el).strokeStyle);
    // An elbow arrow pins angle 0 (its route lives in the unrotated local frame), so a pure-elbow
    // selection disables the panel Angle input; the arrow's own rows live in its kind section.
    const allElbow = all((el) => el.type === 'arrow' && el.elbow);
    // The Edges row is a shaft's curvature (round curve vs sharp polyline) — a line's or an arrow's,
    // never freedraw's. An all-arrow selection asks it in the arrow's own section instead, where it is
    // the elbow's corner style and shows only for an elbow.
    const showEdges = soleKind !== 'arrow' && all((el) => el.type === 'line' || el.type === 'arrow');
    const showShape = showCorners || showEdges;

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

    // A patch computed PER element — a kind section's seam for the writes one uniform patch cannot
    // express (an arrow's re-docked elbow route, a label's re-measured width). Still one undo step.
    const applyToEach = (patch: (el: VectorElement) => VectorElementPatch) => {
        if (!selectedElements.length) return;
        sealed(undoManager, () => updateElements(selectedElements.map((el) => ({ id: el.id, fields: patch(el) }))));
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

            {KindSection && (
                <KindSection
                    elements={selectedElements}
                    scene={sceneById}
                    onChange={applyToAll}
                    onChangeEach={applyToEach}
                />
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

            {has && (
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
                    {showStrokeStyle && (
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

            {!has && emptySection}

            {has && (
                <PropertySection title="Arrange">
                    <ZOrderButtons onApply={handleZOrderApply} />
                </PropertySection>
            )}

            {selectedElements.length >= 2 && <AlignSection count={selectedElements.length} onApply={handleAlign} />}
        </PropertiesPanel>
    );
}
