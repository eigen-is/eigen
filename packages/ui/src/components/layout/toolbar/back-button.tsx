// The one back in a column's bar, a chevron at the bar's left edge: alone, as Column's phone back in every app, with
// the tooltip Back, or beside the name of where it returns to, such as Drive's text editor's "Files". The chevron's
// glyph sits on the gutter, where a title without a back starts.

import { ChevronLeft } from 'lucide-react';
import { Button } from '../../button';
import { TooltipButton } from './tooltip-button';

type BackButtonProps = {
    onClick: () => void;
    label?: string;
};

export function BackButton({ onClick, label }: BackButtonProps) {
    if (!label) return <TooltipButton icon={ChevronLeft} tooltipText="Back" className="-ml-2 mr-1" onClick={onClick} />;
    return (
        <Button variant="ghost" size="sm" className="-ml-2 gap-1 px-2 has-[>svg]:px-2" onClick={onClick}>
            <ChevronLeft />
            {label}
        </Button>
    );
}
