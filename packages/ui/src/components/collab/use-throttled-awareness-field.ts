import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// Returns a setter that publishes `value` onto the provider's awareness `field`, throttled
// leading + trailing at `ms`: fires immediately when >= ms has passed since the last send, otherwise
// schedules a trailing timer so the value's resting position always flushes (a peer never sees the
// field freeze one tick short of where it actually stopped). Passing `null` clears the field
// immediately and cancels any pending trailing send. This is vector's cursor publisher generalized
// over the field — identity / selection publishing stay one-line setLocalStateField calls per host.
export function useThrottledAwarenessField<T>(
    provider: WebsocketProvider | null,
    field: string,
    ms: number,
): (value: T | null) => void {
    const lastSentRef = useRef(0);
    const pendingRef = useRef<T | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        [],
    );

    return useCallback(
        (value: T | null) => {
            const awareness = provider?.awareness;
            if (!awareness) return;
            if (value === null) {
                if (timerRef.current) {
                    clearTimeout(timerRef.current);
                    timerRef.current = null;
                }
                pendingRef.current = null;
                awareness.setLocalStateField(field, null);
                return;
            }
            pendingRef.current = value;
            const elapsed = Date.now() - lastSentRef.current;
            if (elapsed >= ms) {
                lastSentRef.current = Date.now();
                awareness.setLocalStateField(field, value);
            } else if (!timerRef.current) {
                timerRef.current = setTimeout(() => {
                    timerRef.current = null;
                    lastSentRef.current = Date.now();
                    if (pendingRef.current !== null) awareness.setLocalStateField(field, pendingRef.current);
                }, ms - elapsed);
            }
        },
        [provider, field, ms],
    );
}
