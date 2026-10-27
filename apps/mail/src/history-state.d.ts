// The fields the mail app keeps in TanStack Router's history state, so a compose session survives the
// URL rewrite of its first auto-save. prefillDraft seeds a reply or forward without saving a draft,
// forwardedParts are the attachments a forward adds when the composer opens, and composeSessionKey names
// one compose session, so a new Reply or Forward remounts the composer even when the URL stays the same.

import type { FileSubject } from '@workspace/lib/types/file-subject';
import type { NewDraft } from '@workspace/lib/types/mail';

declare module '@tanstack/history' {
    interface HistoryState {
        prefillDraft?: NewDraft;
        forwardedParts?: FileSubject[];
        composeSessionKey?: string;
    }
}
