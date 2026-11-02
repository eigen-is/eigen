// What ./eigen may tell the running API when it announces a restart, such as the one an update makes: why, how long
// until it comes, and a line of the operator's for the open tabs. The control route checks a notice against these,
// and the banner in the browser picks its text by the reason.

export const RESTART_REASONS = ['update', 'rollback'] as const;

// An hour: nobody's tabs should show a warning for half a day because of a typo.
export const MAX_RESTART_WAIT_SECONDS = 3600;

// One line of a banner.
export const MAX_RESTART_MESSAGE_LENGTH = 200;
