import {useCallback, useMemo, useState} from 'react';
import {
    AlignCenter,
    AlignJustify,
    AlignLeft,
    AlignRight,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    Bold,
    Italic,
    Strikethrough,
    Trash2,
    Underline,
} from 'lucide-react';
import {PropertiesPanel, PropertyRow, PropertySection} from '@workspace/ui/components/layout/properties-panel';
import {Input} from '@workspace/ui/components/input';
import {Button} from '@workspace/ui/components/button';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Toggle} from '@workspace/ui/components/toggle';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import type {SlideObject, TextObject, ImageObject} from './types';

const MIXED = 'mixed' as const;
type MergedValue<T> = T | typeof MIXED | undefined;

function getMergedValue<O, T>(objects: O[], getter: (obj: O) => T | undefined): MergedValue<T> {
    const values = objects.map(getter).filter((v): v is T => v !== undefined);
    if (values.length === 0) return undefined;
    if (values.every(v => v === values[0])) return values[0];
    return MIXED;
}

function isMixed<T>(v: MergedValue<T>): v is typeof MIXED {
    return v === MIXED;
}

type SlidePropertiesPanelProps = {
    objects: SlideObject[];
    onUpdate: (ids: string[], updates: Partial<SlideObject>) => void;
    onDelete?: (ids: string[]) => void;
}

export function SlidePropertiesPanel({objects, onUpdate, onDelete}: SlidePropertiesPanelProps) {
    const ids = useMemo(() => objects.map(o => o.id), [objects]);

    const allText = objects.every(o => o.type === 'text');
    const allImage = objects.every(o => o.type === 'image');

    const handleUpdate = useCallback((updates: Partial<SlideObject>) => {
        onUpdate(ids, updates);
    }, [ids, onUpdate]);

    const x = getMergedValue(objects, o => roundTo(o.x, 1));
    const y = getMergedValue(objects, o => roundTo(o.y, 1));
    const w = getMergedValue(objects, o => roundTo(o.w, 1));
    const h = getMergedValue(objects, o => roundTo(o.h, 1));
    const rotation = getMergedValue(objects, o => o.rotation);

    const shadowColor = getMergedValue(objects, o => o.shadowColor);
    const shadowBlur = getMergedValue(objects, o => o.shadowBlur);
    const shadowOffsetX = getMergedValue(objects, o => o.shadowOffsetX);
    const shadowOffsetY = getMergedValue(objects, o => o.shadowOffsetY);

    return (
        <PropertiesPanel>
            <div className="px-3 py-2 border-b">
                <span className="text-sm font-medium">
                    {objects.length === 1
                        ? objects[0].type === 'text' ? 'Text' : 'Image'
                        : `${objects.length} objects`
                    }
                </span>
            </div>

            <PropertySection title="Transform">
                <div className="grid grid-cols-2 gap-2">
                    <PropertyRow label="X">
                        <MergedNumberInput value={x} onChange={v => handleUpdate({x: v})} step={0.1}/>
                    </PropertyRow>
                    <PropertyRow label="Y">
                        <MergedNumberInput value={y} onChange={v => handleUpdate({y: v})} step={0.1}/>
                    </PropertyRow>
                    <PropertyRow label="W">
                        <MergedNumberInput value={w} onChange={v => handleUpdate({w: v})} step={0.1} min={1}/>
                    </PropertyRow>
                    <PropertyRow label="H">
                        <MergedNumberInput value={h} onChange={v => handleUpdate({h: v})} step={0.1} min={1}/>
                    </PropertyRow>
                </div>
                <PropertyRow label="°">
                    <MergedNumberInput value={rotation} onChange={v => handleUpdate({rotation: v})} step={1} min={-360} max={360}/>
                </PropertyRow>
            </PropertySection>

            {allText && (
                <TextProperties
                    objects={objects as (SlideObject & {type: 'text'})[]} 
                    onUpdate={handleUpdate}
                />
            )}

            {allImage && (
                <ImageProperties
                    objects={objects as (SlideObject & {type: 'image'})[]} 
                    onUpdate={handleUpdate}
                />
            )}

            <ShadowProperties
                shadowColor={shadowColor}
                shadowBlur={shadowBlur}
                shadowOffsetX={shadowOffsetX}
                shadowOffsetY={shadowOffsetY}
                onUpdate={handleUpdate}
            />

            {onDelete && (
                <div className="px-3 py-3">
                    <Button
                        variant="destructive"
                        size="sm"
                        className="w-full"
                        onClick={() => onDelete(ids)}
                    >
                        <Trash2 className="h-3.5 w-3.5 mr-1.5"/>
                        Delete{objects.length > 1 ? ` ${objects.length} objects` : ''}
                    </Button>
                </div>
            )}
        </PropertiesPanel>
    );
}

