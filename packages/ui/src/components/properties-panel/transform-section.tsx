// The shared X, Y, W, H and angle fields of a canvas object's panel, with Keep aspect ratio, as Slides, Vector and
// Sheets show them. It only presents: the host passes merged values in Box field names and its own units, and writes
// each edit in one transaction, a locked W or H edit as one width and height. The host owns the lock (useAspectLock),
// so the same choice drives ObjectTransform's grips, and it is never stored on an element.

import { normalizeAngle } from '@workspace/lib/vector';
import { MergedNumberInput } from './merged-number-input';
import type { MergedValue } from './merged-value';
import { PropertyRow, PropertySection } from './properties-panel';
import { PropertyCheckbox } from './property-checkbox';
import { useCoupledSize } from './use-coupled-size';

// Canonical geometry fields (Box names). The host maps these to its own element update + units.
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
    // W/H disabled for derived-dims selections (vector text — size lives in fontSize, the measurement
    // util is the sole dim writer). The aspect checkbox is hidden with them: locking W↔H is
    // meaningless when neither is editable, and it must never override text's forced 'aspect' mode.
    sizeDisabled?: boolean;
    // Disables ONLY the angle input, W/H untouched (an elbow arrow pins angle 0 — its rotation is moot).
    angleDisabled?: boolean;
    // Disables EVERY input (read-only viewers): a visible read-out whose fields can't be edited.
    disabled?: boolean;
    // Aspect-ratio checkbox. Controlled by the host; omit `onAspectLockChange` to hide it entirely.
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
            {/* No min/max: the row is built to take an out-of-range entry and WRAP it — bounds here
                would clamp a typed -90 to 0 before normalizeAngle ever saw it. */}
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
