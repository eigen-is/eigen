// The data epoch of every home this tab has heard of, in the tab's sessionStorage so it outlives a page load.
export const DATA_EPOCHS_KEY = 'eigen-data-epochs';

// A restore put other data under this tab: every cache it holds, down to a collab Y.Doc that would sync the home as it
// was back over the restore, is stale, so the page starts over. Nothing persists to IndexedDB, so a reload is a clean
// slate. The one reload for both signals, the collab socket's close and the event stream's data epochs. A collab socket
// closes before the stream announces the new epoch, so the page this brings up takes the first epochs it hears.
export function reloadReplacedHome(): void {
    try {
        window.sessionStorage.removeItem(DATA_EPOCHS_KEY);
    } catch {}
    window.location.reload();
}
