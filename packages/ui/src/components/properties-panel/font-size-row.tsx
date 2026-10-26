import { nextFontSize } from '@workspace/lib/constants/fonts';
import { slideFontSize, slidePtToPx } from '@workspace/lib/vector';
import { FontSizeStepper } from '@workspace/ui/components/media/font-size-stepper';
import { MergedNumberInput } from './merged-number-input';
import { getMergedValue, isMixed } from './merged-value';
import { PropertyRow } from './properties-panel';

type FontSizeRowProps = {
    // Each selected element's stored size, in canvas px.
    sizes: number[];
    // The deck's physical width in pt; a drawing has none.
    slideWidth: number | undefined;
    // The new stored px for each element, from its own: a step moves each size from where it is.
    onChange: (size: (px: number) => number) => void;
};

// The Size row. A deck shows and takes pt, with Docs' and Sheets' stepper; a drawing has no page and speaks whole px.
// Either rounds only what it shows, and writes only a size the user sets, so the stored px of a box pasted between the
// two keeps every bit.
export function FontSizeRow({ sizes, slideWidth, onChange }: FontSizeRowProps) {
    if (slideWidth === undefined) {
        return (
            <PropertyRow label="Size">
                <MergedNumberInput
                    value={getMergedValue(sizes, (px) => Math.round(px))}
                    onChange={(px) => onChange(() => px)}
                    min={8}
                    max={200}
                    step={1}
                />
            </PropertyRow>
        );
    }
    const pt = getMergedValue(sizes, (px) => slideFontSize(px, slideWidth));
    return (
        <PropertyRow label="Size">
            <FontSizeStepper
                value={isMixed(pt) ? undefined : pt}
                onChange={(size) => onChange(() => slidePtToPx(size, slideWidth))}
                onStep={(by) =>
                    onChange((px) => slidePtToPx(nextFontSize(slideFontSize(px, slideWidth), by), slideWidth))
                }
            />
        </PropertyRow>
    );
}
