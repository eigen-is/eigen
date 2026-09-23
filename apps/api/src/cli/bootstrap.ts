import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pkg from '../../../../package.json' with { type: 'json' };
import { writeEnvFile } from './env-file';
import { ENV_PATH, ownAs, ROOT } from './install';
import { createUi } from './ui';

const BUNDLE_FILES = [
    'eigen',
    'docker-compose.yml',
    'docker-compose.host-certs.yml',
    'docker-compose.host-api.yml',
    '.env.example',
];
const BUNDLE_DIR = 'docker/fail2ban';
export const BOOTSTRAP_OPTIONS = { out: { type: 'string' }, force: { type: 'boolean' } } as const;
export const BOOTSTRAP_USAGE = `Usage: bootstrap [--out <dir>] [--force]

Writes the launcher, the Compose files and a starter ${ENV_PATH} into <dir> (default /out).

  --out <dir>   Where to write, mounted as: docker run --rm -v "$PWD:/out" <image> bootstrap
  --force       Rewrite the bundle files of an existing install; ${ENV_PATH} is left alone`;

export async function bootstrap(flags: { out?: string; force?: boolean }): Promise<void> {
    const ui = await createUi(true);
    const out = flags.out ?? '/out';
    if (!existsSync(out)) ui.fail(`${out} does not exist.`, 'Mount the install folder: docker run -v "$PWD:/out" …');
    if (!flags.force && BUNDLE_FILES.some((file) => existsSync(join(out, file)))) {
        ui.fail(
            'This folder already has an Eigen install.',
            'Run ./eigen setup to configure it, or pass --force to rewrite its bundle files.',
        );
    }
    const registry =
        process.env['EIGEN_REGISTRY'] ||
        ui.fail('EIGEN_REGISTRY is not set.', 'Run bootstrap from the Eigen API image.');
    const { version } = pkg;
    const owner = statSync(out);
    const bundleDirFiles = readdirSync(join(ROOT, BUNDLE_DIR), { recursive: true, encoding: 'utf8' })
        .map((file) => join(BUNDLE_DIR, file))
        .filter((file) => statSync(join(ROOT, file)).isFile());
    for (const file of [...BUNDLE_FILES, ...bundleDirFiles]) {
        const target = join(out, file);
        for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
            if (!existsSync(join(out, dir))) mkdirSync(join(out, dir), { recursive: true });
            ownAs(join(out, dir), owner);
        }
        const temp = `${target}.${process.pid}.tmp`;
        await Bun.write(temp, Bun.file(join(ROOT, file)));
        chmodSync(temp, file === 'eigen' ? 0o755 : 0o644);
        ownAs(temp, owner);
        renameSync(temp, target);
    }

    const envPath = join(out, ENV_PATH);
    const starter = !existsSync(envPath);
    if (starter) {
        writeEnvFile(
            envPath,
            new Map([
                ['EIGEN_REGISTRY', registry],
                ['EIGEN_VERSION', version],
                ['EIGEN_API_IMAGE', `${registry}/api:${version}`],
            ]),
        );
        ownAs(envPath, owner);
    }
    ui.outro(
        flags.force
            ? `Rewrote the Eigen ${version} bundle files.`
            : `Wrote Eigen ${version}${starter ? '' : ` (kept the existing ${ENV_PATH})`}. Next: ./eigen setup`,
    );
}
