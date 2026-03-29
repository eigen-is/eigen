import type { Editor } from '@tiptap/react';
import { useMediaResolver } from '@workspace/lib/drive';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import {
    AlignmentPicker,
    PropertiesPanel,
    PropertyRow,
    PropertySection,
} from '@workspace/ui/components/layout/properties-panel';
import { ImagePlus } from 'lucide-react';
import { useRef } from 'react';

type FigurePropertiesPanelProps = {
    editor: Editor;
    onReplaceImage: (file: File) => void;
};

export function FigurePropertiesPanel({ editor, onReplaceImage }: FigurePropertiesPanelProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attrs = editor.getAttributes('figure');
    const alignment = (attrs.alignment as 'left' | 'center' | 'right') || 'center';
    const alt = (attrs.alt as string) || '';
    const caption = (attrs.caption as string) || '';
    const mediaName = attrs.mediaName as string | undefined;
    const previewUrl = mediaName ? resolveMediaUrl(mediaName) : null;

    return (
        <PropertiesPanel>
            <div className="px-3 py-2 border-b">
                <span className="text-sm font-medium">Image</span>
            </div>

            {previewUrl && (
                <div className="px-3 py-3 border-b">
                    <div className="rounded border overflow-hidden">
                        <img src={previewUrl} alt="" className="max-h-24 mx-auto object-contain" />
                    </div>
                </div>
            )}

            <PropertySection title="Layout">
                <PropertyRow label="Align">
                    <AlignmentPicker
                        value={alignment}
                        onChange={(a) => editor.commands.updateAttributes('figure', { alignment: a })}
                    />
                </PropertyRow>
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
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-1"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <ImagePlus className="h-3.5 w-3.5 mr-1.5" />
                    Replace image
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) onReplaceImage(file);
                        e.target.value = '';
                    }}
                />
            </PropertySection>
        </PropertiesPanel>
    );
}
