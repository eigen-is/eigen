import { EIGEN_STICKIES_COLORS, isLightColor } from '@workspace/lib/constants';
import { Check } from 'lucide-react';

type ColorSwatchRowProps = {
    currentColor?: string | null;
    onChangeColor: (color: string) => void;
};

export function ColorSwatchRow({ currentColor, onChangeColor }: ColorSwatchRowProps) {
    return (
        <div className="flex gap-1 p-2">
            {EIGEN_STICKIES_COLORS[0].map((c) => (
                <button
                    type="button"
                    key={c.value}
                    className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                    style={{ backgroundColor: c.value }}
                    title={c.label}
                    onClick={() => onChangeColor(c.value)}
                >
                    {currentColor === c.value && (
                        <Check className="h-2 w-2" style={{ color: isLightColor(c.value) ? '#000' : '#fff' }} />
                    )}
                </button>
            ))}
        </div>
    );
}
