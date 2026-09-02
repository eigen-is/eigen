import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useState } from 'react';
import { ColorPickerMenuItem } from '../ColorPickerMenuItem';

// The border-style vocabulary is owned by BORDER_STYLES (@workspace/lib/sheets), keyed by the
// same ordinals in `text`. Only the SVG preview geometry is local — double (7) and slantDashDot
// (12) are intentionally absent, they have no single-stroke preview.
const BORDER_STYLE_PREVIEWS = [
    { text: '1', strokeDasharray: '1,0', strokeWidth: '1' },
    { text: '2', strokeDasharray: '1,5', strokeWidth: '1' },
    { text: '3', strokeDasharray: '2,5', strokeWidth: '2' },
    { text: '4', strokeDasharray: '5,5', strokeWidth: '2' },
    { text: '5', strokeDasharray: '20,5,5,10,5,5', strokeWidth: '2' },
    { text: '6', strokeDasharray: '20,5,5,5,5,10,5,5,5,5', strokeWidth: '2' },
    { text: '8', strokeDasharray: '2,0', strokeWidth: '2' },
    { text: '9', strokeDasharray: '3,5', strokeWidth: '3' },
    { text: '10', strokeDasharray: '20,5,5,10,5,5', strokeWidth: '3' },
    { text: '11', strokeDasharray: '5,5,5,5,20,5,5,5,5,10', strokeWidth: '3' },
    { text: '13', strokeDasharray: '2,0', strokeWidth: '3' },
];

type Props = {
    onPick: (changeColor?: string, changeStyle?: string) => void;
};

export function CustomBorder({ onPick }: Props) {
    const [changeColor, setChangeColor] = useState('#000000');
    const [changeStyle, setChangeStyle] = useState('1');

    return (
        <>
            <ColorPickerMenuItem
                label="border color"
                value={changeColor}
                showReset={false}
                keepMenuOpen
                onChange={(color) => {
                    setChangeColor(color);
                    onPick(color, changeStyle);
                }}
            />

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <div className="flex items-center gap-2 w-full">
                        <span>border style</span>
                        <svg className="ml-auto" height="6" width="50">
                            <g
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={
                                    BORDER_STYLE_PREVIEWS.find((s) => s.text === changeStyle)?.strokeWidth ?? '1'
                                }
                            >
                                <path
                                    strokeDasharray={
                                        BORDER_STYLE_PREVIEWS.find((s) => s.text === changeStyle)?.strokeDasharray ??
                                        '1,0'
                                    }
                                    d="M0 3 l50 0"
                                />
                            </g>
                        </svg>
                    </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    <DropdownMenuItem
                        onSelect={(e) => e.preventDefault()}
                        onClick={() => {
                            setChangeStyle('1');
                            onPick(changeColor, '1');
                        }}
                    >
                        default
                    </DropdownMenuItem>
                    {BORDER_STYLE_PREVIEWS.map((item) => (
                        <DropdownMenuItem
                            key={item.text}
                            onSelect={(e) => e.preventDefault()}
                            onClick={() => {
                                setChangeStyle(item.text);
                                onPick(changeColor, item.text);
                            }}
                        >
                            <svg height="10" width="80">
                                <g fill="none" stroke="currentColor" strokeWidth={item.strokeWidth}>
                                    <path strokeDasharray={item.strokeDasharray} d="M0 5 l80 0" />
                                </g>
                            </svg>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </>
    );
}
