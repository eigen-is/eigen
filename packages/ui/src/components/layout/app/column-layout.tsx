import { cn } from '@workspace/ui/lib/utils';
import { ArrowLeft } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button } from '../../button.tsx';
import { Separator } from '../../separator.tsx';
import { useLayout } from './layout-context.tsx';

type ColumnContextType = {
    mobileColumn: string | null;
};

const ColumnContext = createContext<ColumnContextType>({ mobileColumn: null });

type ColumnProps = {
    id: string;
    width: string;
    toolbar?: ReactNode;
    // 'auto' (default) fades the toolbar border in on scroll; 'always' keeps it
    // visible — for columns with a canvas below (docs, slides, stickies).
    toolbarBorder?: 'auto' | 'always';
    onBack?: () => void;
    children: ReactNode;
    className?: string;
};

function Column({ id, width, toolbar, toolbarBorder = 'auto', onBack, children, className }: ColumnProps) {
    const { isMobile } = useLayout();
    const { mobileColumn } = useContext(ColumnContext);
    const [scrolled, setScrolled] = useState(false);
    const cleanupRef = useRef<(() => void) | null>(null);

    // Scroll happens inside `children`, so a capture-phase listener catches whichever
    // descendant actually scrolls; a callback ref rebinds across mobile column show/hide.
    const contentRef = useCallback((el: HTMLDivElement | null) => {
        cleanupRef.current?.();
        cleanupRef.current = null;
        if (!el) return;
        const onScroll = (e: Event) => {
            const target = e.target as HTMLElement;
            if (target.scrollHeight > target.clientHeight) setScrolled(target.scrollTop > 0);
        };
        el.addEventListener('scroll', onScroll, true);
        cleanupRef.current = () => el.removeEventListener('scroll', onScroll, true);
    }, []);

    if (isMobile && mobileColumn !== null && mobileColumn !== id) return null;

    const style = isMobile
        ? { width: '100%', flex: '1 1 auto' }
        : width === 'flex'
          ? { flex: '1 1 auto', minWidth: 0 }
          : { width, flexShrink: 0 };

    return (
        <div className={cn('h-full flex flex-col overflow-hidden', className)} style={style}>
            {toolbar && (
                <div
                    className={cn(
                        'h-12 flex items-center px-4 shrink-0 border-r border-b transition-colors duration-200',
                        toolbarBorder === 'always' || scrolled ? 'border-b-border' : 'border-b-transparent',
                    )}
                >
                    {isMobile && onBack && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBack}>
                                <ArrowLeft className="h-4 w-4" />
                            </Button>
                            <Separator orientation="vertical" className="h-6 mx-1" />
                        </>
                    )}
                    {toolbar}
                </div>
            )}
            <div ref={contentRef} className="flex-1 overflow-hidden">
                {children}
            </div>
        </div>
    );
}

type ColumnLayoutProps = {
    mobileColumn?: string;
    children: ReactNode;
};

function ColumnLayout({ mobileColumn, children }: ColumnLayoutProps) {
    const { isMobile } = useLayout();

    return (
        <ColumnContext.Provider value={{ mobileColumn: isMobile ? (mobileColumn ?? null) : null }}>
            <div className="flex flex-1 h-full overflow-hidden">{children}</div>
        </ColumnContext.Provider>
    );
}

export type { ColumnProps };
export { Column, ColumnLayout };
