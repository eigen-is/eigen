import type { SheetFloatingItem } from '@workspace/lib/sheets';
import type { ZOp } from '@workspace/lib/vector';
import type { BeginGesture, PropertyHistory, TransformFields } from '@workspace/ui/components/properties-panel';
import {
    PropertiesPanel,
    PropertyGestureContext,
    PropertyHistoryContext,
    PropertySection,
    TransformSection,
    ZOrderButtons,
} from '@workspace/ui/components/properties-panel';
import type { ReactNode } from 'react';

type FloatingObjectPanelProps = {
    item: SheetFloatingItem;
    canWrite: boolean;
    aspectLocked: boolean;
    onAspectLockChange: (locked: boolean) => void;
    onChange: (fields: TransformFields) => void;
    onArrange: (op: ZOp) => void;
    // The workbook's undo gesture, so a typed field is one undo step.
    beginGesture: BeginGesture;
    // The workbook's undo and redo: a typed field keeps the caret outside the workbook's keydown, so it hands ⌘Z over.
    history: PropertyHistory;
    // A chart's own sections, between its Transform and Arrange.
    children?: ReactNode;
};

// Right-side panel for the selected image or chart, in the canvas panel's order: X/Y/W/H/° and Keep aspect
// ratio (the checkbox the corner grips follow), a chart's own sections, then Arrange. Delete is the menu's and the
// keyboard's, as on a canvas. Every edit is one op through the workbook's writers. A viewer gets a disabled read-out.
export function FloatingObjectPanel({
    item: { kind, object },
    canWrite,
    aspectLocked,
    onAspectLockChange,
    onChange,
    onArrange,
    beginGesture,
    history,
    children,
}: FloatingObjectPanelProps) {
    return (
        <PropertyGestureContext.Provider value={beginGesture}>
            <PropertyHistoryContext.Provider value={history}>
                <PropertiesPanel title={kind === 'image' ? 'Image' : 'Chart'}>
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
                    {canWrite && (
                        <>
                            {children}
                            <PropertySection title="Arrange">
                                <ZOrderButtons onApply={onArrange} />
                            </PropertySection>
                        </>
                    )}
                </PropertiesPanel>
            </PropertyHistoryContext.Provider>
        </PropertyGestureContext.Provider>
    );
}
