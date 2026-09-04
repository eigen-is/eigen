import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { PropertyToggle } from './property-toggle';

type AlignmentPickerProps = {
    value: 'left' | 'center' | 'right' | undefined;
    onChange: (alignment: 'left' | 'center' | 'right') => void;
};

export function AlignmentPicker({ value, onChange }: AlignmentPickerProps) {
    return (
        <div className="flex items-center gap-1">
            <PropertyToggle aria-label="Align left" pressed={value === 'left'} onPressedChange={() => onChange('left')}>
                <AlignLeft className="h-4 w-4" />
            </PropertyToggle>
            <PropertyToggle
                aria-label="Align center"
                pressed={value === 'center'}
                onPressedChange={() => onChange('center')}
            >
                <AlignCenter className="h-4 w-4" />
            </PropertyToggle>
            <PropertyToggle
                aria-label="Align right"
                pressed={value === 'right'}
                onPressedChange={() => onChange('right')}
            >
                <AlignRight className="h-4 w-4" />
            </PropertyToggle>
        </div>
    );
}