function TextProperties({objects, onUpdate}: {
    objects: (TextObject)[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const [colorOpen, setColorOpen] = useState(false);
    const [highlightOpen, setHighlightOpen] = useState(false);
    const [bgOpen, setBgOpen] = useState(false);

    const fontSize = getMergedValue(objects, o => o.fontSize);
    const fontWeight = getMergedValue(objects, o => o.fontWeight);
    const fontStyle = getMergedValue(objects, o => o.fontStyle);
    const textDecoration = getMergedValue(objects, o => o.textDecoration);
    const textAlign = getMergedValue(objects, o => o.textAlign);
    const verticalAlign = getMergedValue(objects, o => o.verticalAlign);
    const color = getMergedValue(objects, o => o.color);
    const letterSpacing = getMergedValue(objects, o => o.letterSpacing);
    const lineHeight = getMergedValue(objects, o => o.lineHeight);
    const highlightColor = getMergedValue(objects, o => o.highlightColor);
    const backgroundColor = getMergedValue(objects, o => o.backgroundColor);

    return (
        <>
            <PropertySection title="Text">
                <PropertyRow label="Size">
                    <MergedNumberInput value={fontSize} onChange={v => onUpdate({fontSize: v})} min={12} max={200} step={1}/>
                </PropertyRow>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        pressed={fontWeight === 'bold'}
                        onPressedChange={(p) => onUpdate({fontWeight: p ? 'bold' : 'normal'})}
                        data-mixed={isMixed(fontWeight) ? '' : undefined}
                    >
                        <Bold className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={fontStyle === 'italic'}
                        onPressedChange={(p) => onUpdate({fontStyle: p ? 'italic' : 'normal'})}
                        data-mixed={isMixed(fontStyle) ? '' : undefined}
                    >
                        <Italic className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textDecoration === 'underline'}
                        onPressedChange={(p) => onUpdate({textDecoration: p ? 'underline' : 'none'})}
                        data-mixed={isMixed(textDecoration) ? '' : undefined}
                    >
                        <Underline className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textDecoration === 'line-through'}
                        onPressedChange={(p) => onUpdate({textDecoration: p ? 'line-through' : 'none'})}
                    >
                        <Strikethrough className="h-4 w-4"/>
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        pressed={textAlign === 'left'}
                        onPressedChange={() => onUpdate({textAlign: 'left'})}
                    >
                        <AlignLeft className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textAlign === 'center'}
                        onPressedChange={() => onUpdate({textAlign: 'center'})}
                    >
                        <AlignCenter className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textAlign === 'right'}
                        onPressedChange={() => onUpdate({textAlign: 'right'})}
                    >
                        <AlignRight className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={textAlign === 'justify'}
                        onPressedChange={() => onUpdate({textAlign: 'justify'})}
                    >
                        <AlignJustify className="h-4 w-4"/>
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'top'}
                        onPressedChange={() => onUpdate({verticalAlign: 'top'})}
                    >
                        <AlignVerticalJustifyStart className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'center'}
                        onPressedChange={() => onUpdate({verticalAlign: 'center'})}
                    >
                        <AlignVerticalJustifyCenter className="h-4 w-4"/>
                    </Toggle>
                    <Toggle
                        size="sm"
                        pressed={verticalAlign === 'bottom'}
                        onPressedChange={() => onUpdate({verticalAlign: 'bottom'})}
                    >
                        <AlignVerticalJustifyEnd className="h-4 w-4"/>
                    </Toggle>
                </div>
            </PropertySection>

            <PropertySection title="Spacing">
                <div className="grid grid-cols-2 gap-2">
                    <PropertyRow label="Letter">
                        <MergedNumberInput value={letterSpacing} onChange={v => onUpdate({letterSpacing: v})} step={0.5} min={-10} max={50}/>
                    </PropertyRow>
                    <PropertyRow label="Line">
                        <MergedNumberInput value={lineHeight} onChange={v => onUpdate({lineHeight: v})} step={0.1} min={0.5} max={5}/>
                    </PropertyRow>
                </div>
            </PropertySection>

            <PropertySection title="Color">
                <ColorRow label="Text" value={color} onOpen={setColorOpen} open={colorOpen}
                    onChange={(c) => { onUpdate({color: c || '#000000'}); setColorOpen(false); }}
                />
                <ColorRow label="Highlight" value={highlightColor} onOpen={setHighlightOpen} open={highlightOpen}
                    onChange={(c) => { onUpdate({highlightColor: c}); setHighlightOpen(false); }}
                    showReset
                />
                <ColorRow label="Fill" value={backgroundColor} onOpen={setBgOpen} open={bgOpen}
                    onChange={(c) => { onUpdate({backgroundColor: c}); setBgOpen(false); }}
                    showReset
                />
            </PropertySection>
        </>
    );
}

