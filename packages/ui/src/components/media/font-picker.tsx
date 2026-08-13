import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import { ChevronDown } from 'lucide-react';
import { Button } from '../button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu';

type FontPickerProps = {
    value: string;
    onChange: (fontName: string) => void;
    className?: string;
};

export function FontPicker({ value, onChange, className }: FontPickerProps) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className={className ?? 'h-8 px-2 gap-1'}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    <span className="text-xs whitespace-nowrap">{value}</span>
                    <ChevronDown className="h-3 w-3" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[75vh] overflow-auto">
                {EIGEN_FONTS.map((font) => (
                    <DropdownMenuItem key={font.name} onClick={() => onChange(font.name)}>
                        <span style={{ fontFamily: getFontFamily(font.name) }}>{font.name}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
