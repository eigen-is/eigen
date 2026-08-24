// The shared numeric X/Y/W/H/° cluster + keep-aspect-ratio checkbox (U4b). Extracted from slides'
// Transform grid; vector adopts it as its first-ever numeric transform inputs. Presentational only:
// the host passes already-MERGED values in canonical geometry names (Box fields) and its own units,
// and owns the write transaction — every edit is one `onChange` call. An aspect-locked W or H edit
// arrives as ONE combined {width, height} so the host writes both fields in a single transaction.
//
// The checkbox state is controlled by the host (via `useAspectLock`) so the same ON/OFF also feeds
// ObjectTransform's resizeMode — panel and canvas handles honor one setting. It is ephemeral UI
// state, never stored on an element.

import { normalizeAngle } from '@workspace/lib/vector';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { useId } from 'react';
import { MergedNumberInput } from './merged-number-input';
import { isMixed, type MergedValue } from './merged-value';
import { PropertyRow, PropertySection } from './properties-panel';

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
    // Aspect-ratio checkbox. Controlled by the host; omit `onAspectLockChange` to hide it entirely.
    aspectLocked?: boolean;
    onAspectLockChange?: (locked: boolean) => void;
    // Ratio (width / height) the lock uses. The host resolves an intrinsic image ratio when it can
    // (D8a); null/undefined falls back to the current box ratio at edit time.
    aspectRatio?: number | null;
};

export function TransformSection({
    x,
    y,
    width,
    height,
    angle,
    onChange,
    sizeDisabled = false,
    aspectLocked = false,
    onAspectLockChange,
    aspectRatio,
}: TransformSectionProps) {
    const aspectId = useId();
    const showAspect = !sizeDisabled && onAspectLockChange !== undefined;

    // Effective ratio: host intrinsic when supplied, else the current box ratio (only when both dims
    // are concrete — a mixed selection has no single ratio). null disables coupling entirely.
    const boxRatio =
        !isMixed(width) && width !== undefined && !isMixed(height) && height !== undefined && height !== 0
            ? width / height
            : null;
    const ratio = aspectRatio ?? boxRatio;
    const coupled = showAspect && aspectLocked && ratio !== null && ratio > 0;

    // The derived dim is floored at 1 — an extreme ratio must not couple a valid edit to a 0-size.
    const changeWidth = (w: number) =>
        onChange(coupled ? { width: w, height: Math.max(1, Math.round(w / ratio)) } : { width: w });
    const changeHeight = (h: number) =>
        onChange(coupled ? { width: Math.max(1, Math.round(h * ratio)), height: h } : { height: h });

    return (
        <PropertySection title="Transform">
            <div className="grid grid-cols-2 gap-2">
                <PropertyRow label="X">
                    <MergedNumberInput value={x} onChange={(v) => onChange({ x: v })} step={1} />
                </PropertyRow>
                <PropertyRow label="Y">
                    <MergedNumberInput value={y} onChange={(v) => onChange({ y: v })} step={1} />
                </PropertyRow>
                <PropertyRow label="W">
                    <MergedNumberInput value={width} onChange={changeWidth} step={1} min={1} disabled={sizeDisabled} />
                </PropertyRow>
                <PropertyRow label="H">
                    <MergedNumberInput
                        value={height}
                        onChange={changeHeight}
                        step={1}
                        min={1}
                        disabled={sizeDisabled}
                    />
                </PropertyRow>
            </div>
            {showAspect && (
                <div className="flex items-center gap-2">
                    <Checkbox
                        id={aspectId}
                        checked={aspectLocked}
                        onCheckedChange={(c) => onAspectLockChange?.(c === true)}
                    />
                    <label htmlFor={aspectId} className="text-xs text-muted-foreground cursor-pointer select-none">
                        Keep aspect ratio
                    </label>
                </div>
            )}
            <PropertyRow label="°">
                <MergedNumberInput
                    value={angle}
                    onChange={(v) => onChange({ angle: normalizeAngle(v) })}
                    step={1}
                    min={0}
                    max={360}
                />
            </PropertyRow>
        </PropertySection>
    );
}
