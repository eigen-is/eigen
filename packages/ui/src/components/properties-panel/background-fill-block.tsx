import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import type { BackgroundFill } from '@workspace/lib/types/background';
import { Button } from '@workspace/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { cn } from '@workspace/ui/lib/utils';
import {
    ArrowDown,
    ArrowDownLeft,
    ArrowDownRight,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowUpLeft,
    ArrowUpRight,
    Ban,
    ImageIcon,
    Palette,
    Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ColorRow } from './color-row';
import { MergedSelect } from './merged-select';
import { PropertyRow, PropertySection } from './properties-panel';

type FillType = BackgroundFill['type'];
type Segment = 'none' | FillType;

function carryColor(value: BackgroundFill | null): string {
    if (value?.type === 'solid') return value.color;
    if (value?.type === 'gradient') return value.from;
    return DEFAULT_FILL_COLOR;
}

// 3x3 grid (centre cell is empty). CSS `linear-gradient` angle convention.
const DIRECTIONS = [
    { angle: 315, Icon: ArrowUpLeft, label: 'Top-left' },
    { angle: 0, Icon: ArrowUp, label: 'Top' },
    { angle: 45, Icon: ArrowUpRight, label: 'Top-right' },
    { angle: 270, Icon: ArrowLeft, label: 'Left' },
    null,
    { angle: 90, Icon: ArrowRight, label: 'Right' },
    { angle: 225, Icon: ArrowDownLeft, label: 'Bottom-left' },
    { angle: 180, Icon: ArrowDown, label: 'Bottom' },
    { angle: 135, Icon: ArrowDownRight, label: 'Bottom-right' },
];

type BackgroundFillBlockProps = {
    value: BackgroundFill | null;
    onChange: (next: BackgroundFill | null) => void;
    title?: string;
    allowedTypes?: FillType[];
    allowNone?: boolean;
    mixed?: boolean;
    onPickImage?: () => void;
    imagePreviewUrl?: string | null;
    // Extra rows for this block, rendered under the paint body while a paint is set — the vector Fill's
    // hatch-style row lives here, because the hatch is half of the same stored fill.
    children?: ReactNode;
};

export function BackgroundFillBlock({
    value,
    onChange,
    title = 'Background',
    allowedTypes = ['solid', 'gradient', 'image'],
    allowNone = true,
    mixed = false,
    onPickImage,
    imagePreviewUrl,
    children,
}: BackgroundFillBlockProps) {
    const current: Segment | '' = mixed ? '' : value === null ? 'none' : value.type;

    const handleSegment = (next: Segment) => {
        switch (next) {
            case 'none':
                onChange(null);
                return;
            case 'solid':
                onChange({ type: 'solid', color: carryColor(value) });
                return;
            case 'gradient':
                onChange({ type: 'gradient', from: carryColor(value), to: 'transparent', angle: 180 });
                return;
            case 'image':
                onChange({ type: 'image', mediaName: '', fit: 'cover' });
                onPickImage?.();
                return;
        }
    };

    return (
        <PropertySection title={title}>
            <Tabs value={current} onValueChange={(v) => handleSegment(v as Segment)}>
                <TabsList className="w-full">
                    {allowNone && (
                        <TabsTrigger value="none" aria-label="No fill">
                            <Ban className="h-3.5 w-3.5" />
                        </TabsTrigger>
                    )}
                    {allowedTypes.includes('solid') && (
                        <TabsTrigger value="solid" aria-label="Solid color">
                            <Palette className="h-3.5 w-3.5" />
                        </TabsTrigger>
                    )}
                    {allowedTypes.includes('gradient') && (
                        <TabsTrigger value="gradient" aria-label="Gradient">
                            <div className="h-3.5 w-3.5 rounded-sm bg-gradient-to-br from-foreground to-transparent" />
                        </TabsTrigger>
                    )}
                    {allowedTypes.includes('image') && (
                        <TabsTrigger value="image" aria-label="Image">
                            <ImageIcon className="h-3.5 w-3.5" />
                        </TabsTrigger>
                    )}
                </TabsList>
            </Tabs>

            {mixed && <div className="text-xs text-muted-foreground">Multiple values — pick a type to set on all.</div>}

            {!mixed && value?.type === 'solid' && <SolidBody value={value} onChange={onChange} />}
            {!mixed && value?.type === 'gradient' && <GradientBody value={value} onChange={onChange} />}
            {!mixed && value?.type === 'image' && (
                <ImageBody
                    value={value}
                    onChange={onChange}
                    previewUrl={imagePreviewUrl ?? null}
                    onPick={onPickImage}
                />
            )}

            {(mixed || value !== null) && children}
        </PropertySection>
    );
}

function SolidBody({
    value,
    onChange,
}: {
    value: Extract<BackgroundFill, { type: 'solid' }>;
    onChange: (next: BackgroundFill) => void;
}) {
    return (
        <ColorRow
            label="Color"
            value={value.color}
            onChange={(color) => onChange({ type: 'solid', color })}
            showReset={false}
        />
    );
}

function GradientBody({
    value,
    onChange,
}: {
    value: Extract<BackgroundFill, { type: 'gradient' }>;
    onChange: (next: BackgroundFill) => void;
}) {
    return (
        <>
            <ColorRow
                label="From"
                value={value.from}
                onChange={(from) => onChange({ ...value, from })}
                showReset={false}
                allowNone
                noneLabel="Transparent"
            />
            <ColorRow
                label="To"
                value={value.to}
                onChange={(to) => onChange({ ...value, to })}
                showReset={false}
                allowNone
                noneLabel="Transparent"
            />
            <PropertyRow label="Direction" className="items-start">
                <div className="grid grid-cols-3 gap-1 w-fit">
                    {DIRECTIONS.map((d, i) => {
                        if (!d) return <div key={`center-${i}`} className="h-6 w-6" />;
                        const active = value.angle === d.angle;
                        return (
                            <button
                                key={d.angle}
                                type="button"
                                aria-label={d.label}
                                onClick={() => onChange({ ...value, angle: d.angle })}
                                className={cn(
                                    'h-6 w-6 rounded border flex items-center justify-center hover:bg-accent',
                                    active ? 'border-foreground bg-accent' : 'border-border',
                                )}
                            >
                                <d.Icon className="h-3 w-3" />
                            </button>
                        );
                    })}
                </div>
            </PropertyRow>
        </>
    );
}

const FIT_OPTIONS: { value: 'cover' | 'contain'; label: string }[] = [
    { value: 'cover', label: 'Cover' },
    { value: 'contain', label: 'Contain' },
];

function ImageBody({
    value,
    onChange,
    previewUrl,
    onPick,
}: {
    value: Extract<BackgroundFill, { type: 'image' }>;
    onChange: (next: BackgroundFill | null) => void;
    previewUrl: string | null;
    onPick?: () => void;
}) {
    if (!value.mediaName) {
        return (
            <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={onPick}>
                <ImageIcon className="h-3.5 w-3.5" />
                Choose image
            </Button>
        );
    }
    return (
        <>
            {previewUrl && (
                <div className="rounded border overflow-hidden">
                    <img src={previewUrl} alt="" className="w-full h-20 object-cover" />
                </div>
            )}
            <PropertyRow label="Fit">
                <MergedSelect value={value.fit} onChange={(fit) => onChange({ ...value, fit })} options={FIT_OPTIONS} />
            </PropertyRow>
            <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={onPick}>
                    Replace
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7"
                    onClick={() => onChange(null)}
                    aria-label="Remove image"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </Button>
            </div>
        </>
    );
}
