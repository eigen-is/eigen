// The Docs Image panel for the selected picture: its size, where it sits on the page and its caption, its alt text, and
// Replace image. It writes through the editor that holds the picture, the body's, a band's or a note's, and every
// write keeps the picture selected so the panel stays open. Its size and layout sections serve the Chart panel too.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { FigureAlignment, FigureFrameAttrs, FigureLayout } from '@workspace/lib/docs/eigendoc';
import { cmText, isPositioned, mmToPx, pxToMm, readCm, readFigureAttrs } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import type { CoupledSize } from '@workspace/ui/components/properties-panel';
import {
    AlignmentPicker,
    numberAtStep,
    PropertiesPanel,
    PropertyCheckbox,
    PropertyRow,
    PropertySection,
    PropertyToggle,
    useCoupledSize,
} from '@workspace/ui/components/properties-panel';
import type { LucideIcon } from 'lucide-react';
import { BringToFront, ImagePlus, PanelLeft, PanelRight, Rows3, SendToBack } from 'lucide-react';
import { useState } from 'react';
import { pictureRatio } from './extensions/figure';
import {
    figureMaxWidth,
    fitFigureSize,
    isAspectLocked,
    setAspectLocked,
    setImageLayout,
} from './extensions/figure-frame';
import { inBand, selectionDrawsInLine } from './extensions/positioned-figure';

// Alt, Cap, Width or Height. A keystroke starts a draft. Enter or a blur writes it if it differs from the value it
// started from, and Escape drops it. Until then the field shows the value as stored, a peer's write too, so a visit
// writes nothing back, and an untouched Width keeps the stored px its cm rounds. A number field shows its value at its
// step, as the panels' number fields do, and a draft as typed. A draft stays through a transaction that moves the
// figure, such as a collaborator typing above it.
export function FigureField({
    value,
    placeholder,
    type,
    step,
    onCommit,
}: {
    value: string;
    placeholder?: string;
    type?: 'number';
    step?: number;
    onCommit: (value: string) => void;
}) {
    const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
    const shown = step === undefined || value === '' ? value : numberAtStep(Number(value), step);
    const commit = (next: string) => {
        if (draft !== null && next !== draft.base) onCommit(next);
        setDraft(null);
    };
    return (
        <Input
            className="h-7 text-xs"
            type={type}
            step={step}
            value={draft?.text ?? shown}
            placeholder={placeholder}
            onChange={(e) => setDraft({ text: e.target.value, base: draft?.base ?? shown })}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') commit(e.currentTarget.value);
                if (e.key === 'Escape') setDraft(null);
            }}
        />
    );
}

// A side in cm to 0.01, written in px with the fraction the cm gives, so a typed 8 cm reads back as 8.00. A side is at
// least a pixel, and the host floors a width further.
export function CmField({ px, onCommit }: { px: number | undefined; onCommit: (px: number) => void }) {
    return (
        <div className="flex items-center gap-1.5">
            <FigureField
                type="number"
                step={0.01}
                value={px === undefined ? '' : cmText(pxToMm(px), 2)}
                onCommit={(value) => {
                    const mm = readCm(value);
                    if (Number.isFinite(mm)) onCommit(Math.max(1, mmToPx(mm)));
                }}
            />
            <span className="text-xs text-muted-foreground">cm</span>
        </div>
    );
}

// A figure's width and height as it draws, with Keep aspect ratio. Each side has a row of its own, as a cm field and
// its unit don't fit half the panel. While the box is checked an edit of one side writes the other at the figure's
// ratio. The host fits the size to the page and decides what it stores. A text box has no ratio to keep, and an auto
// height instead, which grows with its text.
export function FigureSizeSection({
    width,
    height,
    aspect,
    autoHeight,
    onChange,
}: {
    width: number | undefined;
    height: number | undefined;
    aspect?: { locked: boolean; onLockChange: (locked: boolean) => void };
    autoHeight?: { auto: boolean; onAutoChange: (auto: boolean) => void };
    onChange: (size: CoupledSize) => void;
}) {
    const { changeWidth, changeHeight } = useCoupledSize(width, height, aspect?.locked ?? false, onChange);
    return (
        <PropertySection title="Size">
            <PropertyRow label="Width">
                <CmField px={width} onCommit={changeWidth} />
            </PropertyRow>
            <PropertyRow label="Height">
                <CmField px={height} onCommit={changeHeight} />
            </PropertyRow>
            {aspect && (
                <PropertyCheckbox
                    label="Keep aspect ratio"
                    checked={aspect.locked}
                    onCheckedChange={aspect.onLockChange}
                />
            )}
            {autoHeight && (
                <PropertyCheckbox
                    label="Grow with text"
                    checked={autoHeight.auto}
                    onCheckedChange={autoHeight.onAutoChange}
                />
            )}
        </PropertySection>
    );
}

// Each layout's name and icon, in Google's order.
const FIGURE_LAYOUT_LOOK: { layout: FigureLayout; label: string; icon: LucideIcon }[] = [
    { layout: 'block', label: 'In line', icon: Rows3 },
    { layout: 'wrap-left', label: 'Wrap left', icon: PanelLeft },
    { layout: 'wrap-right', label: 'Wrap right', icon: PanelRight },
    { layout: 'behind', label: 'Behind text', icon: SendToBack },
    { layout: 'front', label: 'In front of text', icon: BringToFront },
];

