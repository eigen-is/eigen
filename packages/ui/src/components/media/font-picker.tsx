// The font dropdown of a formatting toolbar, such as Docs' and Sheets': it shows the current font and lists every
// font Eigen ships, each row drawn in its own font. It opens without blocking the page, so one press on a bar menu
// moves on from it, and a host can hand the focus back to its editor as it closes.

import { EIGEN_FONTS, getFontFamily } from '@workspace/lib/constants/fonts';
import { ChevronDown } from 'lucide-react';
import { Button } from '../button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu';

type FontPickerProps = {
    value: string;
    onChange: (fontName: string) => void;
    className?: string;
    // An editor that takes focus back on a pick passes its keep-focus handler, so Radix doesn't refocus the trigger.
    onCloseAutoFocus?: (event: Event) => void;
};

export function FontPicker({ value, onChange, className, onCloseAutoFocus }: FontPickerProps) {
    return (
        <DropdownMenu modal={false}>
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
            <DropdownMenuContent
                align="start"
                className="max-h-[75vh] overflow-auto"
                onCloseAutoFocus={onCloseAutoFocus}
            >
                {EIGEN_FONTS.map((font) => (
                    <DropdownMenuItem key={font.name} onClick={() => onChange(font.name)}>
                        <span style={{ fontFamily: getFontFamily(font.name) }}>{font.name}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
