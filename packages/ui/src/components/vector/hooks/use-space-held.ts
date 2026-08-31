import { useEffect, useState } from 'react';
import { isTypingTarget } from '../../../hooks/is-typing-target';

// Space tracks the pan affordance (grab cursor + pan on pointerdown); ignore while typing.
export function useSpaceHeld(): boolean {
    const [spaceHeld, setSpaceHeld] = useState(false);
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.code === 'Space' && !e.repeat && !isTypingTarget()) setSpaceHeld(true);
        };
        const up = (e: KeyboardEvent) => {
            if (e.code === 'Space') setSpaceHeld(false);
        };
        document.addEventListener('keydown', down);
        document.addEventListener('keyup', up);
        return () => {
            document.removeEventListener('keydown', down);
            document.removeEventListener('keyup', up);
        };
    }, []);
    return spaceHeld;
}
