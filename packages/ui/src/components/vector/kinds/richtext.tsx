// Rich text's UI entry. The typography rows, ported from slides' TextProperties: one home for "how does
// text look", so the deck shell and the drawing app cannot drift. The box background is the generic Fill
// row, its border the generic Stroke row — this section is the text itself.

import { DEFAULT_FONT_FAMILY, type VectorRichTextElement } from '@workspace/lib/vector';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import {
    AlignmentPicker,
    ColorRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/properties-panel';
import { Toggle } from '@workspace/ui/components/toggle';
import {
    AlignJustify,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    Bold,
    Italic,
    Strikethrough,
    Underline,
} from 'lucide-react';
import type { KindPanelSectionProps } from './index';

export function RichTextPanelSection({ elements, onChange }: KindPanelSectionProps) {
    const boxes = elements.filter((el): el is VectorRichTextElement => el.type === 'richtext');
    if (boxes.length === 0) return null;
    const fontFamily = getMergedValue(boxes, (el) => el.fontFamily);
    const fontSize = getMergedValue(boxes, (el) => el.fontSize);
    const fontWeight = getMergedValue(boxes, (el) => el.fontWeight);
    const fontStyle = getMergedValue(boxes, (el) => el.fontStyle);
    const textDecoration = getMergedValue(boxes, (el) => el.textDecoration);
    const textAlign = getMergedValue(boxes, (el) => el.textAlign);
    const verticalAlign = getMergedValue(boxes, (el) => el.verticalAlign);
    const color = getMergedValue(boxes, (el) => el.color);
    const letterSpacing = getMergedValue(boxes, (el) => el.letterSpacing);
    const lineHeight = getMergedValue(boxes, (el) => el.lineHeight);
    const highlightColor = getMergedValue(boxes, (el) => el.highlightColor);
    const padding = getMergedValue(boxes, (el) => el.padding);

    return (
        <>
            <PropertySection title="Text">
                <PropertyRow label="Font">
                    <FontPicker
                        value={isMixed(fontFamily) ? DEFAULT_FONT_FAMILY : (fontFamily ?? DEFAULT_FONT_FAMILY)}
                        onChange={(f) => onChange({ fontFamily: f })}
                        className="h-7 w-full text-xs"
                    />
                </PropertyRow>
                <PropertyRow label="Size">
                    <MergedNumberInput
                        value={fontSize}
                        onChange={(v) => onChange({ fontSize: v })}
                        min={8}
                        max={200}
                        step={1}
                    />
                </PropertyRow>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        aria-label="Bold"
                        pressed={fontWeight === 'bold'}
                        onPressedChange={(p) => onChange({ fontWeight: p ? 'bold' : 'normal' })}
                        data-mixed={isMixed(fontWeight) ? '' : undefined}
                    >
                        <Bold className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        aria-label="Italic"
                        pressed={fontStyle === 'italic'}
                        onPressedChange={(p) => onChange({ fontStyle: p ? 'italic' : 'normal' })}
                        data-mixed={isMixed(fontStyle) ? '' : undefined}
                    >
                        <Italic className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        aria-label="Underline"
                        pressed={textDecoration === 'underline'}
                        onPressedChange={(p) => onChange({ textDecoration: p ? 'underline' : 'none' })}
                        data-mixed={isMixed(textDecoration) ? '' : undefined}
                    >
                        <Underline className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        aria-label="Strikethrough"
                        pressed={textDecoration === 'line-through'}
                        onPressedChange={(p) => onChange({ textDecoration: p ? 'line-through' : 'none' })}
                    >
                        <Strikethrough className="h-4 w-4" />
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <AlignmentPicker
                        value={isMixed(textAlign) || textAlign === 'justify' ? undefined : textAlign}
                        onChange={(a) => onChange({ textAlign: a })}
                    />
                    {/* AlignmentPicker only handles left/center/right, so justify stays inline. */}
                    <Toggle
                        size="sm"
                        aria-label="Justify"
                        pressed={textAlign === 'justify'}
                        onPressedChange={() => onChange({ textAlign: 'justify' })}
                    >
                        <AlignJustify className="h-4 w-4" />
                    </Toggle>
                </div>

                <div className="flex items-center gap-1 pt-1">
                    <Toggle
                        size="sm"
                        aria-label="Align top"
                        pressed={verticalAlign === 'top'}
                        onPressedChange={() => onChange({ verticalAlign: 'top' })}
                    >
                        <AlignVerticalJustifyStart className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        aria-label="Align middle"
                        pressed={verticalAlign === 'center'}
                        onPressedChange={() => onChange({ verticalAlign: 'center' })}
                    >
                        <AlignVerticalJustifyCenter className="h-4 w-4" />
                    </Toggle>
                    <Toggle
                        size="sm"
                        aria-label="Align bottom"
                        pressed={verticalAlign === 'bottom'}
                        onPressedChange={() => onChange({ verticalAlign: 'bottom' })}
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
                            onChange={(v) => onChange({ letterSpacing: v })}
                            step={0.5}
                            min={-10}
                            max={50}
                        />
                    </PropertyRow>
                    <PropertyRow label="Line">
                        <MergedNumberInput
                            value={lineHeight}
                            onChange={(v) => onChange({ lineHeight: v })}
                            step={0.1}
                            min={0.5}
                            max={5}
                        />
                    </PropertyRow>
                </div>
                {/* The inset between the box edge and the text; the box keeps its stored size. */}
                <PropertyRow label="Pad">
                    <MergedNumberInput
                        value={padding}
                        onChange={(v) => onChange({ padding: v })}
                        step={1}
                        min={0}
                        max={200}
                    />
                </PropertyRow>
            </PropertySection>

            <PropertySection title="Color">
                <ColorRow label="Text" value={color} onChange={(c) => onChange({ color: c || '#000000' })} />
                <ColorRow
                    label="Highlight"
                    value={highlightColor}
                    onChange={(c) => onChange({ highlightColor: c })}
                    showReset
                />
            </PropertySection>
        </>
    );
}
