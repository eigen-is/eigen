import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { FigureAlignment, FigureFrameAttrs, FigureLayout } from '@workspace/lib/docs/eigendoc';
import { cmText, mmToPx, pxToMm, readCm, readFigureAttrs } from '@workspace/lib/docs/eigendoc';
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
import { ImagePlus, PanelLeft, PanelRight, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { clampFigureWidth, figureMaxWidth, widthWithinLayout } from './extensions/figure-frame';

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

// Where a figure sits: in its own line, aligned, or wrapped by the text on one side. A band holds no float, as a docx
// import reads a header's anchored picture as one in its own line, so a band's offers the alignment alone, which puts a
// pasted wrap in its own line.
export function FigureLayoutSection({
    layout,
    alignment,
    blockOnly = false,
    onChange,
}: {
    layout: FigureLayout;
    alignment: FigureAlignment;
    blockOnly?: boolean;
    onChange: (attributes: FigureFrameAttrs) => void;
}) {
    return (
        <PropertySection title="Layout">
            {!blockOnly && (
                <PropertyRow label="Style">
                    <div className="flex items-center gap-1">
                        <PropertyToggle
                            pressed={layout === 'block'}
                            onPressedChange={() => onChange({ layout: 'block' })}
                        >
                            <Rows3 className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-left'}
                            onPressedChange={() => onChange({ layout: 'wrap-left' })}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-right'}
                            onPressedChange={() => onChange({ layout: 'wrap-right' })}
                        >
                            <PanelRight className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
            )}
            {(blockOnly || layout === 'block') && (
                <PropertyRow label="Align">
                    <AlignmentPicker
                        value={layout === 'block' ? alignment : undefined}
                        onChange={(a) =>
                            onChange(layout === 'block' ? { alignment: a } : { layout: 'block', alignment: a })
                        }
                    />
                </PropertyRow>
            )}
        </PropertySection>
    );
}

type FigurePropertiesPanelProps = {
    editor: Editor;
    blockOnly?: boolean;
    onReplaceImage: () => void;
};

export function FigurePropertiesPanel({ editor, blockOnly, onReplaceImage }: FigurePropertiesPanelProps) {
    const { resolveMediaUrl } = useMediaResolver();
    // useEditor re-renders on no transaction, and a write that keeps the figure selected fires no selectionUpdate.
    const { width, layout, alignment, alt, caption, mediaName } = useEditorState({
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
                                    width: clampFigureWidth(mmToPx(mm), figureMaxWidth(editor.view.dom, layout)),
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
                blockOnly={blockOnly}
                onChange={(attributes) => {
                    const fitted = widthWithinLayout(editor.view.dom, attributes.layout, width);
                    editor.commands.updateFigure(fitted === undefined ? attributes : { ...attributes, width: fitted });
                }}
            />

            <PropertySection title="Image">
                <PropertyRow label="Alt">
                    <FigureField
                        value={alt}
                        placeholder="Alt text"
                        onCommit={(value) => editor.commands.updateFigure({ alt: value || null })}
                    />
                </PropertyRow>
                <PropertyRow label="Cap">
                    <FigureField
                        value={caption}
                        placeholder="Caption"
                        onCommit={(value) => editor.commands.updateFigure({ caption: value || null })}
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
