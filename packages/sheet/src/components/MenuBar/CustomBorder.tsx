import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useState } from 'react';
import { en } from '../../state';
import { ColorPickerMenuItem } from '../ColorPickerMenuItem';

const BORDER_STYLES = [
    { text: '1', value: 'Thin', strokeDasharray: '1,0', strokeWidth: '1' },
    { text: '2', value: 'Hair', strokeDasharray: '1,5', strokeWidth: '1' },
    { text: '3', value: 'Dotted', strokeDasharray: '2,5', strokeWidth: '2' },
    { text: '4', value: 'Dashed', strokeDasharray: '5,5', strokeWidth: '2' },
    { text: '5', value: 'DashDot', strokeDasharray: '20,5,5,10,5,5', strokeWidth: '2' },
    { text: '6', value: 'DashDotDot', strokeDasharray: '20,5,5,5,5,10,5,5,5,5', strokeWidth: '2' },
    { text: '8', value: 'Medium', strokeDasharray: '2,0', strokeWidth: '2' },
    { text: '9', value: 'MediumDashed', strokeDasharray: '3,5', strokeWidth: '3' },
    { text: '10', value: 'MediumDashDot', strokeDasharray: '20,5,5,10,5,5', strokeWidth: '3' },
    { text: '11', value: 'MediumDashDotDot', strokeDasharray: '5,5,5,5,20,5,5,5,5,10', strokeWidth: '3' },
    { text: '13', value: 'Thick', strokeDasharray: '2,0', strokeWidth: '3' },
];

type Props = {
    onPick: (changeColor?: string, changeStyle?: string) => void;
};

export function CustomBorder({ onPick }: Props) {
    const { border } = en;
    const [changeColor, setChangeColor] = useState('#000000');
    const [changeStyle, setChangeStyle] = useState('1');

    return (
        <>
            <ColorPickerMenuItem
                label={border.borderColor}
                value={changeColor}
                showReset={false}
                onChange={(color) => {
                    setChangeColor(color);
                    onPick(color, changeStyle);
                }}
            />

            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <div className="flex items-center gap-2 w-full">
                        <span>{border.borderStyle}</span>
                        <svg className="ml-auto" height="6" width="50">
                            <g
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={BORDER_STYLES.find((s) => s.text === changeStyle)?.strokeWidth ?? '1'}
                            >
                                <path
                                    strokeDasharray={
                                        BORDER_STYLES.find((s) => s.text === changeStyle)?.strokeDasharray ?? '1,0'
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
                        {border.borderDefault ?? 'Default'}
                    </DropdownMenuItem>
                    {BORDER_STYLES.map((item) => (
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
