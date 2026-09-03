// The image's own row: how the picture fills its box (preserveAspectRatio none / meet / slice).

import { OBJECT_FITS, type ObjectFit, type VectorImageElement } from '@workspace/lib/vector';
import { getMergedValue, MergedSelect, PropertyRow, PropertySection } from '@workspace/ui/components/properties-panel';
import type { KindPanelSectionProps } from './index';

const OBJECT_FIT_LABELS: Record<ObjectFit, string> = { fill: 'Stretch', contain: 'Fit', cover: 'Fill' };
const OBJECT_FIT_OPTIONS = OBJECT_FITS.map((value) => ({ value, label: OBJECT_FIT_LABELS[value] }));

export function ImagePanelSection({ elements, onChange }: KindPanelSectionProps) {
    // The panel mounts a kind's section only for a SOLE-kind selection, so this narrows rather than filters.
    const images = elements.filter((el): el is VectorImageElement => el.type === 'image');
    const objectFit = getMergedValue(images, (el) => el.objectFit);
    return (
        <PropertySection title="Image">
            <PropertyRow label="Fit">
                <MergedSelect
                    value={objectFit}
                    onChange={(v) => onChange({ objectFit: v })}
                    options={OBJECT_FIT_OPTIONS}
                />
            </PropertyRow>
        </PropertySection>
    );
}
