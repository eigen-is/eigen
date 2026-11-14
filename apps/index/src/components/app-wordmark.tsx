// An app's name as a ket after a word, in the app's color, such as eigen|sheets⟩ in a row of the About overview or
// your own|sheets⟩ over an app's About page. The bar and the ket are the shared wordmark's own glyphs.

import { Bar, Ket } from '@workspace/ui/components/braket';
import { cn } from '@workspace/ui/lib/utils';
import type { AboutApp } from '../content/about-apps';

type AppWordmarkProps = {
    prefix: string;
    app: AboutApp;
    className?: string;
};

export function AppWordmark({ prefix, app, className }: AppWordmarkProps) {
    return (
        <span className={cn('whitespace-nowrap', className)}>
            <span className="font-medium text-foreground">{prefix}</span>
            <span className="font-normal" style={{ color: app.color }}>
                <Bar />
                {app.slug}
                <Ket />
            </span>
        </span>
    );
}
