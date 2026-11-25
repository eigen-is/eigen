// The current slide's background, with two buttons that copy it to the following slides or to all of them. The
// editor mounts it in the side panel's slot for when nothing is selected, because "following slides" is deck
// vocabulary the canvas engine must not speak. The paint itself is the shared BackgroundFillBlock, since a slide
// background is the same BackgroundFill an element fill is.

import type { BackgroundFill } from '@workspace/lib/types/background';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/file-kinds';
import type { VectorFrame } from '@workspace/lib/vector';
import { serializeBackgroundFill } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { BackgroundFillBlock } from '@workspace/ui/components/properties-panel';
import { useCallback, useState } from 'react';
import type { ApplyTo } from './apply-to';
import { targetFrameIds } from './apply-to';

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
    const [pickerOpen, setPickerOpen] = useState(false);

    // A pick paints this slide only, so a color drag never repaints the deck; a button copies the paint on.
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
                keepChildren
            >
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full text-xs"
                    onClick={() => write(background, 'this-and-following')}
                >
                    Apply to following slides
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full text-xs"
                    onClick={() => write(background, 'all')}
                >
                    Apply to all slides
                </Button>
            </BackgroundFillBlock>

            <DrivePickerWithUpload
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                title="Background image"
                canPick={(item) => isImageMime(item.mimeType)}
                onPickFromDrive={onPickImageFromDrive}
                onPickFromDevice={handleImageFromDevice}
                accept="image/*"
            />
        </>
    );
}
