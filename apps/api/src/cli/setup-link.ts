import type { SetupLink } from '../lib/setup/setup-token';
import { callControl } from './control-socket';
import { createUi, glyphLine } from './ui';

// The close of ./eigen setup: the one-time link and what follows it, or where to sign in once setup is done.
export async function setupLink(): Promise<void> {
    const ui = await createUi(true);
    const res = await callControl('/setup-link', ui.fail, { method: 'POST' });
    if (!res.ok) ui.fail(await res.text(), 'Run ./eigen logs eigen-api to see what went wrong.');
    const { setupUrl, signInUrl }: SetupLink = await res.json();

    const lines = setupUrl
        ? [
              'Finish the setup in your browser. Open this link:',
              setupUrl,
              '',
              "It asks for the name of your organization, the sender of Eigen's own mail, where to keep files, and your admin account.",
              'The link works once. Lost it? Run ./eigen setup again for a fresh one.',
              '',
              `Then sign in at ${signInUrl} to add your people.`,
          ]
        : [`Eigen is already set up. Sign in at ${signInUrl}.`];
    console.log(
        [
            glyphLine('bar', ''),
            ...lines.map((line, index) => {
                if (index === lines.length - 1) return glyphLine('end', line);
                return glyphLine(index === 0 ? 'active' : 'bar', line);
            }),
        ].join('\n'),
    );
}
