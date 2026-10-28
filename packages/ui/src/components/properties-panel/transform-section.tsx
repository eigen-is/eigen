// The shared X, Y, W, H and angle fields of a canvas object's panel, with Keep aspect ratio, as a host such as Slides
// shows them. The section only presents. The host passes merged values in Box field names and its own units, and it
// writes each edit in one transaction, so a locked W or H edit is one write of both sides. The host also owns the lock,
// through useAspectLock, so the same choice drives ObjectTransform's grips. The lock is never stored on an element.

import { normalizeAngle } from '@workspace/lib/vector';
import { MergedNumberInput } from './merged-number-input';
import type { MergedValue } from './merged-value';
import { PropertyRow, PropertySection } from './properties-panel';
import { PropertyCheckbox } from './property-checkbox';
import { useCoupledSize } from './use-coupled-size';

// The geometry fields under their Box names. The host maps them to its own element update and units.
export type TransformFields = Partial<{
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
}>;

type TransformSectionProps = {
    x: MergedValue<number>;
    y: MergedValue<number>;
    width: MergedValue<number>;
    height: MergedValue<number>;
    angle: MergedValue<number>;
    onChange: (fields: TransformFields) => void;
    // Disables W and H for a selection whose size another value decides, such as Vector text, whose size follows
    // its font size. The aspect checkbox hides with them, as a lock means nothing when neither side can be edited,
    // and it must never override the forced 'aspect' mode of text.
    sizeDisabled?: boolean;
    // Disables the angle field alone, such as for an elbow arrow, whose angle is always 0.
    angleDisabled?: boolean;
    // Disables every field, for a read-only viewer, who still sees the values.
    disabled?: boolean;
    // Keep aspect ratio, controlled by the host. Without `onAspectLockChange` the checkbox is hidden.
    aspectLocked?: boolean;
    onAspectLockChange?: (locked: boolean) => void;
};

export function TransformSection({
    x,
    y,
    width,
    height,
    angle,
    onChange,
    sizeDisabled = false,
    angleDisabled = false,
    disabled = false,
    aspectLocked = false,
    onAspectLockChange,
}: TransformSectionProps) {
    const sizeOff = disabled || sizeDisabled;
    const showAspect = !sizeOff && onAspectLockChange !== undefined;

    const { changeWidth, changeHeight } = useCoupledSize(width, height, showAspect && aspectLocked, onChange);

    return (
        <PropertySection title="Transform">
            <div className="grid grid-cols-2 gap-2">
                <PropertyRow label="X" compact>
                    <MergedNumberInput value={x} onChange={(v) => onChange({ x: v })} step={1} disabled={disabled} />
                </PropertyRow>
                <PropertyRow label="Y" compact>
                    <MergedNumberInput value={y} onChange={(v) => onChange({ y: v })} step={1} disabled={disabled} />
                </PropertyRow>
                <PropertyRow label="W" compact>
                    <MergedNumberInput value={width} onChange={changeWidth} step={1} min={1} disabled={sizeOff} />
                </PropertyRow>
                <PropertyRow label="H" compact>
                    <MergedNumberInput value={height} onChange={changeHeight} step={1} min={1} disabled={sizeOff} />
                </PropertyRow>
            </div>
            {showAspect && (
                <PropertyCheckbox
                    label="Keep aspect ratio"
                    checked={aspectLocked}
                    onCheckedChange={(locked) => onAspectLockChange?.(locked)}
                />
            )}
            {/* The angle has no min or max, as the row takes an out-of-range entry and wraps it. A bound would clamp
                a typed -90 to 0 before normalizeAngle sees it. */}
            <PropertyRow label="Angle">
                <MergedNumberInput
                    value={angle}
                    onChange={(v) => onChange({ angle: normalizeAngle(v) })}
                    step={1}
                    disabled={disabled || angleDisabled}
                />
            </PropertyRow>
        </PropertySection>
    );
}
