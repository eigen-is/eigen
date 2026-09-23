import { afterAll } from 'bun:test';
import { cleanup } from './setup';

// One process runs every file. On CI a line every 5 s puts its size next to the timestamped output,
// and a missing tick marks a stretch where the thread never got back to the loop.
if (process.env['GITHUB_ACTIONS']) {
    setInterval(() => {
        console.log(`[memory] rss ${Math.round(process.memoryUsage.rss() / 1048576)}MB`);
    }, 5000).unref();
}

afterAll(() => {
    cleanup();
});
