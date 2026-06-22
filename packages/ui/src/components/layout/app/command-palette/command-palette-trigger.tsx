import { useOptionalCommandPalette } from '@workspace/lib/command-palette';
import { useIsDesktop } from '@workspace/lib/media/hooks/use-media-query';
import { Button } from '@workspace/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';

// Topbar is a neutral (theme `background`) bar with a thin per-app accent stripe on top
// (see topbar.tsx), so icons + the search pill use muted-on-background treatment that
// follows the theme, matching NotificationBell and AppSwitcher.
//
// Topbar renders this unconditionally, but the marketing-only index app (blog/support)
// doesn't mount the CommandPaletteProvider — mirror PaletteRunner (app-shell.tsx) and
// render nothing when no provider is in the tree.
export function CommandPaletteTrigger() {
    const palette = useOptionalCommandPalette();
    if (!palette) return null;
    const { setOpen } = palette;
    const isDesktop = useIsDesktop();
    const isMac = navigator.userAgent.includes('Mac');
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    'hidden md:flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 h-8',
                    'text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                    'min-w-xs lg:min-w-md',
                )}
            >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">Search and jump anywhere</span>
                <kbd className="text-xs font-mono">{isDesktop && (isMac ? '⌘K' : 'CTRL+K')}</kbd>
            </button>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setOpen(true)}
                        className="md:hidden h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <Search className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Search</TooltipContent>
            </Tooltip>
        </>
    );
}
