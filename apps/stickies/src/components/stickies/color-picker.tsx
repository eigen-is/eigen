import {CARD_COLORS} from './types';
import {cn} from '@workspace/ui/lib/utils';

type ColorPickerProps = {
    value: string;
    onChange: (color: string) => void;
}

export function ColorPicker({value, onChange}: ColorPickerProps) {
    return (
        <div className="flex items-center gap-1.5">
            {CARD_COLORS.map((color) => (
                <button
                    key={color.label}
                    type="button"
                    title={color.label}
                    onClick={() => onChange(color.value)}
                    className={cn(
                        'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110',
                        value === color.value ? 'border-foreground scale-110' : 'border-muted-foreground/30',
                    )}
                    style={{backgroundColor: color.value || '#ffffff'}}
                />
            ))}
        </div>
    );
}
