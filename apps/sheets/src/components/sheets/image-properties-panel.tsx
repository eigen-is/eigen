import type { Image as SheetImage } from '@workspace/sheet';
import { Button } from '@workspace/ui/components/button';
import { PropertiesPanel, type TransformFields, TransformSection } from '@workspace/ui/components/properties-panel';
import { Trash2 } from 'lucide-react';

type ImagePropertiesPanelProps = {
    image: SheetImage;
    canWrite: boolean;
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
    onChange: (fields: TransformFields) => void;
    onDelete: () => void;
};

// Right-side panel for the active floating image (U4h). Composes the shared PropertiesPanel +
// TransformSection so the numeric X/Y/W/H/° cluster and the keep-aspect checkbox match slides/vector.
// Every edit is one op (writes through the workbook's updateImage path). Read-only viewers get a
// disabled read-out.
export function ImagePropertiesPanel({
    image,
    canWrite,
    aspectLocked,
    onAspectLockChange,
    onChange,
    onDelete,
}: ImagePropertiesPanelProps) {
    return (
        <PropertiesPanel title="Image">
            <TransformSection
                x={Math.round(image.x)}
                y={Math.round(image.y)}
                width={Math.round(image.width)}
                height={Math.round(image.height)}
                angle={image.angle ?? 0}
                onChange={onChange}
                disabled={!canWrite}
                aspectLocked={aspectLocked}
                onAspectLockChange={canWrite ? onAspectLockChange : undefined}
            />
            {canWrite && (
                <div className="px-3 py-3">
                    <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                        Delete image
                    </Button>
                </div>
            )}
        </PropertiesPanel>
    );
}
