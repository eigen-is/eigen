import { isSameFill } from '@workspace/lib/background';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { useMediaResolver } from '@workspace/lib/drive';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import { TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { ColorPicker } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import {
    AlignmentPicker,
    BackgroundFillBlock,
    getMergedValue,
    isMixed,
    type MergedValue,
    PropertiesPanel,
    PropertyNumberInput,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Toggle } from '@workspace/ui/components/toggle';
import {
    AlignHorizontalDistributeCenter,
    AlignHorizontalJustifyCenter,
    AlignHorizontalJustifyEnd,
    AlignHorizontalJustifyStart,
    AlignVerticalDistributeCenter,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    Bold,
    Italic,
    MoveHorizontal,
    MoveVertical,
    Strikethrough,
    Trash2,
    Underline,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ArrangeOp } from './arrange';
import type { ApplyTo, ImageObject, SlideObject, TextObject } from './types';
import { BORDER_RADIUS_ROUND } from './types';

type SlidePropertiesPanelProps = {
    objects: SlideObject[];
    onUpdate: (ids: string[], updates: Partial<SlideObject>) => void;
    onDelete?: (ids: string[]) => void;
    onArrange?: (op: ArrangeOp) => void;
};

export function SlidePropertiesPanel({ objects, onUpdate, onDelete, onArrange }: SlidePropertiesPanelProps) {
    const ids = useMemo(() => objects.map((o) => o.id), [objects]);

    const allText = objects.every((o) => o.type === 'text');
    const allImage = objects.every((o) => o.type === 'image');

    const handleUpdate = useCallback(
        (updates: Partial<SlideObject>) => {
            onUpdate(ids, updates);
        },
        [ids, onUpdate],
    );

    const x = getMergedValue(objects, (o) => Math.round(o.x));
    const y = getMergedValue(objects, (o) => Math.round(o.y));
    const w = getMergedValue(objects, (o) => Math.round(o.w));
    const h = getMergedValue(objects, (o) => Math.round(o.h));
    const rotation = getMergedValue(objects, (o) => o.rotation);

    return (
        <PropertiesPanel
            title={objects.length === 1 ? (objects[0].type === 'text' ? 'Text' : 'Image') : `${objects.length} objects`}
        >
            <PropertySection title="Transform">
                <div className="grid grid-cols-2 gap-2">
                    <PropertyRow label="X">
                        <MergedNumberInput value={x} onChange={(v) => handleUpdate({ x: v })} step={1} />
                    </PropertyRow>
                    <PropertyRow label="Y">
                        <MergedNumberInput value={y} onChange={(v) => handleUpdate({ y: v })} step={1} />
                    </PropertyRow>
                    <PropertyRow label="W">
                        <MergedNumberInput value={w} onChange={(v) => handleUpdate({ w: v })} step={1} min={1} />
                    </PropertyRow>
                    <PropertyRow label="H">
                        <MergedNumberInput value={h} onChange={(v) => handleUpdate({ h: v })} step={1} min={1} />
                    </PropertyRow>
                </div>
                <PropertyRow label="°">
                    <MergedNumberInput
                        value={rotation}
                        onChange={(v) => handleUpdate({ rotation: v })}
                        step={1}
                        min={-360}
                        max={360}
                    />
                </PropertyRow>
            </PropertySection>

            {onArrange && objects.length >= 2 && <ArrangeProperties count={objects.length} onArrange={onArrange} />}

            {allText && (
                <TextProperties objects={objects as (SlideObject & { type: 'text' })[]} onUpdate={handleUpdate} />
            )}

            {allImage && (
                <ImageProperties objects={objects as (SlideObject & { type: 'image' })[]} onUpdate={handleUpdate} />
            )}

            <BorderProperties objects={objects} onUpdate={handleUpdate} />

            {onDelete && (
                <div className="px-3 py-3">
                    <Button variant="destructive" size="sm" className="w-full" onClick={() => onDelete(ids)}>
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                        Delete{objects.length > 1 ? ` ${objects.length} objects` : ''}
                    </Button>
                </div>
            )}
        </PropertiesPanel>
    );
}

function ArrangeProperties({ count, onArrange }: { count: number; onArrange: (op: ArrangeOp) => void }) {
    const canDistribute = count >= 3;
    return (
        <PropertySection title="Arrange">
            <div className="flex items-center gap-1">
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyStart}
                    tooltipText="Align left"
                    onClick={() => onArrange('align-left')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyCenter}
                    tooltipText="Align horizontal center"
                    onClick={() => onArrange('align-h-center')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyEnd}
                    tooltipText="Align right"
                    onClick={() => onArrange('align-right')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyStart}
                    tooltipText="Align top"
                    onClick={() => onArrange('align-top')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyCenter}
                    tooltipText="Align vertical center"
                    onClick={() => onArrange('align-v-center')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyEnd}
                    tooltipText="Align bottom"
                    onClick={() => onArrange('align-bottom')}
                />
            </div>
            <div className="flex items-center gap-1">
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalDistributeCenter}
                    tooltipText={canDistribute ? 'Distribute horizontally' : 'Select 3+ objects to distribute'}
                    disabled={!canDistribute}
                    onClick={() => onArrange('distribute-h')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalDistributeCenter}
                    tooltipText={canDistribute ? 'Distribute vertically' : 'Select 3+ objects to distribute'}
                    disabled={!canDistribute}
                    onClick={() => onArrange('distribute-v')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={MoveHorizontal}
                    tooltipText="Match width"
                    onClick={() => onArrange('match-width')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={MoveVertical}
                    tooltipText="Match height"
                    onClick={() => onArrange('match-height')}
                />
            </div>
        </PropertySection>
    );
}

function TextProperties({
    objects,
    onUpdate,
}: {
    objects: TextObject[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const [colorOpen, setColorOpen] = useState(false);
    const [highlightOpen, setHighlightOpen] = useState(false);

    const fontFamily = getMergedValue(objects, (o) => o.fontFamily);
    const fontSize = getMergedValue(objects, (o) => o.fontSize);
    const fontWeight = getMergedValue(objects, (o) => o.fontWeight);
    const fontStyle = getMergedValue(objects, (o) => o.fontStyle);
    const textDecoration = getMergedValue(objects, (o) => o.textDecoration);
    const textAlign = getMergedValue(objects, (o) => o.textAlign);
    const verticalAlign = getMergedValue(objects, (o) => o.verticalAlign);
    const color = getMergedValue(objects, (o) => o.color);
    const letterSpacing = getMergedValue(objects, (o) => o.letterSpacing);
    const lineHeight = getMergedValue(objects, (o) => o.lineHeight);
    const highlightColor = getMergedValue(objects, (o) => o.highlightColor);

    return (
        <>
            <PropertySection title="Text">
                <PropertyRow label="Font">
                    <FontPicker
                        value={isMixed(fontFamily) ? EIGEN_FONTS[0].name : fontFamily || EIGEN_FONTS[0].name}
                        onChange={(f) => onUpdate({ fontFamily: f })}
                        className="h-7 w-full text-xs"
                    />
                </PropertyRow>
                <PropertyRow label="Size">
                    <MergedNumberInput
                        value={fontSize}
                        onChange={(v) => onUpdate({ fontSize: v })}
                        min={12}
                        max={200}
                        step={1}
                    />
                </PropertyRow>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        pressed={fontWeight === 'bold'}
                        onPressedChange={(p) => onUpdate({ fontWeight: p ? 'bold' : 'normal' })}
                        data-mixed={isMixed(fontWeight) ? '' : undefined}
                    >
                        <Bold className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={fontStyle === 'italic'}
                        onPressedChange={(p) => onUpdate({ fontStyle: p ? 'italic' : 'normal' })}
                        data-mixed={isMixed(fontStyle) ? '' : undefined}
                    >
                        <Italic className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textDecoration === 'underline'}
                        onPressedChange={(p) => onUpdate({ textDecoration: p ? 'underline' : 'none' })}
                        data-mixed={isMixed(textDecoration) ? '' : undefined}
                    >
                        <Underline className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textDecoration === 'line-through'}
                        onPressedChange={(p) => onUpdate({ textDecoration: p ? 'line-through' : 'none' })}
                    >
                        <Strikethrough className="h-4 w-4" />
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <AlignmentPicker
                        value={isMixed(textAlign) ? undefined : (textAlign as 'left' | 'center' | 'right' | undefined)}
                        onChange={(a) => onUpdate({ textAlign: a })}
                    />
                    <Toggle
                        size="sm"
                        pressed={textAlign === 'justify'}
                        onPressedChange={() => onUpdate({ textAlign: 'justify' })}
                    >
                        {/* Keep justify inline since AlignmentPicker only handles left/center/right */}
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <title>Justify</title>
                            <line x1="3" y1="6" x2="21" y2="6" />
                            <line x1="3" y1="12" x2="21" y2="12" />
                            <line x1="3" y1="18" x2="21" y2="18" />
                        </svg>
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'top'}
                        onPressedChange={() => onUpdate({ verticalAlign: 'top' })}
                    >
                        <AlignVerticalJustifyStart className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'center'}
                        onPressedChange={() => onUpdate({ verticalAlign: 'center' })}
                    >
                        <AlignVerticalJustifyCenter className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'bottom'}
                        onPressedChange={() => onUpdate({ verticalAlign: 'bottom' })}
                    >
                        <AlignVerticalJustifyEnd className="h-4 w-4" />
                    </Toggle>
                </div>
            </PropertySection>

            <PropertySection title="Spacing">
                <div className="grid grid-cols-2 gap-2">
                    <PropertyRow label="Letter">
                        <MergedNumberInput
                            value={letterSpacing}
                            onChange={(v) => onUpdate({ letterSpacing: v })}
                            step={0.5}
                            min={-10}
                            max={50}
                        />
                    </PropertyRow>
                    <PropertyRow label="Line">
                        <MergedNumberInput
                            value={lineHeight}
                            onChange={(v) => onUpdate({ lineHeight: v })}
                            step={0.1}
                            min={0.5}
                            max={5}
                        />
                    </PropertyRow>
                </div>
            </PropertySection>

            <PropertySection title="Color">
                <ColorRow
                    label="Text"
                    value={color}
                    onOpen={setColorOpen}
                    open={colorOpen}
                    onChange={(c) => {
                        onUpdate({ color: c || '#000000' });
                        setColorOpen(false);
                    }}
                />
                <ColorRow
                    label="Highlight"
                    value={highlightColor}
                    onOpen={setHighlightOpen}
                    open={highlightOpen}
                    onChange={(c) => {
                        onUpdate({ highlightColor: c });
                        setHighlightOpen(false);
                    }}
                    showReset
                />
            </PropertySection>
            <TextBackgroundBlock objects={objects} onUpdate={onUpdate} />
        </>
    );
}