// The layouts the panel's toggles and Format › Image offer: those in the flow alone where every figure draws in line.
export const figureLayoutLooks = (inFlowOnly: boolean) =>
    FIGURE_LAYOUT_LOOK.filter(({ layout }) => !inFlowOnly || !isPositioned(layout));

// Where a figure sits: in its own line, aligned, wrapped by the text on one side, or behind or in front of the text.
// The section also holds its caption, which a figure behind or in front of the text doesn't draw and a text box has
// none of. A figure in a band offers the alignment alone, so a pasted wrap goes back to its own line. A figure in a
// note or a table cell draws in line, so there the section offers no place behind or in front of the text.
export function FigureLayoutSection({
    layout,
    alignment,
    caption,
    alignOnly = false,
    inFlowOnly,
    onChange,
}: {
    layout: FigureLayout;
    alignment: FigureAlignment;
    caption?: string;
    alignOnly?: boolean;
    inFlowOnly: boolean;
    onChange: (attributes: FigureFrameAttrs) => void;
}) {
    return (
        <PropertySection title="Layout">
            {!alignOnly && (
                <PropertyRow label="Style">
                    <div className="flex items-center gap-1">
                        {figureLayoutLooks(inFlowOnly).map(({ layout: option, label, icon: Icon }) => (
                            <PropertyToggle
                                key={option}
                                aria-label={label}
                                title={label}
                                pressed={layout === option}
                                onPressedChange={() => onChange({ layout: option })}
                            >
                                <Icon className="h-4 w-4" />
                            </PropertyToggle>
                        ))}
                    </div>
                </PropertyRow>
            )}
            {(alignOnly || layout === 'block') && (
                <PropertyRow label="Align">
                    <AlignmentPicker
                        value={layout === 'block' ? alignment : undefined}
                        onChange={(a) =>
                            onChange(layout === 'block' ? { alignment: a } : { layout: 'block', alignment: a })
                        }
                    />
                </PropertyRow>
            )}
            {caption !== undefined && !isPositioned(layout) && (
                <PropertyRow label="Cap">
                    <FigureField
                        value={caption}
                        placeholder="Caption"
                        onCommit={(value) => onChange({ caption: value || null })}
                    />
                </PropertyRow>
            )}
        </PropertySection>
    );
}

type FigurePropertiesPanelProps = {
    editor: Editor;
    onReplaceImage: () => void;
};

export function FigurePropertiesPanel({ editor, onReplaceImage }: FigurePropertiesPanelProps) {
    const { resolveMediaUrl } = useMediaResolver();
    // useEditor re-renders on no transaction, and a write that keeps the figure selected fires no selectionUpdate.
    const { width, height, stretched, locked, layout, alignment, alt, caption, mediaName, inFlowOnly } = useEditorState(
        {
            editor,
            selector: ({ editor: e }) => {
                const attrs = readFigureAttrs(e.getAttributes('figure'));
                // With no height stored, the picture draws at its own ratio, which its <img> knows once loaded.
                const ratio = attrs.height ? null : pictureRatio(e.view, e.state.selection.from);
                return {
                    width: attrs.width ?? undefined,
                    height: attrs.height ?? (attrs.width && ratio ? attrs.width / ratio : undefined),
                    stretched: attrs.height !== null,
                    locked: isAspectLocked(e.state, 'figure'),
                    layout: attrs.layout || 'block',
                    alignment: attrs.alignment || 'center',
                    alt: attrs.alt || '',
                    caption: attrs.caption || '',
                    mediaName: attrs.mediaName,
                    inFlowOnly: selectionDrawsInLine(e),
                };
            },
        },
    );
    const previewUrl = mediaName ? resolveMediaUrl(mediaName) : null;

    return (
        <PropertiesPanel title="Image">
            {previewUrl && (
                <div className="app-gutter border-b">
                    <div className="rounded border overflow-hidden">
                        <img src={previewUrl} alt="" className="max-h-24 mx-auto object-contain" />
                    </div>
                </div>
            )}

            <FigureSizeSection
                width={width}
                height={height}
                aspect={{ locked, onLockChange: (next) => setAspectLocked(editor, 'figure', next) }}
                onChange={(size) => {
                    // A picture at its own ratio stores its width alone, so it keeps that ratio wherever it draws. An
                    // edit that stretches it, or one of a picture already stretched, stores both sides.
                    const asked =
                        locked && !stretched
                            ? { width: size.width }
                            : { width: size.width ?? width, height: size.height ?? height };
                    // With no width stored, the picture draws at the width its <img> takes, which a height alone would
                    // stretch once a width is stored.
                    if (asked.width === undefined) return;
                    editor.commands.updateFigure(fitFigureSize(asked, figureMaxWidth(editor, layout)));
                }}
            />

            <FigureLayoutSection
                layout={layout}
                alignment={alignment}
                caption={caption}
                alignOnly={inBand(editor)}
                inFlowOnly={inFlowOnly}
                onChange={(attributes) => setImageLayout(editor, attributes)}
            />

            <PropertySection title="Image">
                <PropertyRow label="Alt">
                    <FigureField
                        value={alt}
                        placeholder="Alt text"
                        onCommit={(value) => editor.commands.updateFigure({ alt: value || null })}
                    />
                </PropertyRow>
                <Button variant="outline" size="sm" className="w-full mt-1" onClick={onReplaceImage}>
                    <ImagePlus className="h-3.5 w-3.5 mr-1.5" />
                    Replace image
                </Button>
            </PropertySection>
        </PropertiesPanel>
    );
}
