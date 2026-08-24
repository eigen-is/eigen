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
import { TooltipButton } from '@workspace/ui';
import { ColorPicker } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import {
    AlignmentPicker,
    getMergedValue,
    isMixed,
    type MergedValue,
    PropertiesPanel,
    PropertyNumberInput,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { BringToFront, ChevronDown, ChevronUp, SendToBack } from 'lucide-react';
import { useState } from 'react';
import type * as Y from 'yjs';
import type { VectorElementPatch } from './hooks/use-vector-doc';
import { applyZOrder, type ZOp } from './hooks/use-vector-keyboard';
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
};

export function VectorPropertiesPanel({
    elements,
    selectedElements,
    updateElements,
    undoManager,
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
                <div className="flex items-center gap-1">
                    <TooltipButton
                        className="h-7 w-7"
                        icon={SendToBack}
                        tooltipText="Send to back"
                        onClick={() => handleZOrderApply('toBack')}
                    />
                    <TooltipButton
                        className="h-7 w-7"
                        icon={ChevronDown}
                        tooltipText="Send backward"
                        onClick={() => handleZOrderApply('backward')}
                    />
                    <TooltipButton
                        className="h-7 w-7"
                        icon={ChevronUp}
                        tooltipText="Bring forward"
                        onClick={() => handleZOrderApply('forward')}
                    />
                    <TooltipButton
                        className="h-7 w-7"
                        icon={BringToFront}
                        tooltipText="Bring to front"
                        onClick={() => handleZOrderApply('toFront')}
                    />
                </div>
            </PropertySection>
        </PropertiesPanel>
    );
}

function MergedNumberInput({
    value,
    onChange,
    min,
    max,
    step,
}: {
    value: MergedValue<number>;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
}) {
    const mixed = isMixed(value);
    return (
        <PropertyNumberInput
            value={mixed ? undefined : value}
            onChange={onChange}
            min={min}
            max={max}
            step={step}
            placeholder={mixed ? '—' : undefined}
        />
    );
}

function MergedSelect<T extends string>({
    value,
    onChange,
    options,
}: {
    value: MergedValue<T>;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
}) {
    const mixed = isMixed(value);
    // Always-controlled: '' (never undefined) for mixed — Radix renders the placeholder for '',
    // while flipping to undefined would switch the Select controlled→uncontrolled (React warning).
    const controlled = mixed || value === undefined ? '' : value;
    return (
        // onValueChange is the library seam: Radix types it (value: string) => void, so the cast back
        // to the option union lives here and nowhere else.
        <Select value={controlled} onValueChange={(v) => onChange(v as T)}>
            <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder={mixed ? '—' : undefined} />
            </SelectTrigger>
            <SelectContent>
                {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                        {o.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function ColorRow({
    label,
    value,
    onChange,
    showReset,
}: {
    label: string;
    value: MergedValue<string>;
    onChange: (color: string) => void;
    showReset?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const mixed = isMixed(value);
    const displayColor = mixed ? undefined : value || undefined;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full"
                >
                    <div
                        className="h-5 w-5 rounded border border-border shrink-0"
                        style={{ backgroundColor: displayColor }}
                    >
                        {mixed && (
                            <span className="text-xs text-muted-foreground flex items-center justify-center h-full">
                                —
                            </span>
                        )}
                        {!mixed && !value && (
                            <span className="text-xs text-muted-foreground flex items-center justify-center h-full">
                                ∅
                            </span>
                        )}
                    </div>
                    <span className="text-xs flex-1 text-left">{label}</span>
                    {!mixed && value && <span className="text-xs text-muted-foreground">{value}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <ColorPicker
                    value={mixed ? '#000000' : value || '#000000'}
                    onChange={(c) => {
                        onChange(c);
                        setOpen(false);
                    }}
                    showReset={showReset}
                />
            </PopoverContent>
        </Popover>
    );
}
