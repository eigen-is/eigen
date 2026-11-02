// What ./eigen may tell the running API when it announces a restart, such as the one an update makes: why, how long
// until it comes, and a line of the operator's for the open tabs. Whatever takes a notice checks it against these,
// such as the control route.

export const RESTART_REASONS = ['update', 'rollback'] as const;

// An hour: nobody's tabs should show a warning for half a day because of a typo.
export const MAX_RESTART_WAIT_SECONDS = 3600;

// One line of a banner.
export const MAX_RESTART_MESSAGE_LENGTH = 200;

// Some text, and no control character, C1 included: the \p{Cc} that the CLI turns into spaces. Spelled as ranges,
// because a TypeBox pattern is compiled without the u flag.
export const RESTART_MESSAGE_PATTERN = '^(?!\\s*$)[^\\x00-\\x1f\\x7f-\\x9f]*$';
