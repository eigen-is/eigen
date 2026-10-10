import { type Editor, useEditorState } from '@tiptap/react';
import { readFigureAttrs } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
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

// Alt or Cap. Enter or a blur writes a changed value; Enter leaves the caret in the field, so the blur after it
// finds nothing new. While it has focus it shows its draft, so a transaction that moves the figure, a
// collaborator typing above it, neither resets nor blurs it.
function FigureTextField({
    value,
    placeholder,
    onCommit,
}: {
    value: string;
    placeholder: string;
    onCommit: (value: string) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = (next: string) => next !== value && onCommit(next);
    return (
        <Input
            className="h-7 text-xs"
            value={draft ?? value}
            placeholder={placeholder}
            onFocus={() => setDraft(value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => {
                commit(e.target.value);
                setDraft(null);
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit(e.currentTarget.value);
            }}
        />
    );
}

type FigurePropertiesPanelProps = {
    editor: Editor;
    onReplaceImage: (file: File) => void;
    onReplaceImageFromDrive?: (paths: DrivePath[]) => void;
};

export function FigurePropertiesPanel({ editor, onReplaceImage, onReplaceImageFromDrive }: FigurePropertiesPanelProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const [replacePickerOpen, setReplacePickerOpen] = useState(false);
    // useEditor re-renders on no transaction, and a write that keeps the figure selected fires no selectionUpdate.
    const { layout, alignment, alt, caption, mediaName } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = readFigureAttrs(e.getAttributes('figure'));
            return {
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

            <PropertySection title="Layout">
                <PropertyRow label="Style">
                    <div className="flex items-center gap-1">
                        <PropertyToggle
                            pressed={layout === 'block'}
                            onPressedChange={() => editor.commands.updateFigure({ layout: 'block' })}
                        >
                            <Rows3 className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-left'}
                            onPressedChange={() => editor.commands.updateFigure({ layout: 'wrap-left' })}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-right'}
                            onPressedChange={() => editor.commands.updateFigure({ layout: 'wrap-right' })}
                        >
                            <PanelRight className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
                {layout === 'block' && (
                    <PropertyRow label="Align">
                        <AlignmentPicker
                            value={alignment}
                            onChange={(a) => editor.commands.updateFigure({ alignment: a })}
                        />
                    </PropertyRow>
                )}
            </PropertySection>

            <PropertySection title="Image">
                <PropertyRow label="Alt">
                    <FigureTextField
                        value={alt}
                        placeholder="Alt text"
                        onCommit={(value) => editor.commands.updateFigure({ alt: value || null })}
                    />
                </PropertyRow>
                <PropertyRow label="Cap">
                    <FigureTextField
                        value={caption}
                        placeholder="Caption"
                        onCommit={(value) => editor.commands.updateFigure({ caption: value || null })}
                    />
                </PropertyRow>
                <Button variant="outline" size="sm" className="w-full mt-1" onClick={() => setReplacePickerOpen(true)}>
                    <ImagePlus className="h-3.5 w-3.5 mr-1.5" />
                    Replace image
                </Button>
                <DrivePickerWithUpload
                    open={replacePickerOpen}
                    onOpenChange={setReplacePickerOpen}
                    title="Replace image"
                    canPick={(item) => isImageMime(item.mimeType)}
                    onPickFromDrive={(paths) => onReplaceImageFromDrive?.(paths)}
                    onPickFromDevice={(files) => files[0] && onReplaceImage(files[0])}
                    accept="image/*"
                />
            </PropertySection>
        </PropertiesPanel>
    );
}
