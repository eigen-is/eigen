import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Toolbar} from '@workspace/ui/components/layout/toolbar';
import type {ViewMode} from './calendar-utils';

type CalendarToolbarProps = {
    currentDate: Date;
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    onToday: () => void;
    onPrev: () => void;
    onNext: () => void;
}

function formatTitle(date: Date, viewMode: ViewMode): string {
    if (viewMode === 'month') {
        return date.toLocaleDateString('en', {month: 'long', year: 'numeric'});
    }
    const startOfWeek = new Date(date);
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1;
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    const startMonth = startOfWeek.toLocaleDateString('en', {month: 'short'});
    const endMonth = endOfWeek.toLocaleDateString('en', {month: 'short'});
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
    return (
        <Toolbar>
            <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onToday}>
                    Today
                </Button>
                <div className="flex items-center">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrev}>
                        <ChevronLeft className="h-4 w-4"/>
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext}>
                        <ChevronRight className="h-4 w-4"/>
                    </Button>
                </div>
                <h2 className="text-lg font-semibold whitespace-nowrap">
                    {formatTitle(currentDate, viewMode)}
                </h2>
            </div>

            <div className="flex items-center gap-2">
                <Select value={viewMode} onValueChange={(v) => onViewModeChange(v as ViewMode)}>
                    <SelectTrigger className="w-24 h-8">
                        <SelectValue/>
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
