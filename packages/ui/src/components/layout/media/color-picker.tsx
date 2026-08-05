import { EIGEN_ACCENT_COLOR_ROW, EIGEN_COLORS, type EigenColor, isLightColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import { Check, RotateCcw } from 'lucide-react';

type ColorPickerProps = {
    value: string;
    onChange: (color: string) => void;
    colors?: EigenColor[][];
    columns?: number;
    resetLabel?: string;
    showReset?: boolean;
    preventFocusLoss?: boolean;
};

const DEFAULT_COLORS = [EIGEN_ACCENT_COLOR_ROW, 0, 1, 2, 4, 6, 8, 10].map((ri) =>
    [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15].map((ci) => EIGEN_COLORS[ci][ri]),
);
const DEFAULT_COLUMNS = DEFAULT_COLORS[0].length;
DEFAULT_COLORS.unshift(
    Array.from({ length: DEFAULT_COLUMNS }, (_, i) => i).map((i) => {
        const b = ((Math.sqrt(i / (DEFAULT_COLUMNS - 1)) * 255) | 0).toString(16).padStart(2, '0');
        return {
            label: `#${b}${b}${b}`,
            value: `#${b}${b}${b}`,
        };
    }),
);

export function ColorPicker({
    value,
    onChange,
    colors = DEFAULT_COLORS,
    columns = DEFAULT_COLUMNS,
    resetLabel = 'Reset',
    showReset = true,
    preventFocusLoss,
}: ColorPickerProps) {
    const normalizedValue = value.toLowerCase();

    const handleClick = (color: string, e: React.MouseEvent) => {
        if (preventFocusLoss) e.preventDefault();
        onChange(color);
    };

    const stopFocus = (e: React.MouseEvent) => e.preventDefault();

    return (
        <div className="flex flex-col gap-2">
            {showReset && (
                <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 -mx-1 rounded-md text-sm hover:bg-accent transition-colors"
                    title={resetLabel}
                    onClick={(e) => handleClick('', e)}
                    onMouseDown={stopFocus}
                >
                    <RotateCcw className="h-4 w-4" />
                    <span>{resetLabel}</span>
                </button>
            )}
            {colors.map((row, rowIdx) => (
                <div key={rowIdx} className={`grid gap-1`} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
                    {row.map((color) => (
                        <button
                            key={color.value}
                            type="button"
                            title={color.label}
                            className={cn(
                                'h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center',
                                normalizedValue === color.value.toLowerCase() && 'ring-2 ring-ring ring-offset-1',
                            )}
                            style={{ backgroundColor: color.value }}
                            onClick={(e) => handleClick(color.value, e)}
                            onMouseDown={stopFocus}
                        >
                            {normalizedValue === color.value.toLowerCase() && (
                                <Check
                                    className="h-2 w-2"
                                    style={{ color: isLightColor(color.value) ? '#000' : '#fff' }}
                                />
                            )}
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}

export type { ColorPickerProps };
export { DEFAULT_COLORS };
