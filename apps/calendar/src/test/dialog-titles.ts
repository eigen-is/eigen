// The open dialogs' names, read from what each is labelled by, not from every heading in it: an event's body heads
// its block with the event's title too.
export const dialogTitles = () =>
    [...document.querySelectorAll('[role="dialog"]')].map(
        (dialog) => document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent,
    );
