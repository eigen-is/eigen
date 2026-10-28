// The topbar's way into the command palette: a search pill with its shortcut from md up, a search icon below. Both
// read the --topbar-* tokens (globals.css), as NotificationBell and AppSwitcher do. Topbar renders it everywhere, but
// the marketing-only index app (blog, support) mounts no CommandPaletteProvider, so like PaletteRunner (app-shell.tsx)
// it renders nothing without one.

import { useOptionalCommandPalette } from '@workspace/lib/command-palette';
import { useIsDesktop } from '@workspace/lib/media';
import { Button } from '@workspace/ui/components/button';
import { Kbd } from '@workspace/ui/components/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';

export function CommandPaletteTrigger({ documentTitle }: { documentTitle?: string }) {
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
                    'hidden md:flex items-center gap-2 rounded-md border px-3 h-8',
                    'border-[var(--topbar-pill-border)] bg-[var(--topbar-pill-bg)] text-[var(--topbar-pill-fg)]',
                    'text-sm hover:bg-[var(--topbar-pill-hover-bg)] hover:text-[var(--topbar-pill-hover-fg)] transition-colors',
                    'min-w-xs lg:min-w-md max-w-md',
                )}
            >
                <Search className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left truncate min-w-0">{documentTitle || 'Search and jump anywhere'}</span>
                {isDesktop && <Kbd className="shrink-0">{isMac ? '⌘K' : 'Ctrl+K'}</Kbd>}
            </button>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setOpen(true)}
                        className="md:hidden h-8 w-8 text-[var(--topbar-icon)] hover:bg-[var(--topbar-icon-hover-bg)] hover:text-[var(--topbar-icon-hover-fg)]"
                    >
                        <Search className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Search</TooltipContent>
            </Tooltip>
        </>
    );
}
