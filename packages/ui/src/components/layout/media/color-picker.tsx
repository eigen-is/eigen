import {Check, RotateCcw} from 'lucide-react';
import {cn} from '@workspace/ui/lib/utils';

type ColorOption = {
    label: string;
    value: string;
}

type ColorPickerProps = {
    value: string;
    onChange: (color: string) => void;
    colors?: ColorOption[][];
    columns?: number;
    resetLabel?: string;
    preventFocusLoss?: boolean;
}

const DEFAULT_COLORS: ColorOption[][] = [
    [
        {label: 'Black', value: '#000000'},
        {label: 'Dark gray 4', value: '#434343'},
        {label: 'Dark gray 3', value: '#666666'},
        {label: 'Dark gray 2', value: '#999999'},
        {label: 'Dark gray 1', value: '#b7b7b7'},
        {label: 'Gray', value: '#cccccc'},
        {label: 'Light gray 1', value: '#d9d9d9'},
        {label: 'Light gray 2', value: '#efefef'},
        {label: 'Light gray 3', value: '#f3f3f3'},
        {label: 'White', value: '#ffffff'},
    ],
    [
        {label: 'Dark red berry', value: '#980000'},
        {label: 'Dark red', value: '#ff0000'},
        {label: 'Dark orange', value: '#ff9900'},
        {label: 'Dark yellow', value: '#ffff00'},
        {label: 'Dark green', value: '#00ff00'},
        {label: 'Dark cyan', value: '#00ffff'},
        {label: 'Dark cornflower blue', value: '#4a86e8'},
        {label: 'Dark blue', value: '#0000ff'},
        {label: 'Dark purple', value: '#9900ff'},
        {label: 'Dark magenta', value: '#ff00ff'},
    ],
    [
        {label: 'Red berry', value: '#e6b8af'},
        {label: 'Red', value: '#f4cccc'},
        {label: 'Orange', value: '#fce5cd'},
        {label: 'Yellow', value: '#fff2cc'},
        {label: 'Green', value: '#d9ead3'},
        {label: 'Cyan', value: '#d0e0e3'},
        {label: 'Cornflower blue', value: '#c9daf8'},
        {label: 'Blue', value: '#cfe2f3'},
        {label: 'Purple', value: '#d9d2e9'},
        {label: 'Magenta', value: '#ead1dc'},
    ],
    [
        {label: 'Light red berry 3', value: '#dd7e6b'},
        {label: 'Light red 3', value: '#ea9999'},
        {label: 'Light orange 3', value: '#f9cb9c'},
        {label: 'Light yellow 3', value: '#ffe599'},
        {label: 'Light green 3', value: '#b6d7a8'},
        {label: 'Light cyan 3', value: '#a2c4c9'},
        {label: 'Light cornflower blue 3', value: '#a4c2f4'},
        {label: 'Light blue 3', value: '#9fc5e8'},
        {label: 'Light purple 3', value: '#b4a7d6'},
        {label: 'Light magenta 3', value: '#d5a6bd'},
    ],
    [
        {label: 'Light red berry 2', value: '#cc4125'},
        {label: 'Light red 2', value: '#e06666'},
        {label: 'Light orange 2', value: '#f6b26b'},
        {label: 'Light yellow 2', value: '#ffd966'},
        {label: 'Light green 2', value: '#93c47d'},
        {label: 'Light cyan 2', value: '#76a5af'},
        {label: 'Light cornflower blue 2', value: '#6d9eeb'},
        {label: 'Light blue 2', value: '#6fa8dc'},
        {label: 'Light purple 2', value: '#8e7cc3'},
        {label: 'Light magenta 2', value: '#c27ba0'},
    ],
    [
        {label: 'Dark red berry 1', value: '#a61c00'},
        {label: 'Dark red 1', value: '#cc0000'},
        {label: 'Dark orange 1', value: '#e69138'},
        {label: 'Dark yellow 1', value: '#f1c232'},
        {label: 'Dark green 1', value: '#6aa84f'},
        {label: 'Dark cyan 1', value: '#45818e'},
        {label: 'Dark cornflower blue 1', value: '#3c78d8'},
        {label: 'Dark blue 1', value: '#3d85c6'},
        {label: 'Dark purple 1', value: '#674ea7'},
        {label: 'Dark magenta 1', value: '#a64d79'},
    ],
    [
        {label: 'Dark red berry 2', value: '#85200c'},
        {label: 'Dark red 2', value: '#990000'},
        {label: 'Dark orange 2', value: '#b45f06'},
        {label: 'Dark yellow 2', value: '#bf9000'},
        {label: 'Dark green 2', value: '#38761d'},
        {label: 'Dark cyan 2', value: '#134f5c'},
        {label: 'Dark cornflower blue 2', value: '#1155cc'},
        {label: 'Dark blue 2', value: '#0b5394'},
        {label: 'Dark purple 2', value: '#351c75'},
        {label: 'Dark magenta 2', value: '#741b47'},
    ],
    [
        {label: 'Dark red berry 3', value: '#5b0f00'},
        {label: 'Dark red 3', value: '#660000'},
        {label: 'Dark orange 3', value: '#783f04'},
        {label: 'Dark yellow 3', value: '#7f6000'},
        {label: 'Dark green 3', value: '#274e13'},
        {label: 'Dark cyan 3', value: '#0c343d'},
        {label: 'Dark cornflower blue 3', value: '#1c4587'},
        {label: 'Dark blue 3', value: '#073763'},
        {label: 'Dark purple 3', value: '#20124d'},
        {label: 'Dark magenta 3', value: '#4c1130'},
    ],
];

export function ColorPicker({
                                value,
                                onChange,
                                colors = DEFAULT_COLORS,
                                columns = 10,
                                resetLabel = 'Reset',
                                preventFocusLoss
                            }: ColorPickerProps) {
    const normalizedValue = value.toLowerCase();

    const handleClick = (color: string, e: React.MouseEvent) => {
        if (preventFocusLoss) e.preventDefault();
        onChange(color);
    };

    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                className="flex items-center gap-2 px-2 py-1.5 -mx-1 rounded-md text-sm hover:bg-accent transition-colors"
                title={resetLabel}
                onClick={(e) => handleClick('', e)}
                onMouseDown={preventFocusLoss ? (e) => e.preventDefault() : undefined}
            >
                <RotateCcw className="h-4 w-4"/>
                <span>{resetLabel}</span>
            </button>
            {colors.map((row, rowIdx) => (
                <div key={rowIdx} className={`grid gap-1`} style={{gridTemplateColumns: `repeat(${columns}, 1fr)`}}>
                    {row.map((color) => (
                        <button
                            key={color.value}
                            type="button"
                            title={color.label}
                            className={cn(
                                'h-5 w-5 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center',
                                normalizedValue === color.value.toLowerCase() && 'ring-2 ring-ring ring-offset-1',
                            )}
                            style={{backgroundColor: color.value}}
                            onClick={(e) => handleClick(color.value, e)}
                            onMouseDown={preventFocusLoss ? (e) => e.preventDefault() : undefined}
                        >
                            {normalizedValue === color.value.toLowerCase() && (
                                <Check className="h-3 w-3"
                                       style={{color: isLightColor(color.value) ? '#000' : '#fff'}}/>
                            )}
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}

function isLightColor(hex: string): boolean {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5;
}

export {DEFAULT_COLORS};
export type {ColorOption, ColorPickerProps};

