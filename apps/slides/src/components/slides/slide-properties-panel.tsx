import { isSameFill } from '@workspace/lib/background';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { useMediaResolver } from '@workspace/lib/drive';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import { type ArrangeOp, STROKE_WIDTH_OPTIONS } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import {
    AlignmentPicker,
    AlignSection,
    BackgroundFillBlock,
    ColorRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    MergedSelect,
    numToStr,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    TransformSection,
    type ZOp,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Toggle } from '@workspace/ui/components/toggle';
import {
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    Bold,
    Italic,
    Strikethrough,
    Trash2,
    Underline,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ApplyTo, ImageObject, SlideObject, TextObject } from './types';
import { BORDER_RADIUS_ROUND } from './types';

type SlidePropertiesPanelProps = {
    objects: SlideObject[];
    onUpdate: (ids: string[], updates: Partial<SlideObject>) => void;
    onDelete?: (ids: string[]) => void;
    // Align/distribute/match-size (the "Align" section) — align+distribute math in arrange.ts.
    onAlign?: (op: ArrangeOp) => void;
    // Z-order (the "Arrange" section) — shares vector's ZOp vocabulary; wired to the Y.Array reorder.
    onZOrder?: (op: ZOp) => void;
    // Ephemeral per-selection aspect lock (Override 3), owned by the editor so the same ON/OFF also
    // feeds SlideCanvas' ObjectTransform resizeMode.
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
};

export function SlidePropertiesPanel({
    objects,
    onUpdate,
    onDelete,
    onAlign,
    onZOrder,
    aspectLocked,
    onAspectLockChange,
}: SlidePropertiesPanelProps) {
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
    const width = getMergedValue(objects, (o) => Math.round(o.width));
    const height = getMergedValue(objects, (o) => Math.round(o.height));
    const angle = getMergedValue(objects, (o) => o.angle);

    return (
        <PropertiesPanel
            title={objects.length === 1 ? (objects[0].type === 'text' ? 'Text' : 'Image') : `${objects.length} objects`}
        >
            <TransformSection
                x={x}
                y={y}
                width={width}
                height={height}
                angle={angle}
                onChange={handleUpdate}
                aspectLocked={aspectLocked}
                onAspectLockChange={onAspectLockChange}
            />

            {onZOrder && (
                <PropertySection title="Arrange">
                    <ZOrderButtons onApply={onZOrder} />
                </PropertySection>
            )}

            {onAlign && objects.length >= 2 && <AlignSection count={objects.length} onApply={onAlign} />}

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

function TextProperties({
    objects,
    onUpdate,
}: {
    objects: TextObject[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
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
                <ColorRow label="Text" value={color} onChange={(c) => onUpdate({ color: c || '#000000' })} />
                <ColorRow
                    label="Highlight"
                    value={highlightColor}
                    onChange={(c) => onUpdate({ highlightColor: c })}
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
                <MergedSelect
                    value={objectFit}
                    onChange={(v) => onUpdate({ objectFit: v })}
                    options={[
                        { value: 'contain', label: 'Contain' },
                        { value: 'cover', label: 'Cover' },
                        { value: 'fill', label: 'Fill' },
                    ]}
                />
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
    const borderColor = getMergedValue(objects, (o) => o.borderColor);
    const borderWidth = getMergedValue(objects, (o) => o.borderWidth);
    const borderRadius = getMergedValue(objects, (o) => o.borderRadius);
    const isRounded = !isMixed(borderRadius) && borderRadius !== undefined && borderRadius >= BORDER_RADIUS_ROUND;

    return (
        <PropertySection title="Border">
            {/* "No border" is the color reset (render gates on borderWidth && borderColor); the preset
                list carries weight only, so it has no 0/None entry — clearing the color removes the border. */}
            <ColorRow label="Color" value={borderColor} onChange={(c) => onUpdate({ borderColor: c })} showReset />
            <PropertyRow label="Width">
                <MergedSelect
                    value={numToStr(borderWidth)}
                    onChange={(v) => onUpdate({ borderWidth: Number(v) })}
                    options={STROKE_WIDTH_OPTIONS}
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
