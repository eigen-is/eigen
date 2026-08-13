import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import type { BackgroundFill } from '@workspace/lib/types/background';
import { Button } from '@workspace/ui/components/button';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group';
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
import { useState } from 'react';
import { PropertySection } from './properties-panel';

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
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full"
                >
                    <div
                        className="h-5 w-5 rounded border border-border shrink-0"
                        style={{ backgroundColor: value.color }}
                    />
                    <span className="text-xs text-muted-foreground">{value.color}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <ColorPicker
                    value={value.color}
                    onChange={(color) => {
                        onChange({ type: 'solid', color });
                        setOpen(false);
                    }}
                    showReset={false}
                />
            </PopoverContent>
        </Popover>
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
        <div className="space-y-2">
            <GradientStop label="From" color={value.from} onChange={(from) => onChange({ ...value, from })} />
            <GradientStop label="To" color={value.to} onChange={(to) => onChange({ ...value, to })} />
            <div className="pt-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Direction</div>
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
            </div>
        </div>
    );
}

function GradientStop({ label, color, onChange }: { label: string; color: string; onChange: (next: string) => void }) {
    const [open, setOpen] = useState(false);
    const isTransparent = color === 'transparent';
    const checker =
        'bg-[conic-gradient(at_top_left,#ccc_25%,white_0,white_50%,#ccc_0,#ccc_75%,white_0)] bg-[length:8px_8px]';
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-9 shrink-0">{label}</span>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className="flex items-center gap-2 h-7 px-1.5 rounded hover:bg-accent text-xs flex-1"
                    >
                        <div
                            className={cn('h-4 w-4 rounded border border-border shrink-0', isTransparent && checker)}
                            style={isTransparent ? undefined : { backgroundColor: color }}
                        />
                        <span className="text-xs text-muted-foreground truncate">
                            {isTransparent ? 'Transparent' : color}
                        </span>
                    </button>
                </PopoverTrigger>
                <PopoverContent side="left" align="start" className="w-auto">
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                onChange('transparent');
                                setOpen(false);
                            }}
                            className={cn(
                                'flex items-center gap-2 px-2 py-1.5 -mx-1 rounded-md text-sm hover:bg-accent transition-colors',
                                isTransparent && 'bg-accent',
                            )}
                        >
                            <div className={cn('h-4 w-4 rounded border border-border', checker)} />
                            <span>Transparent</span>
                        </button>
                        <ColorPicker
                            value={isTransparent ? '#ffffff' : color}
                            onChange={(c) => {
                                onChange(c);
                                setOpen(false);
                            }}
                            showReset={false}
                        />
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    );
}

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
            <Button variant="outline" size="sm" className="w-full" onClick={onPick}>
                <ImageIcon className="h-3.5 w-3.5 mr-1.5" />
                Choose image
            </Button>
        );
    }
    return (
        <div className="space-y-2">
            {previewUrl && (
                <div className="rounded border overflow-hidden">
                    <img src={previewUrl} alt="" className="w-full h-20 object-cover" />
                </div>
            )}
            <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={value.fit}
                onValueChange={(v) => v && onChange({ ...value, fit: v as 'cover' | 'contain' })}
                className="w-full"
            >
                <ToggleGroupItem value="cover" className="flex-1 text-xs">
                    Cover
                </ToggleGroupItem>
                <ToggleGroupItem value="contain" className="flex-1 text-xs">
                    Contain
                </ToggleGroupItem>
            </ToggleGroup>
            <div className="flex gap-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={onPick}>
                    Replace
                </Button>
                <Button variant="outline" size="sm" onClick={() => onChange(null)} aria-label="Remove image">
                    <Trash2 className="h-3.5 w-3.5" />
                </Button>
            </div>
        </div>
    );
}
