// Reloads a tab whose home changed under it, such as after a restore of the home or an update of the server. Both
// signals for that end here, for example the collab socket's close and the event stream's data epochs, so the tab
// reloads the same way whichever arrives first.

// The data epoch of every home this tab has heard of, in the tab's sessionStorage so it outlives a page load.
export const DATA_EPOCHS_KEY = 'eigen-data-epochs';

// Every cache the tab holds is stale, down to a collab Y.Doc that would sync the old state back. So the page starts
// over, and since nothing persists to IndexedDB, a reload is a clean slate. A collab socket closes before the stream
// announces the new epoch, so the stored epochs go too, and the page this brings up takes the first epochs it hears.
export function reloadReplacedHome(): void {
    try {
        window.sessionStorage.removeItem(DATA_EPOCHS_KEY);
    } catch {}
    window.location.reload();
}
