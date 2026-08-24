// The right-side w-64 properties panel for the vector editor — mirrors how slides mounts
// SlidePropertiesPanel (non-empty selection + canWrite). It edits every selected element through
// the shared MIXED conventions: '—' in number inputs / color swatches / select placeholders and a
// data-mixed attribute on toggles. Each control change is one updateElements transact across the
// selection (one undo step, stopCapturing sealed on both sides). Field scoping follows §A: fill /
// fill style / sketch are shapes-only, edges rect+diamond-only, font controls text-only, and
// strokeColor doubles as the text color.

import {
    DEFAULT_FONT_FAMILY,
    type FillStyle,
    isTransparent,
    type Roundness,
    type StrokeStyle,
    type VectorElement,
    type VectorElementType,
    type VectorTextElement,
} from '@workspace/lib/vector';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import {
    AlignmentPicker,
    ColorRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    MergedSelect,
    type MergedValue,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    type TransformFields,
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
};

// Discrete presets, the Excalidraw constants (SCOUT §6): strokeWidth 1/2/4, roughness 0/1/2.
const STROKE_WIDTH_OPTIONS: { value: string; label: string }[] = [
    { value: '1', label: 'Thin' },
    { value: '2', label: 'Medium' },
    { value: '4', label: 'Bold' },
];
const ROUGHNESS_OPTIONS: { value: string; label: string }[] = [
    { value: '0', label: 'Architect' },
    { value: '1', label: 'Artist' },
    { value: '2', label: 'Cartoonist' },
];
const EDGES_OPTIONS: { value: Roundness; label: string }[] = [
    { value: 'sharp', label: 'Sharp' },
    { value: 'round', label: 'Rounded' },
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
];

const numToStr = (v: MergedValue<number>): MergedValue<string> =>
    isMixed(v) ? v : v === undefined ? undefined : String(v);

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
    const isShape = (t: VectorElementType) => t === 'rectangle' || t === 'diamond' || t === 'ellipse';
    const allShapes = selectedElements.length > 0 && selectedElements.every((el) => isShape(el.type));
    const allRectDiamond =
        selectedElements.length > 0 && selectedElements.every((el) => el.type === 'rectangle' || el.type === 'diamond');
    const textEls = selectedElements.filter((el): el is VectorTextElement => el.type === 'text');
    const allText = selectedElements.length > 0 && textEls.length === selectedElements.length;

    // Same fields on every selected element — one transact, one undo step.
    const applyToAll = (fields: VectorElementPatch) => {
        if (!selectedIds.length) return;
        undoManager?.stopCapturing();
        updateElements(selectedIds.map((id) => ({ id, fields })));
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

    const handleZOrderApply = (op: ZOp) => applyZOrder(op, elements, selectedIds, updateElements, undoManager);

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
        el.type === 'rectangle' || el.type === 'diamond' ? el.roundness : undefined,
    );
    const opacity = getMergedValue(selectedElements, (el) => el.opacity);
    const fontFamily = getMergedValue(textEls, (el) => el.fontFamily);
    const fontSize = getMergedValue(textEls, (el) => el.fontSize);
    const textAlign = getMergedValue(textEls, (el) => el.textAlign);

    const title =
        selectedElements.length === 1 ? TYPE_LABELS[selectedElements[0].type] : `${selectedElements.length} elements`;

    return (
        <PropertiesPanel title={title}>
            <TransformSection
                x={tx}
                y={ty}
                width={tWidth}
                height={tHeight}
                angle={tAngle}
                onChange={(fields: TransformFields) => applyToAll(fields)}
                // Text dims are derived — disable W/H (and, with them, the aspect checkbox); size
                // lives in fontSize.
                // ANY text in the selection disables W/H: applyToAll writes every field to every
                // selected element, and text dims are derived (measurement util is the sole writer).
                sizeDisabled={textEls.length > 0}
                aspectLocked={aspectLocked}
                onAspectLockChange={onAspectLockChange}
            />

            {allShapes && (
                <>
                    <PropertySection title="Stroke">
                        <ColorRow label="Color" value={strokeColor} onChange={(c) => applyToAll({ strokeColor: c })} />
                        <PropertyRow label="Width">
                            <MergedSelect
                                value={numToStr(strokeWidth)}
                                onChange={(v) => applyToAll({ strokeWidth: Number(v) })}
                                options={STROKE_WIDTH_OPTIONS}
                            />
                        </PropertyRow>
                        <PropertyRow label="Style">
                            <MergedSelect
                                value={strokeStyle}
                                onChange={(v) => applyToAll({ strokeStyle: v })}
                                options={STROKE_STYLE_OPTIONS}
                            />
                        </PropertyRow>
                    </PropertySection>

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

                    <PropertySection title="Sketch">
                        <PropertyRow label="Rough">
                            <MergedSelect
                                value={numToStr(roughness)}
                                onChange={(v) => applyToAll({ roughness: Number(v) })}
                                options={ROUGHNESS_OPTIONS}
                            />
                        </PropertyRow>
                        {allRectDiamond && (
                            <PropertyRow label="Edges">
                                <MergedSelect
                                    value={roundness}
                                    onChange={(v) => applyToAll({ roundness: v })}
                                    options={EDGES_OPTIONS}
                                />
                            </PropertyRow>
                        )}
                    </PropertySection>
                </>
            )}

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
        </PropertiesPanel>
    );
}
