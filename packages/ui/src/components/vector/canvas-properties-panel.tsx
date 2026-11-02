// The canvas's properties panel, mounted whenever the user can edit: with nothing selected it edits the canvas
// background, otherwise every selected element at once, showing a mixed value as '—'. Each row gates on a capability,
// never on a type list, and a kind adds what no capability expresses through its own PanelSection. A control change is
// one undo step, and a control the user drags or types into holds one gesture open over the whole edit.

import { isInlineSketchCapped, readChartSpec } from '@workspace/lib/charts';
import type { Fill } from '@workspace/lib/types/background';
import type {
    ArrangeOp,
    Box,
    Corners,
    NewVectorElement,
    VectorArrowElement,
    VectorElement,
    VectorElementPatch,
    VectorLinearElement,
    ZOp,
} from '@workspace/lib/vector';
import {
    capabilitiesOf,
    computeArrange,
    EDGES_OPTIONS,
    isLinearElement,
    parseFill,
    resizeLinear,
    serializeFill,
} from '@workspace/lib/vector';
import {
    AlignSection,
    getMergedValue,
    holdCapture,
    MergedSelect,
    MergedSlider,
    PaintSections,
    PropertiesPanel,
    PropertyGestureContext,
    PropertyRow,
    PropertySection,
    sealed,
    TransformSection,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import type * as Y from 'yjs';
import { applyZOrder, convertElementToShapes } from './hooks/selection-ops';
import { ELEMENT_KIND_UI, elementLabel } from './kinds';
import { RichTextPanelSection } from './kinds/rich-text';

// The box kinds' corners. A shaft's curvature is a different question, so it has a row of its own.
const CORNERS_OPTIONS: { value: Corners; label: string }[] = [
    { value: 'straight', label: 'Straight' },
    { value: 'curved', label: 'Curved' },
    { value: 'round', label: 'Round' },
];

type CanvasPropertiesPanelProps = {
    // The elements the canvas shows. A z-order change moves the selection relative to the rest, so in frame mode this
    // is that frame's elements, not the whole scene.
    elements: VectorElement[];
    selectedElements: VectorElement[];
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    reorderElements: (ids: string[], selectedIds: string[], op: ZOp) => void;
    // A kind section's Convert to shapes: the doc's replace, and the selection the new elements take.
    replaceElement: (id: string, partials: NewVectorElement[]) => string[];
    setSelectedIds: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    // The panel's title with nothing selected. Without one it is Canvas.
    emptyTitle?: string;
    // What the panel shows with nothing selected: the host's own rows about its surface, which the engine has no words
    // for, such as a drawing's background color.
    emptySection?: ReactNode;
    // The aspect lock. The editor owns it, so the panel's checkbox and the canvas's resize grips share one setting.
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
    // The deck's physical width in pt, so its text sizes read in pt. A drawing passes none and reads px.
    slideWidth?: number;
};

export function CanvasPropertiesPanel({
    elements,
    selectedElements,
    updateElements,
    reorderElements,
    replaceElement,
    setSelectedIds,
    undoManager,
    emptyTitle,
    emptySection,
    aspectLocked,
    onAspectLockChange,
    slideWidth,
}: CanvasPropertiesPanelProps) {
    const selectedIds = selectedElements.map((el) => el.id);
    const byId = new Map(selectedElements.map((el) => [el.id, el]));
    // Every element in scope, for a kind section that must resolve one the selection does not hold, such as an arrow's
    // bound shape when its route docks again.
    const sceneById = new Map(elements.map((el) => [el.id, el]));
    const has = selectedElements.length > 0;
    const all = (pick: (el: VectorElement) => boolean) => has && selectedElements.every(pick);
    // Every row asks capabilitiesOf of each element, never a table per kind, because an open freehand stroke paints no
    // fill and so offers none.
    const showFill = all((el) => capabilitiesOf(el).fill);
    // A border can be switched off only where the element still has a body without it. A line or an arrow is its
    // stroke, so its color row offers no None swatch.
    const strokeOptional = all((el) => capabilitiesOf(el).strokeOptional);
    // The hatch row sits inside the Fill block, because it is the other half of the same stored fill. It shows only
    // for the kinds that draw a hatch.
    const showFillStyle = showFill && all((el) => capabilitiesOf(el).fillStyle);
    const showCorners = all((el) => capabilitiesOf(el).corners);
    // A selection of one kind shows that kind's rows too, and a mixed selection only the generic ones.
    const soleKind =
        has && selectedElements.every((el) => el.type === selectedElements[0].type) ? selectedElements[0].type : null;
    // The Text and Spacing rows serve every element that holds text, so a rectangle and a text box share them.
    const showText = all((el) => capabilitiesOf(el).text);
    const KindSection = soleKind ? ELEMENT_KIND_UI[soleKind].PanelSection : undefined;
    // A dashed or dotted style means nothing for a freehand stroke, which is a filled outline rather than a drawn
    // line. The capability says so.
    const showStrokeStyle = all((el) => capabilitiesOf(el).strokeStyle);
    // An elbow arrow's route lives in its unturned frame, so its angle stays 0. A selection of only elbow arrows
    // disables the Angle input, while its width and height stay editable.
    const allElbow = all((el) => el.type === 'arrow' && el.elbow);
    // The Edges row is a shaft's curvature, a round curve or a sharp polyline, which the `edges` capability answers. A
    // freehand stroke stores a roundness but offers none. A selection of only arrows asks it in the arrow's own section
    // instead, where it is the elbow's corner style.
    const showEdges = soleKind !== 'arrow' && all((el) => capabilitiesOf(el).edges);
    const showShape = showCorners || showEdges;

    // The same fields on every selected element, in one undo step.
    const applyToAll = (fields: VectorElementPatch) => {
        if (!has) return;
        sealed(undoManager, () => updateElements(selectedIds.map((id) => ({ id, fields }))));
    };

    // A control that writes as the user goes takes this hold, and `sealed` stands down inside it. So an opacity drag and
    // a typed number are each one undo step, not one per frame or per digit.
    const beginGesture = useCallback(() => holdCapture(undoManager), [undoManager]);

    // A patch computed per element, for the writes one patch for all cannot express, such as a font size one step up
    // from each element's own. Still one undo step.
    const applyToEach = (patch: (el: VectorElement) => VectorElementPatch) => {
        if (!has) return;
        sealed(undoManager, () => updateElements(selectedElements.map((el) => ({ id: el.id, fields: patch(el) }))));
    };

    const applyReplace = (partials: NewVectorElement[]) => {
        if (selectedElements.length !== 1) return;
        convertElementToShapes(selectedElements[0].id, partials, replaceElement, setSelectedIds, undoManager);
    };

    // The Transform rows. A width or height change goes through resizeLinearTo for a linear element, so its points
    // scale with the box.
    const applyTransform = (fields: VectorElementPatch) => {
        if (!has) return;
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

    // The two halves of the stored fill are edited apart, so each write keeps the other half of each element's fill.
    // Painting a selection with mixed hatches must not give them all one hatch. One undo step.
    const applyFill = (next: (fill: Fill) => Fill) => {
        if (!has) return;
        sealed(undoManager, () =>
            updateElements(
                selectedElements
                    .filter((el) => 'fill' in el)
                    .map((el) => ({ id: el.id, fields: { fill: serializeFill(next(parseFill(el.fill))) } })),
            ),
        );
    };

    const handleZOrderApply = (op: ZOp) => applyZOrder(op, elements, selectedIds, reorderElements, undoManager);

    // Align, distribute and match size, in one undo step. computeArrange returns nothing for a selection too small to
    // arrange, so nothing is gated here.
    const handleAlign = (op: ArrangeOp) => {
        const patches = computeArrange(
            selectedElements.map((el) => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height })),
            op,
        );
        if (!patches.length) return;
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

    // The fill merges as the stored string and is parsed once, so a gradient survives the merge whole.
    const fill = getMergedValue(selectedElements, (el) => ('fill' in el ? el.fill : undefined));
    const fillStyle = getMergedValue(selectedElements, (el) => ('fill' in el ? parseFill(el.fill).style : undefined));
    // A chart's own fields: its labels' color, and whether its data draws past the sketch.
    const charts = soleKind === 'chart' ? selectedElements.filter((el) => el.type === 'chart') : [];
    const sketchCapped = charts.some((el) => {
        const { spec } = readChartSpec(el);
        return spec !== null && isInlineSketchCapped(spec);
    });
    const corners = getMergedValue(selectedElements, (el) => ('corners' in el ? el.corners : undefined));
    const roundness = getMergedValue(selectedElements, (el) => ('roundness' in el ? el.roundness : undefined));
    const opacity = getMergedValue(selectedElements, (el) => el.opacity);

    // The element's own label, from the registry, where a text box is Text, so the panel and the toolbar agree.
    const title = !has
        ? (emptyTitle ?? 'Canvas')
        : selectedElements.length === 1
          ? elementLabel(selectedElements[0])
          : `${selectedElements.length} elements`;

    // The sections follow PropertiesPanel's order: geometry, content, paint, appearance, actions.
    return (
        <PropertyGestureContext.Provider value={beginGesture}>
            <PropertiesPanel title={title}>
                {has && (
                    <TransformSection
                        x={tx}
                        y={ty}
                        width={tWidth}
                        height={tHeight}
                        angle={tAngle}
                        onChange={applyTransform}
                        angleDisabled={allElbow}
                        aspectLocked={aspectLocked}
                        onAspectLockChange={onAspectLockChange}
                    />
                )}

                {showText && (
                    <RichTextPanelSection
                        elements={selectedElements}
                        scene={sceneById}
                        slideWidth={slideWidth}
                        onChange={applyToAll}
                        onChangeEach={applyToEach}
                        onReplace={applyReplace}
                    />
                )}

                {KindSection && (
                    <KindSection
                        elements={selectedElements}
                        scene={sceneById}
                        slideWidth={slideWidth}
                        onChange={applyToAll}
                        onChangeEach={applyToEach}
                        onReplace={applyReplace}
                    />
                )}

                {has && (
                    <PaintSections
                        fill={showFill ? fill : undefined}
                        fillStyle={showFillStyle ? fillStyle : undefined}
                        marksHatch={soleKind === 'chart'}
                        strokeColor={getMergedValue(selectedElements, (el) => el.strokeColor)}
                        strokeWidth={getMergedValue(selectedElements, (el) => el.strokeWidth)}
                        strokeStyle={
                            showStrokeStyle ? getMergedValue(selectedElements, (el) => el.strokeStyle) : undefined
                        }
                        strokeOptional={strokeOptional}
                        roughness={getMergedValue(selectedElements, (el) => el.roughness)}
                        color={charts.length ? getMergedValue(charts, (el) => el.color) : undefined}
                        sketchCapped={sketchCapped}
                        onFill={applyFill}
                        onChange={applyToAll}
                    >
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
                    </PaintSections>
                )}

                {has && (
                    <PropertySection title="Appearance">
                        <PropertyRow label="Opacity">
                            <MergedSlider
                                aria-label="Opacity"
                                value={opacity}
                                onChange={(v) => applyToAll({ opacity: v })}
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
        </PropertyGestureContext.Provider>
    );
}

// A width or height change on a linear element rescales its points through resizeLinear rather than overwriting the
// box. Each field the patch leaves out comes from the element, so a change of position or angle alone passes through.
function resizeLinearTo(el: VectorLinearElement | VectorArrowElement, patch: Partial<Box>) {
    return resizeLinear(el, {
        x: patch.x ?? el.x,
        y: patch.y ?? el.y,
        width: patch.width ?? el.width,
        height: patch.height ?? el.height,
        angle: patch.angle ?? el.angle,
    });
}
