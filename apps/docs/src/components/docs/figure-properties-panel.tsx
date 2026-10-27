// The Docs Image panel for the selected picture: its width, where it sits on the page and its caption, its alt text, and
// Replace image. It writes through the editor that holds the picture, the body's, a band's or a note's, and every
// write keeps the picture selected so the panel stays open. Its layout rows serve the Chart panel too.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { FigureAlignment, FigureFrameAttrs, FigureLayout } from '@workspace/lib/docs/eigendoc';
import { cmText, isPositioned, mmToPx, pxToMm, readCm, readFigureAttrs } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import {
    AlignmentPicker,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
    PropertyToggle,
} from '@workspace/ui/components/properties-panel';
import type { LucideIcon } from 'lucide-react';
import { BringToFront, ImagePlus, PanelLeft, PanelRight, Rows3, SendToBack } from 'lucide-react';
import { useState } from 'react';
import { clampFigureWidth, figureMaxWidth, setImageLayout } from './extensions/figure-frame';
import { inBand, selectionDrawsInLine } from './extensions/positioned-figure';

// Alt, Cap or Width. A keystroke starts a draft; Enter or a blur writes it if it differs from the value it started
// from, and Escape drops it. Until then the field shows the value as stored, a peer's write too, so a visit writes
// nothing back, and an unchanged Width keeps the stored px its cm rounds. A draft stays through a transaction that
// moves the figure, a collaborator typing above it.
export function FigureField({
    value,
    placeholder,
    type,
    onCommit,
}: {
    value: string;
    placeholder?: string;
    type?: 'number';
    onCommit: (value: string) => void;
}) {
    const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
    const commit = (next: string) => {
        if (draft !== null && next !== draft.base) onCommit(next);
        setDraft(null);
    };
    return (
        <Input
            className="h-7 text-xs"
            type={type}
            value={draft?.text ?? value}
            placeholder={placeholder}
            onChange={(e) => setDraft({ text: e.target.value, base: draft?.base ?? value })}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') commit(e.currentTarget.value);
                if (e.key === 'Escape') setDraft(null);
            }}
        />
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
// The section also holds its caption, which a figure behind or in front of the text doesn't draw. A figure in a band
// offers the alignment alone, so a pasted wrap goes back to its own line. A figure in a note or a table cell draws in
// line, so there the section offers no place behind or in front of the text.
export function FigureLayoutSection({
    layout,
    alignment,
    caption,
    inBand = false,
    inFlowOnly,
    onChange,
}: {
    layout: FigureLayout;
    alignment: FigureAlignment;
    caption: string;
    inBand?: boolean;
    inFlowOnly: boolean;
    onChange: (attributes: FigureFrameAttrs) => void;
}) {
    return (
        <PropertySection title="Layout">
            {!inBand && (
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
            {(inBand || layout === 'block') && (
                <PropertyRow label="Align">
                    <AlignmentPicker
                        value={layout === 'block' ? alignment : undefined}
                        onChange={(a) =>
                            onChange(layout === 'block' ? { alignment: a } : { layout: 'block', alignment: a })
                        }
                    />
                </PropertyRow>
            )}
            {!isPositioned(layout) && (
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
    const { width, layout, alignment, alt, caption, mediaName, inFlowOnly } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = readFigureAttrs(e.getAttributes('figure'));
            return {
                width: attrs.width,
                layout: attrs.layout || 'block',
                alignment: attrs.alignment || 'center',
                alt: attrs.alt || '',
                caption: attrs.caption || '',
                mediaName: attrs.mediaName,
                inFlowOnly: selectionDrawsInLine(e),
            };
        },
    });
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

            <PropertySection title="Size">
                <PropertyRow label="Width">
                    <div className="flex items-center gap-1.5">
                        <FigureField
                            type="number"
                            value={width == null ? '' : cmText(pxToMm(width), 1)}
                            onCommit={(value) => {
                                const mm = readCm(value);
                                if (!Number.isFinite(mm)) return;
                                editor.commands.updateFigure({
                                    width: clampFigureWidth(mmToPx(mm), figureMaxWidth(editor, layout)),
                                });
                            }}
                        />
                        <span className="text-xs text-muted-foreground">cm</span>
                    </div>
                </PropertyRow>
            </PropertySection>

            <FigureLayoutSection
                layout={layout}
                alignment={alignment}
                caption={caption}
                inBand={inBand(editor)}
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
