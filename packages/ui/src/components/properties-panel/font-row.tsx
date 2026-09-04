import { DEFAULT_FONT_FAMILY } from '@workspace/lib/vector';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { isMixed, type MergedValue } from './merged-value';
import { PropertyRow } from './properties-panel';

type FontRowProps = {
    value: MergedValue<string>;
    onChange: (fontFamily: string) => void;
};

// The Font row: the shared FontPicker dressed as a select trigger so it sits in the control column
// like the Size input under it. A mixed selection shows the default face (the picker has no placeholder).
export function FontRow({ value, onChange }: FontRowProps) {
    return (
        <PropertyRow label="Font">
            <FontPicker
                value={isMixed(value) ? DEFAULT_FONT_FAMILY : (value ?? DEFAULT_FONT_FAMILY)}
                onChange={onChange}
                className="h-7 w-full justify-between rounded-md border border-input bg-transparent px-2 font-normal shadow-xs"
            />
        </PropertyRow>
    );
}
