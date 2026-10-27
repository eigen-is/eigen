// A small, rare reward for finishing something, such as ticking the last box of a card's checklist.
// useCelebrate returns celebrate(origin), which a caller calls with the element the reward starts from, such as
// the box that was ticked. That element must still be in the page, as the glow plays on it.
// The hook owns every rule, so a caller never checks anything itself: the personal celebrations setting,
// a one-in-three chance, and reduced motion, which gets a short glow on the origin instead of confetti.

import { useSpaceSettings } from '@workspace/lib/space';
import { burstConfetti } from './confetti-burst';

const CHANCE = 1 / 3;

export function useCelebrate(): (origin: HTMLElement) => void {
    const { data: settings } = useSpaceSettings();
    const enabled = settings?.celebrations !== false;

    return (origin) => {
        if (!enabled || Math.random() >= CHANCE) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            origin.animate(
                [
                    { outline: '4px solid color-mix(in oklab, var(--success) 70%, transparent)' },
                    { outline: '4px solid transparent' },
                ],
                { duration: 1200, easing: 'ease-out' },
            );
        } else {
            burstConfetti(origin.getBoundingClientRect());
        }
    };
}
