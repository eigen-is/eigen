import type { NewDraft } from '@workspace/lib/types/mail';

// Fields the mail app puts into TanStack Router history state.
// - prefillDraft: seeds the composer for reply/forward without persisting a draft (see
//   openPrefilledCompose in use-mail-actions.ts).
// - repliedToId: the message a Reply or Reply all answers, marked replied once the send succeeds.
// - composeSessionKey: nonce that identifies one compose session; used as part of the
//   EmailDraft remount key so a new Reply/Compose click unmounts any in-progress composer
//   even when mode='compose' doesn't change in the URL.
declare module '@tanstack/history' {
    interface HistoryState {
        prefillDraft?: NewDraft;
        repliedToId?: string;
        composeSessionKey?: string;
    }
}
