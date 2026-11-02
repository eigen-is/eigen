// The restart the server announced, such as the one before an update, and whether the tab's event stream is down,
// for the banner that warns the user. It reads the restart notice's store, which the stream fills, and re-renders
// on each change. Without a stream, such as on a page outside the signed-in apps, it holds no notice.

import type { RestartNoticeState } from '@workspace/lib/types/sse';
import { useSyncExternalStore } from 'react';
import { readRestartNotice, subscribeRestartNotice } from '../restart-notice';

export function useRestartNotice(): RestartNoticeState {
    return useSyncExternalStore(subscribeRestartNotice, readRestartNotice, readRestartNotice);
}
