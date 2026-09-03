// The slide's own background, plus the scope it applies to. Mounted in the engine panel's
// no-selection slot (CanvasPropertiesPanel's `emptySection`), because "this and following" is deck
// vocabulary the engine must not speak. The paint itself is the shared BackgroundFillBlock — a frame
// background is the same BackgroundFill an element fill is, one codec, one editor.

import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import { serializeBackgroundFill, type VectorFrame } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { BackgroundFillBlock } from '@workspace/ui/components/properties-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useCallback, useState } from 'react';
import { type ApplyTo, targetFrameIds } from './apply-to';

type SlideBackgroundPanelProps = {
    frames: VectorFrame[];
    frameId: string;
    background: BackgroundFill | null;
    backgroundImageUrl: string | null;
    updateFrames: (patches: { id: string; fields: Partial<VectorFrame> }[]) => void;
    onUploadImage: (file: File) => Promise<string | null>;
    onPickImageFromDrive: (paths: DrivePath[]) => void;
};

export function SlideBackgroundPanel({
    frames,
    frameId,
    background,
    backgroundImageUrl,
    updateFrames,
    onUploadImage,
    onPickImageFromDrive,
}: SlideBackgroundPanelProps) {
    const [applyTo, setApplyTo] = useState<ApplyTo>('this');
    const [pickerOpen, setPickerOpen] = useState(false);

    // Editing paints THIS slide; the Apply button re-sends the current paint at the chosen scope, so
    // "all slides" is an explicit act rather than something a colour drag does to the whole deck.
    const write = useCallback(
        (next: BackgroundFill | null, scope: ApplyTo) => {
            const value = serializeBackgroundFill(next);
            updateFrames(targetFrameIds(frames, frameId, scope).map((id) => ({ id, fields: { background: value } })));
        },
        [frames, frameId, updateFrames],
    );

    const handleImageFromDevice = useCallback(
        async (files: File[]) => {
            const file = files[0];
            if (!file) return;
            const mediaName = await onUploadImage(file);
            if (mediaName) write({ type: 'image', mediaName, fit: 'cover' }, 'this');
        },
        [onUploadImage, write],
    );

    return (
        <>
            <BackgroundFillBlock
                value={background}
                onChange={(next) => write(next, 'this')}
                onPickImage={() => setPickerOpen(true)}
                imagePreviewUrl={backgroundImageUrl}
            />

            <div className="px-3 py-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Apply to</h4>
                <div className="flex gap-2">
                    <Select value={applyTo} onValueChange={(value) => setApplyTo(toApplyTo(value))}>
                        <SelectTrigger size="sm" className="text-xs flex-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="this">This slide</SelectItem>
                            <SelectItem value="this-and-following">This and following</SelectItem>
                            <SelectItem value="all">All slides</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 text-xs" onClick={() => write(background, applyTo)}>
                        Apply
                    </Button>
                </div>
            </div>

            <DrivePickerWithUpload
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                title="Background image"
                mimeFilter={['image/*']}
                onPickFromDrive={onPickImageFromDrive}
                onPickFromDevice={handleImageFromDevice}
                accept="image/*"
            />
        </>
    );
}

// Radix hands back a plain string; narrow it rather than casting.
function toApplyTo(value: string): ApplyTo {
    return value === 'all' || value === 'this-and-following' ? value : 'this';
}
