// A restore put other data under this tab: every cache it holds, down to a collab Y.Doc that would sync the home as it
// was back over the restore, is stale, so the page starts over. Nothing persists to IndexedDB, so a reload is a clean
// slate. The one reload for both signals, the collab socket's close and the event stream's data epochs.
export function reloadReplacedHome(): void {
    window.location.reload();
}
