import { apps } from '@workspace/lib/apps';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { Bar } from './bar.tsx';
import { Ket } from './ket.tsx';

type EigenCyclingLogoProps = {
    className?: string;
};

const CYCLE_MS = 2000;

// Animated "eigen|app>" wordmark that cycles through every app. Matches the
// topbar AppLogo colour split: "eigen" in the foreground, the bra-ket and app
// name in the app's own colour. Size and spacing come from `className`.
export function EigenCyclingLogo({ className }: EigenCyclingLogoProps) {
    const [appIndex, setAppIndex] = useState(0);
    const app = apps[appIndex];

    useEffect(() => {
        const interval = setInterval(() => {
            setAppIndex((prev) => (prev + 1) % apps.length);
        }, CYCLE_MS);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className={cn('select-none', className)}>
            <span className="text-foreground font-medium">eigen</span>
            <span className="font-normal" style={{ color: app.color }}>
                <Bar />
                {app.name.toLowerCase()}
                <Ket />
            </span>
        </div>
    );
}
