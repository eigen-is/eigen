import { describe, expect, test } from 'bun:test';
import { runCli } from '../cli-test-helpers';

describe('status', () => {
    test('a newest release that is not a version is reported as not checked', async () => {
        const result = await runCli(['status', '--services=', '--latest=nightly'], { env: { NO_COLOR: '1' } });
        expect(result.stdout).toMatch(/Update +could not check/);
        expect(result.stderr).toContain('Eigen is not running.');
    });
});
