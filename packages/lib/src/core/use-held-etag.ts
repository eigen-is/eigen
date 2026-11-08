// The etag a form's Save answers to, so a save can't overwrite a change the form never showed: the live etag until the
// user types, then the one typing began on. A refusal lets it move on once, to the record the toast says to check.
// A form over a record that keeps changing under it uses this, such as a contact's or a calendar event's.

import { useState } from 'react';
import { isStaleWrite } from './api-error';

type HeldEtag = {
    heldEtag: string;
    // For a save of two writes: the second answers to what the first returned, even if the record has left the list.
    holdEtag: (etag: string) => void;
    refuse: () => void;
    // Runs a Save that sends the held etag. A rejection stays one, and a stale etag counts as a refusal.
    saveHeld: (write: () => Promise<void>) => Promise<void>;
};

export function useHeldEtag(liveEtag: string, typing: boolean, onRefused?: () => void): HeldEtag {
    const [heldEtag, setHeldEtag] = useState(liveEtag);
    const [wrote, setWrote] = useState(false);
    const [refused, setRefused] = useState(false);
    if (heldEtag !== liveEtag && (refused || !(typing || wrote))) {
        setHeldEtag(liveEtag);
        setRefused(false);
    }

    const refuse = () => {
        setRefused(true);
        onRefused?.();
    };

    return {
        heldEtag,
        holdEtag: (etag) => {
            setHeldEtag(etag);
            setWrote(true);
        },
        refuse,
        saveHeld: (write) =>
            write().catch((error: unknown) => {
                if (isStaleWrite(error)) refuse();
                throw error;
            }),
    };
}
