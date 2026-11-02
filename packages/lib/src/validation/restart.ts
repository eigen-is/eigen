// What ./eigen may tell the running API when it announces a restart, such as the one an update makes. The control
// route checks a notice against these, and the banner in the browser picks its text by the reason.

export const RESTART_REASONS = ['update', 'rollback'] as const;
