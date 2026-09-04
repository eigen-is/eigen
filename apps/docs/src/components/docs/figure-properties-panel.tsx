import type { Editor } from '@tiptap/react';
import type { FigureLayout } from '@workspace/lib/docs/eigendoc';
import { useMediaResolver } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
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
    const attrs = editor.getAttributes('figure');
    const layout = (attrs.layout as FigureLayout) || 'block';
    const alignment = (attrs.alignment as 'left' | 'center' | 'right') || 'center';
    const alt = (attrs.alt as string) || '';
    const caption = (attrs.caption as string) || '';
    const mediaName = attrs.mediaName as string | undefined;
    const previewUrl = mediaName ? resolveMediaUrl(mediaName) : null;

    return (
        <PropertiesPanel title="Image">
            {previewUrl && (
                <div className="px-3 py-3 border-b">
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
                            onPressedChange={() => editor.commands.updateAttributes('figure', { layout: 'block' })}
                        >
                            <Rows3 className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-left'}
                            onPressedChange={() => editor.commands.updateAttributes('figure', { layout: 'wrap-left' })}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </PropertyToggle>
                        <PropertyToggle
                            pressed={layout === 'wrap-right'}
                            onPressedChange={() => editor.commands.updateAttributes('figure', { layout: 'wrap-right' })}
                        >
                            <PanelRight className="h-4 w-4" />
                        </PropertyToggle>
                    </div>
                </PropertyRow>
                {layout === 'block' && (
                    <PropertyRow label="Align">
                        <AlignmentPicker
                            value={alignment}
                            onChange={(a) => editor.commands.updateAttributes('figure', { alignment: a })}
                        />
                    </PropertyRow>
                )}
            </PropertySection>

            <PropertySection title="Image">
                <PropertyRow label="Alt">
                    <Input
                        className="h-7 text-xs"
                        defaultValue={alt}
                        placeholder="Alt text"
                        onBlur={(e) => editor.commands.updateAttributes('figure', { alt: e.target.value })}
                    />
                </PropertyRow>
                <PropertyRow label="Cap">
                    <Input
                        className="h-7 text-xs"
                        defaultValue={caption}
                        placeholder="Caption"
                        onBlur={(e) => editor.commands.updateAttributes('figure', { caption: e.target.value || null })}
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
                    mimeFilter={['image/*']}
                    onPickFromDrive={(paths) => onReplaceImageFromDrive?.(paths)}
                    onPickFromDevice={(files) => files[0] && onReplaceImage(files[0])}
                    accept="image/*"
                />
            </PropertySection>
        </PropertiesPanel>
    );
}
