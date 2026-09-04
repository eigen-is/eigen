// Rich text's UI entry: the in-place editor the canvas mounts inside the element's own layer, and the
// typography rows ported from slides' TextProperties — one home for "how does text look", so the deck
// shell and the drawing app cannot drift. The box background is the generic Fill row, its border the
// generic Stroke row; this section is the text itself.

import {
    ELEMENT_KINDS,
    richTextCssText,
    VECTOR_STYLE_DEFAULTS,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import {
    AlignmentPicker,
    ColorRow,
    FontRow,
    getMergedValue,
    isMixed,
    MergedNumberInput,
    PropertyRow,
    PropertySection,
    PropertyToggle,
} from '@workspace/ui/components/properties-panel';
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
import { useLayoutEffect, useRef } from 'react';
import type { InPlaceEditorProps, KindPanelSectionProps } from './index';

// The box the user types in IS the box the renderer paints: same CSS string, applied through
// setAttribute because React's `style` prop takes an object and an object form of the builder would be a
// second source of truth for typography and paint. Every keystroke writes `html` straight through, so
// the session coalesces into one undo step and peers see it live.
export function RichTextInPlaceEditor({ element, onChange, onExit }: InPlaceEditorProps) {
    const boxRef = useRef<HTMLDivElement>(null);
    // Not a state mirror: the element's own paint/typography, re-applied when a panel row changes it
    // mid-session. React never manages this attribute, so nothing fights over it.
    const css = element.type === 'richtext' ? richTextCssText(element) : '';
    // Layout effect, not an effect: the box would otherwise paint once unstyled before the CSS lands,
    // flashing the text at the app's font on every session open.
    useLayoutEffect(() => {
        boxRef.current?.setAttribute('style', css);
    }, [css]);

    if (element.type !== 'richtext') return null;
    return (
        <div
            ref={boxRef}
            className="pointer-events-auto"
            // The canvas hit-tests on the container; a pointer inside the editor is the editor's, and a
            // double-click here must not re-open a session over the open one.
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                // The text-edit layer of the layered Escape stack (CANVAS.md): claimed here, so the
                // canvas' own document listener never sees it while a session is open.
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    onExit();
                }
            }}
        >
            <LightEditor
                content={element.html}
                onChange={(html) => onChange({ html })}
                toolbar="floating"
                proseStyle={false}
                className="min-h-0 break-words"
                containerClassName="relative flex flex-col w-full"
                onReady={({ editor }) => editor.chain().focus('end').run()}
            />
        </div>
    );
}

// What a reset restores: the values CREATING a box would have given it, never a literal typed here.
const RICHTEXT_DEFAULTS = ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS);

export function RichTextPanelSection({ elements, onChange }: KindPanelSectionProps) {
    // The panel mounts a kind's section only for a SOLE-kind selection, so this narrows rather than filters.
    const boxes = elements.filter((el): el is VectorRichTextElement => el.type === 'richtext');
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
    const padding = getMergedValue(boxes, (el) => el.padding);

    return (
        <>
            <PropertySection title="Text">
                <FontRow value={fontFamily} onChange={(f) => onChange({ fontFamily: f })} />
                <PropertyRow label="Size">
                    <MergedNumberInput
                        value={fontSize}
                        onChange={(v) => onChange({ fontSize: v })}
                        min={8}
                        max={200}
                        step={1}
                    />
                </PropertyRow>
                <ColorRow
                    label="Color"
                    value={color}
                    onChange={(c) => onChange({ color: c || RICHTEXT_DEFAULTS.color })}
                />
                <PropertyRow label="Style">
                    <div className="flex items-center gap-1">
                        <PropertyToggle
                            aria-label="Bold"
                            pressed={fontWeight === 'bold'}
                            onPressedChange={(p) => onChange({ fontWeight: p ? 'bold' : 'normal' })}
                            data-mixed={isMixed(fontWeight) ? '' : undefined}
                        >
                            <Bold className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Italic"
                            pressed={fontStyle === 'italic'}
                            onPressedChange={(p) => onChange({ fontStyle: p ? 'italic' : 'normal' })}
                            data-mixed={isMixed(fontStyle) ? '' : undefined}
                        >
                            <Italic className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Underline"
                            pressed={textDecoration === 'underline'}
                            onPressedChange={(p) => onChange({ textDecoration: p ? 'underline' : 'none' })}
                            data-mixed={isMixed(textDecoration) ? '' : undefined}
                        >
                            <Underline className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Strikethrough"
                            pressed={textDecoration === 'line-through'}
                            onPressedChange={(p) => onChange({ textDecoration: p ? 'line-through' : 'none' })}
                        >
                            <Strikethrough className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
                <PropertyRow label="Align">
                    <div className="flex items-center gap-1">
                        <AlignmentPicker
                            value={isMixed(textAlign) || textAlign === 'justify' ? undefined : textAlign}
                            onChange={(a) => onChange({ textAlign: a })}
                        />
                        {/* AlignmentPicker only handles left/center/right, so justify stays inline. */}
                        <PropertyToggle
                            aria-label="Justify"
                            pressed={textAlign === 'justify'}
                            onPressedChange={() => onChange({ textAlign: 'justify' })}
                        >
                            <AlignJustify className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
                <PropertyRow label="Vertical">
                    <div className="flex items-center gap-1">
                        <PropertyToggle
                            aria-label="Align top"
                            pressed={verticalAlign === 'top'}
                            onPressedChange={() => onChange({ verticalAlign: 'top' })}
                        >
                            <AlignVerticalJustifyStart className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Align middle"
                            pressed={verticalAlign === 'center'}
                            onPressedChange={() => onChange({ verticalAlign: 'center' })}
                        >
                            <AlignVerticalJustifyCenter className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            aria-label="Align bottom"
                            pressed={verticalAlign === 'bottom'}
                            onPressedChange={() => onChange({ verticalAlign: 'bottom' })}
                        >
                            <AlignVerticalJustifyEnd className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
            </PropertySection>

            <PropertySection title="Spacing">
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
                {/* The inset between the box edge and the text; the box keeps its stored size. */}
                <PropertyRow label="Padding">
                    <MergedNumberInput
                        value={padding}
                        onChange={(v) => onChange({ padding: v })}
                        step={1}
                        min={0}
                        max={200}
                    />
                </PropertyRow>
            </PropertySection>
        </>
    );
}
