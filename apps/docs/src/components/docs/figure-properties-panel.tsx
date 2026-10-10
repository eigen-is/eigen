import { type Editor, useEditorState } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
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

type FigurePropertiesPanelProps = {
    editor: Editor;
    onReplaceImage: (file: File) => void;
    onReplaceImageFromDrive?: (paths: DrivePath[]) => void;
};

export function FigurePropertiesPanel({ editor, onReplaceImage, onReplaceImageFromDrive }: FigurePropertiesPanelProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const [replacePickerOpen, setReplacePickerOpen] = useState(false);
    // useEditor re-renders on no transaction, and a write that keeps the figure selected fires no selectionUpdate.
    const { pos, layout, alignment, alt, caption, mediaName } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = e.getAttributes('figure');
            return {
                pos: e.state.selection.from,
                layout: (attrs.layout as FigureLayout) || 'block',
                alignment: (attrs.alignment as 'left' | 'center' | 'right') || 'center',
                alt: (attrs.alt as string) || '',
                caption: (attrs.caption as string) || '',
                mediaName: attrs.mediaName as string | undefined,
            };
        },
    });
    const previewUrl = mediaName ? resolveMediaUrl(mediaName) : null;
    // Enter commits and leaves the caret in the field, so the blur after it finds nothing new to write.
    const commitAlt = (value: string) => value !== alt && editor.commands.updateFigure({ alt: value });
    const commitCaption = (value: string) =>
        value !== caption && editor.commands.updateFigure({ caption: value || null });

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
                    <Input
                        key={pos}
                        className="h-7 text-xs"
                        defaultValue={alt}
                        placeholder="Alt text"
                        onBlur={(e) => commitAlt(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitAlt(e.currentTarget.value);
                        }}
                    />
                </PropertyRow>
                <PropertyRow label="Cap">
                    <Input
                        key={pos}
                        className="h-7 text-xs"
                        defaultValue={caption}
                        placeholder="Caption"
                        onBlur={(e) => commitCaption(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCaption(e.currentTarget.value);
                        }}
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
