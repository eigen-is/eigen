import { useOptionalCommandPalette } from '@workspace/lib/command-palette';
import { Button } from '@workspace/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';

// Topbar sits on `bg-app` (the dark app-coloured bar) in both light and dark themes,
// so icons + the search pill use the same white-on-dark treatment as NotificationBell
// and AppSwitcher (see topbar.tsx). Don't tie this to the theme — the topbar itself
// doesn't.
//
// Topbar renders this unconditionally, but the marketing-only index app (blog/support)
// doesn't mount the CommandPaletteProvider — mirror PaletteRunner (app-shell.tsx) and
// render nothing when no provider is in the tree.
export function CommandPaletteTrigger() {
    const palette = useOptionalCommandPalette();
    if (!palette) return null;
    const { setOpen } = palette;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    'hidden md:flex items-center gap-2 rounded-md border border-white/15 bg-white/10 px-3 h-8',
                    'text-sm text-white/70 hover:bg-white/15 hover:text-white transition-colors',
                    'min-w-[280px]',
                )}
            >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">Search and jump anywhere</span>
                <kbd className="text-xs font-mono">⌘K</kbd>
            </button>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setOpen(true)}
                        className="md:hidden h-8 w-8 text-white hover:bg-primary/20 hover:text-white"
                    >
                        <Search className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Search</TooltipContent>
            </Tooltip>
        </>
    );
}
