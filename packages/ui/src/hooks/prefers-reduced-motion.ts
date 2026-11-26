// Whether the user asked the system for less motion, read at the moment of the motion, such as a smooth scroll or an
// autoplaying carousel's next slide, so a change of the setting counts from the next one on. CSS animations ask
// through their own media query.

export function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
