import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ROOT } from '../../cli/install';
import { getEnvFile } from '../../lib/config/env';
import { restoreEnvAfterEach } from '../env-test-helpers';

const MOUNTED = '/app/install/.env.production';

describe('the install env file', () => {
    restoreEnvAfterEach(['EIGEN_ENV_FILE']);

    test('is the file EIGEN_ENV_FILE names, and none when it is unset or empty', () => {
        process.env['EIGEN_ENV_FILE'] = MOUNTED;
        expect(getEnvFile()).toBe(MOUNTED);
        process.env['EIGEN_ENV_FILE'] = '';
        expect(getEnvFile()).toBeUndefined();
        delete process.env['EIGEN_ENV_FILE'];
        expect(getEnvFile()).toBeUndefined();
    });

    test('eigen-api alone mounts it, read-only, where EIGEN_ENV_FILE points', async () => {
        const compose = Bun.YAML.parse(await Bun.file(join(ROOT, 'docker-compose.yml')).text());
        // Counted first: toMatchObject writes its matchers into the object it matched.
        expect(JSON.stringify(compose).match(/"\.\/\.env\.production:/g)).toHaveLength(1);
        expect(compose).toMatchObject({
            services: {
                'eigen-api': {
                    volumes: expect.arrayContaining([`./.env.production:${MOUNTED}:ro`]),
                    environment: { EIGEN_ENV_FILE: MOUNTED },
                },
            },
        });
    });
});
