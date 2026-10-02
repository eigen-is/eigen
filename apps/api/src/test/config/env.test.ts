import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ROOT } from '../../cli/install';

const MOUNTED = '/app/install/.env.production';

describe('the install env file', () => {
    test('eigen-api alone mounts it, read-only, where EIGEN_ENV_FILE points', async () => {
        const compose = Bun.YAML.parse(await Bun.file(join(ROOT, 'docker-compose.yml')).text());
        // Counted first: toMatchObject writes its matchers into the object it matched.
        const json = JSON.stringify(compose);
        expect(json.match(/"\.\/\.env\.production:/g)).toHaveLength(1);
        // A mount of the whole install folder would hand the file to that container too.
        expect(json).not.toMatch(/"\.\/?:/);
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
