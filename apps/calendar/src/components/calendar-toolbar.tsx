import type { ViewMode } from '@workspace/lib/calendar';
import { formatMonth } from '@workspace/lib/date';
import { useIsMobile } from '@workspace/lib/media';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Toolbar, ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Check, ChevronLeft, ChevronRight, MoreVertical } from 'lucide-react';

type CalendarToolbarProps = {
    currentDate: Date;
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    onToday: () => void;
    onPrev: () => void;
    onNext: () => void;
};

function formatTitle(date: Date, viewMode: ViewMode): string {
    if (viewMode === 'month') {
        return `${formatMonth(date, 'long')} ${date.getFullYear()}`;
    }
    const startOfWeek = new Date(date);
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    const startMonth = formatMonth(startOfWeek, 'short');
    const endMonth = formatMonth(endOfWeek, 'short');
    const year = endOfWeek.getFullYear();

    if (startOfWeek.getMonth() === endOfWeek.getMonth()) {
        return `${startMonth} ${startOfWeek.getDate()} – ${endOfWeek.getDate()}, ${year}`;
    }
    return `${startMonth} ${startOfWeek.getDate()} – ${endMonth} ${endOfWeek.getDate()}, ${year}`;
}

export function CalendarToolbar({
    currentDate,
    viewMode,
    onViewModeChange,
    onToday,
    onPrev,
    onNext,
}: CalendarToolbarProps) {
    const isMobile = useIsMobile();

    // Mobile: drop the Today button from the left group and fold Today + view select into a kebab.
    if (isMobile) {
        return (
            <Toolbar>
                <div className="flex items-center gap-2">
                    <div className="flex items-center">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrev}>
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext}>
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                    <ToolbarTitle className="text-lg">{formatTitle(currentDate, viewMode)}</ToolbarTitle>
                </div>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="View options">
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={onToday}>Today</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onViewModeChange('month')}>
                            Month
                            {viewMode === 'month' && <Check className="h-4 w-4 ml-auto" />}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onViewModeChange('week')}>
                            Week
                            {viewMode === 'week' && <Check className="h-4 w-4 ml-auto" />}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </Toolbar>
        );
    }

    return (
        <Toolbar>
            <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onToday}>
                    Today
                </Button>
                <div className="flex items-center">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrev}>
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext}>
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
                <ToolbarTitle className="text-lg">{formatTitle(currentDate, viewMode)}</ToolbarTitle>
            </div>

            <div className="flex items-center gap-2">
                <Select value={viewMode} onValueChange={(v) => onViewModeChange(v as ViewMode)}>
                    <SelectTrigger className="w-24 h-8">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="month">Month</SelectItem>
                        <SelectItem value="week">Week</SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </Toolbar>
    );
}
