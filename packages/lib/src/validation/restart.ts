// What ./eigen may tell the running API when it announces a restart, such as the one an update makes: how long until
// it comes, and a line of the operator's for the open tabs. Whatever takes a notice checks it against these, such as
// the control route. It also says how long the API keeps a notice whose restart does not come.

import { C0_CONTROL_RANGE, C1_CONTROL_RANGE } from './text';

// An hour: nobody's tabs should show a warning for half a day because of a typo.
export const MAX_RESTART_WAIT_SECONDS = 3600;

// Room for what follows the announced time and still runs on this server: the backup, the handover and the stop.
// A launcher that died meanwhile, such as one killed with -9, takes no notice back.
export const RESTART_NOTICE_EXPIRY_MS = 5 * 60_000;

// One line of a banner.
export const MAX_RESTART_MESSAGE_LENGTH = 200;

// Some text, and no control character, C1 included: the \p{Cc} that the CLI turns into spaces.
export const RESTART_MESSAGE_PATTERN = `^(?!\\s*$)[^${C0_CONTROL_RANGE}${C1_CONTROL_RANGE}]*$`;
