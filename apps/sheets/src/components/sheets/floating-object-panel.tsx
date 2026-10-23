import type { SheetFloatingItem } from '@workspace/lib/sheets';
import type { ZOp } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import {
    PropertiesPanel,
    PropertySection,
    type TransformFields,
    TransformSection,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import { ChartColumn, Trash2 } from 'lucide-react';

type FloatingTransformSectionProps = {
    item: SheetFloatingItem;
    canWrite: boolean;
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
    onChange: (fields: TransformFields) => void;
};

// The selected image's or chart's X/Y/W/H/° and Keep aspect ratio, the same checkbox the corner grips follow. A chart
// shows it in its own panel and at the end of its Chart editor. Read-only viewers get a disabled read-out.
export function FloatingTransformSection({
    item: { object },
    canWrite,
    aspectLocked,
    onAspectLockChange,
    onChange,
}: FloatingTransformSectionProps) {
    return (
        <TransformSection
            x={Math.round(object.x)}
            y={Math.round(object.y)}
            width={Math.round(object.width)}
            height={Math.round(object.height)}
            angle={object.angle ?? 0}
            onChange={onChange}
            disabled={!canWrite}
            aspectLocked={aspectLocked}
            onAspectLockChange={canWrite ? onAspectLockChange : undefined}
        />
    );
}

type FloatingObjectPanelProps = FloatingTransformSectionProps & {
    onArrange: (op: ZOp) => void;
    onEditChart: () => void;
    onDelete: () => void;
};

// Right-side panel for the selected image or chart. Composes the shared PropertiesPanel, TransformSection and
// ZOrderButtons, so the cluster matches Slides and Vector. Every edit is one op through the workbook's writers.
export function FloatingObjectPanel({ onArrange, onEditChart, onDelete, ...transform }: FloatingObjectPanelProps) {
    const { item, canWrite } = transform;
    return (
        <PropertiesPanel title={item.kind === 'image' ? 'Image' : 'Chart'}>
            <FloatingTransformSection {...transform} />
            {canWrite && (
                <>
                    <PropertySection title="Arrange">
                        <ZOrderButtons onApply={onArrange} />
                    </PropertySection>
                    <div className="app-gutter flex flex-col gap-2">
                        {item.kind === 'chart' && (
                            <Button variant="outline" size="sm" className="w-full" onClick={onEditChart}>
                                <ChartColumn className="h-3.5 w-3.5 mr-1.5" />
                                Edit chart
                            </Button>
                        )}
                        <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                            {item.kind === 'image' ? 'Delete image' : 'Delete chart'}
                        </Button>
                    </div>
                </>
            )}
        </PropertiesPanel>
    );
}
