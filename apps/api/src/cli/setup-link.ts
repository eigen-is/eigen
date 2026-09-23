import { styleText } from 'node:util';
import type { SetupLink } from '../lib/control/control';
import { callControl } from './control-socket';
import { createUi } from './ui';

// The close of ./eigen setup: the one-time link and what follows it, or where to sign in once setup is done.
export async function setupLink(): Promise<void> {
    const ui = await createUi(true);
    const res = await callControl('/setup-link', ui.fail, { method: 'POST' });
    if (!res.ok) ui.fail(await res.text(), './eigen logs eigen-api shows what went wrong.');
    const { setupUrl, signInUrl }: SetupLink = await res.json();

    const lines = setupUrl
        ? [
              'Finish the setup in your browser. Open this link:',
              setupUrl,
              '',
              'It asks for the name of your organization, where to keep files, and your admin account.',
              'The link works once. Lost it? Run ./eigen setup again for a fresh one.',
              '',
              `Then sign in at ${signInUrl} to add your people.`,
          ]
        : [`Eigen is already set up. Sign in at ${signInUrl}.`];
    // The API container gets .env.production as its environment, so the web mode is known here.
    if (setupUrl && process.env['COMPOSE_PROFILES']?.split(',').includes('static')) {
        lines.unshift(
            `First point your web server at ${process.env['EIGEN_STATIC_HOST']}:${process.env['EIGEN_STATIC_PORT']}.`,
            'The snippets eigen.nginx.conf, eigen.Caddyfile and eigen.apache.conf show how.',
            '',
        );
    }

    // Bun's styleText ignores NO_COLOR, so the check is made here.
    if (!process.stdout.isTTY || process.env['NO_COLOR']) {
        console.log(`\n${lines.join('\n')}`);
        return;
    }
    const rail = styleText('gray', '│');
    console.log(
        [
            rail,
            ...lines.map((line, index) => {
                if (index === lines.length - 1) return `${styleText('gray', '└')}  ${line}`;
                if (index === 0) return `${styleText('cyan', '◆')}  ${line}`;
                return line ? `${rail}  ${line}` : rail;
            }),
        ].join('\n'),
    );
}