function ImageProperties({objects, onUpdate}: {
    objects: (ImageObject)[];
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const objectFit = getMergedValue(objects, o => o.objectFit);

    return (
        <PropertySection title="Image">
            {objects.length === 1 && (
                <div className="border rounded overflow-hidden mb-2">
                    <img src={objects[0].src} alt="" className="max-h-24 mx-auto object-contain"/>
                </div>
            )}
            <PropertyRow label="Fit">
                <Select
                    value={isMixed(objectFit) ? undefined : objectFit}
                    onValueChange={(v) => onUpdate({objectFit: v as 'contain' | 'cover' | 'fill'})}
                >
                    <SelectTrigger className="h-7 text-xs">
                        <SelectValue placeholder={isMixed(objectFit) ? '—' : undefined}/>
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

function ShadowProperties({shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, onUpdate}: {
    shadowColor: MergedValue<string>;
    shadowBlur: MergedValue<number>;
    shadowOffsetX: MergedValue<number>;
    shadowOffsetY: MergedValue<number>;
    onUpdate: (updates: Partial<SlideObject>) => void;
}) {
    const [colorOpen, setColorOpen] = useState(false);

    return (
        <PropertySection title="Shadow">
            <ColorRow label="Color" value={shadowColor} onOpen={setColorOpen} open={colorOpen}
                onChange={(c) => { onUpdate({shadowColor: c || 'rgba(0,0,0,0)'}); setColorOpen(false); }}
                showReset
            />
            <PropertyRow label="Blur">
                <MergedNumberInput value={shadowBlur} onChange={v => onUpdate({shadowBlur: v})} step={1} min={0} max={100}/>
            </PropertyRow>
            <div className="grid grid-cols-2 gap-2">
                <PropertyRow label="X">
                    <MergedNumberInput value={shadowOffsetX} onChange={v => onUpdate({shadowOffsetX: v})} step={1} min={-50} max={50}/>
                </PropertyRow>
                <PropertyRow label="Y">
                    <MergedNumberInput value={shadowOffsetY} onChange={v => onUpdate({shadowOffsetY: v})} step={1} min={-50} max={50}/>
                </PropertyRow>
            </div>
        </PropertySection>
    );
}

function ColorRow({label, value, open, onOpen, onChange, showReset}: {
    label: string;
    value: MergedValue<string>;
    open: boolean;
    onOpen: (open: boolean) => void;
    onChange: (color: string) => void;
    showReset?: boolean;
}) {
    const mixed = isMixed(value);
    const displayColor = mixed ? undefined : (value || undefined);

    return (
        <Popover open={open} onOpenChange={onOpen}>
            <PopoverTrigger asChild>
                <button className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full">
                    <div
                        className="h-5 w-5 rounded border border-border shrink-0"
                        style={{backgroundColor: displayColor}}
                    >
                        {mixed && <span className="text-xs text-muted-foreground flex items-center justify-center h-full">—</span>}
                        {!mixed && !value && <span className="text-xs text-muted-foreground flex items-center justify-center h-full">∅</span>}
                    </div>
                    <span className="text-xs flex-1 text-left">{label}</span>
                    {!mixed && value && <span className="text-xs text-muted-foreground">{value}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <ColorPicker
                    value={mixed ? '#000000' : (value || '#000000')}
                    onChange={onChange}
                    showReset={showReset}
                />
            </PopoverContent>
        </Popover>
    );
}

function MergedNumberInput({value, onChange, min, max, step}: {
    value: MergedValue<number>;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
}) {
    const mixed = isMixed(value);
    const [localValue, setLocalValue] = useState(() => mixed ? '' : String(value ?? ''));
    const [focused, setFocused] = useState(false);

    const externalStr = mixed ? '' : String(value ?? '');
    if (!focused && localValue !== externalStr) {
        setLocalValue(externalStr);
    }

    return (
        <Input
            type="number"
            className="h-7 text-xs"
            value={focused ? localValue : externalStr}
            placeholder={mixed ? '—' : undefined}
            onChange={(e) => {
                const raw = e.target.value;
                setLocalValue(raw);
                if (raw !== '' && raw !== '-') {
                    const v = Number(raw);
                    if (!isNaN(v)) onChange(v);
                }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
                setFocused(false);
                if (localValue === '' || localValue === '-') {
                    setLocalValue(externalStr);
                }
            }}
            min={min}
            max={max}
            step={step}
        />
    );
}

function roundTo(n: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}
