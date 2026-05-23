import { useCommandPalette } from '@workspace/lib/command-palette';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';

export function CommandPaletteTrigger() {
    const { setOpen } = useCommandPalette();
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    'hidden md:flex items-center gap-2 rounded-md border bg-muted/40 px-3 h-8',
                    'text-sm text-muted-foreground hover:bg-muted transition-colors',
                    'min-w-[280px]',
                )}
            >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">Search and jump anywhere</span>
                <kbd className="text-xs font-mono">⌘K</kbd>
            </button>
            <TooltipButton icon={Search} tooltipText="Search" onClick={() => setOpen(true)} className="md:hidden" />
        </>
    );
}