function TextBackgroundBlock({
    objects,
    onUpdate,
}: {
    objects: TextObject[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const first = objects[0]?.background ?? null;
    const mixed = !objects.every((o) => isSameFill(o.background, first));
    return (
        <BackgroundFillBlock
            value={mixed ? null : first}
            mixed={mixed}
            onChange={(next) => onUpdate({ background: next })}
            allowedTypes={['solid', 'gradient']}
        />
    );
}

function ImageProperties({
    objects,
    onUpdate,
}: {
    objects: ImageObject[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const objectFit = getMergedValue(objects, (o) => o.objectFit);
    const { resolveMediaUrl } = useMediaResolver();

    return (
        <PropertySection title="Image">
            {objects.length === 1 && (
                <div className="border rounded overflow-hidden mb-2">
                    <img
                        src={resolveMediaUrl(objects[0].mediaName) || ''}
                        alt=""
                        className="max-h-24 mx-auto object-contain"
                    />
                </div>
            )}
            <PropertyRow label="Fit">
                <Select
                    value={isMixed(objectFit) ? undefined : objectFit}
                    onValueChange={(v) => onUpdate({ objectFit: v as 'contain' | 'cover' | 'fill' })}
                >
                    <SelectTrigger className="h-7 text-xs">
                        <SelectValue placeholder={isMixed(objectFit) ? '—' : undefined} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="contain">Contain</SelectItem>
                        <SelectItem value="cover">Cover</SelectItem>
                        <SelectItem value="fill">Fill</SelectItem>
                    </SelectContent>
                </Select>
            </PropertyRow>
        </PropertySection>
    );
}

function BorderProperties({
    objects,
    onUpdate,
}: {
    objects: SlideObject[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const [colorOpen, setColorOpen] = useState(false);
    const borderColor = getMergedValue(objects, (o) => o.borderColor);
    const borderWidth = getMergedValue(objects, (o) => o.borderWidth);
    const borderRadius = getMergedValue(objects, (o) => o.borderRadius);
    const isRounded = !isMixed(borderRadius) && borderRadius !== undefined && borderRadius >= BORDER_RADIUS_ROUND;

    return (
        <PropertySection title="Border">
            <ColorRow
                label="Color"
                value={borderColor}
                onOpen={setColorOpen}
                open={colorOpen}
                onChange={(c) => {
                    onUpdate({ borderColor: c });
                    setColorOpen(false);
                }}
                showReset
            />
            <PropertyRow label="Width">
                <MergedNumberInput
                    value={borderWidth}
                    onChange={(v) => onUpdate({ borderWidth: v })}
                    step={1}
                    min={0}
                    max={20}
                />
            </PropertyRow>
            <div className="grid grid-cols-2 gap-2">
                <PropertyRow label="Radius">
                    <MergedNumberInput
                        value={isRounded ? 0 : borderRadius}
                        onChange={(v) => onUpdate({ borderRadius: v })}
                        step={2}
                        min={0}
                        max={100}
                    />
                </PropertyRow>
                <PropertyRow label="Rounded">
                    <Toggle
                        pressed={isRounded}
                        onPressedChange={(pressed) => onUpdate({ borderRadius: pressed ? BORDER_RADIUS_ROUND : 0 })}
                        size="sm"
                        className="h-7 w-full text-xs"
                    >
                        50%
                    </Toggle>
                </PropertyRow>
            </div>
        </PropertySection>
    );
}

function ColorRow({
    label,
    value,
    open,
    onOpen,
    onChange,
    showReset,
}: {
    label: string;
    value: MergedValue<string>;
    open: boolean;
    onOpen: (open: boolean) => void;
    onChange: (color: string) => void;
    showReset?: boolean;
}) {
    const mixed = isMixed(value);
    const displayColor = mixed ? undefined : value || undefined;

    return (
        <Popover open={open} onOpenChange={onOpen}>
            <PopoverTrigger asChild>
                <button className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full">
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
                <ColorPicker value={mixed ? '#000000' : value || '#000000'} onChange={onChange} showReset={showReset} />
            </PopoverContent>
        </Popover>
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

type SlideBackgroundPanelProps = {
    background: BackgroundFill | null;
    backgroundImageUrl: string | null;
    onUpdateBackground: (background: BackgroundFill | null, applyTo: ApplyTo) => void;
    onUploadImage: (file: File) => Promise<string | null>;
    onPickImageFromDrive?: (paths: DrivePath[]) => void;
};

export function SlideBackgroundPanel({
    background,
    backgroundImageUrl,
    onUpdateBackground,
    onUploadImage,
    onPickImageFromDrive,
}: SlideBackgroundPanelProps) {
    const [applyTo, setApplyTo] = useState<ApplyTo>('this');
    const [bgPickerOpen, setBgPickerOpen] = useState(false);

    const handleImageFromDevice = useCallback(
        async (files: File[]) => {
            const file = files[0];
            if (!file) return;
            const mediaName = await onUploadImage(file);
            if (mediaName) onUpdateBackground({ type: 'image', mediaName, fit: 'cover' }, 'this');
        },
        [onUploadImage, onUpdateBackground],
    );

    const handleApplyToAll = useCallback(() => {
        onUpdateBackground(background, applyTo);
    }, [applyTo, background, onUpdateBackground]);

    return (
        <PropertiesPanel title="Slide">
            <BackgroundFillBlock
                value={background}
                onChange={(next) => onUpdateBackground(next, 'this')}
                onPickImage={() => setBgPickerOpen(true)}
                imagePreviewUrl={backgroundImageUrl}
            />

            <div className="px-3 py-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Apply to</h4>
                <div className="flex gap-2">
                    <Select value={applyTo} onValueChange={(v) => setApplyTo(v as ApplyTo)}>
                        <SelectTrigger size="sm" className="text-xs flex-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="this">This slide</SelectItem>
                            <SelectItem value="this-and-following">This and following</SelectItem>
                            <SelectItem value="all">All slides</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 text-xs" onClick={handleApplyToAll}>
                        Apply
                    </Button>
                </div>
            </div>

            <DrivePickerWithUpload
                open={bgPickerOpen}
                onOpenChange={setBgPickerOpen}
                title="Background image"
                mimeFilter={['image/*']}
                onPickFromDrive={(paths) => onPickImageFromDrive?.(paths)}
                onPickFromDevice={handleImageFromDevice}
                accept="image/*"
            />
        </PropertiesPanel>
    );
}
