// The bounds on the server and team settings that the settings routes enforce and the Admin app's forms show, such
// as the smallest storage budget and how many buttons the landing page may carry.

// The smallest storage budget in MB: a server default, a team's override or a team mount's size.
export const QUOTA_MIN_MB = 10;

export const LANDING_LINKS_MAX = 20;
export const LANDING_LINK_TITLE_MAX = 80;
export const LANDING_LINK_URL_MAX = 2048;
