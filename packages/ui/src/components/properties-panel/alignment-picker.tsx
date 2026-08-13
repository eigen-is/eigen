import { Toggle } from '@workspace/ui/components/toggle';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';

type AlignmentPickerProps = {
    value: 'left' | 'center' | 'right' | undefined;
    onChange: (alignment: 'left' | 'center' | 'right') => void;
};

export function AlignmentPicker({ value, onChange }: AlignmentPickerProps) {
    return (
        <div className="flex items-center gap-1">
            <Toggle
                size="sm"
                aria-label="Align left"
                pressed={value === 'left'}
                onPressedChange={() => onChange('left')}
            >
                <AlignLeft className="h-4 w-4" />
            </Toggle>
            <Toggle
                size="sm"
                aria-label="Align center"
                pressed={value === 'center'}
                onPressedChange={() => onChange('center')}
            >
                <AlignCenter className="h-4 w-4" />
            </Toggle>
            <Toggle
                size="sm"
                aria-label="Align right"
                pressed={value === 'right'}
                onPressedChange={() => onChange('right')}
            >
                <AlignRight className="h-4 w-4" />
            </Toggle>
        </div>
    );
}
