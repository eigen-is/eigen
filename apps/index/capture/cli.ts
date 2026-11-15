// `bun run capture [scene …]`, run in the capture tool's own folder after its own `bun install`, films the seeded
// Tuimel demo world for the About pages of the public site: every scene, or the ones named. It starts one throwaway
// stack for the apps those scenes need, signs each scene's personas in, runs the scene in system Chrome and records
// it, then stops the stack. It runs on the owner's Mac, not in CI.

import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { personaContext, signIn } from './auth';
import { cursor } from './lib/cursor';
import type { Scene, SceneContext, Stack } from './lib/scene';
import { recordVideo, takeStill } from './record';
import { SCENES } from './scenes';
import { startStack } from './stack';

const missingTools = ['ffmpeg', 'cwebp'].filter((tool) => !Bun.which(tool));
if (missingTools.length) {
    console.error(`${missingTools.join(' and ')} not found. Install them with: brew install ffmpeg webp`);
    process.exit(1);
}

const names = process.argv.slice(2);
const unknown = names.filter((name) => !SCENES.some((scene) => scene.name === name));
if (unknown.length) {
    console.error(`Unknown scene ${unknown.join(', ')}. Scenes: ${SCENES.map((scene) => scene.name).join(', ')}`);
    process.exit(1);
}
const scenes = names.length ? SCENES.filter((scene) => names.includes(scene.name)) : SCENES;

const stack = await startStack({ apps: [...new Set(scenes.flatMap((scene) => scene.apps))] });
try {
    const sessions: Record<string, string> = {};
    for (const key of new Set(scenes.flatMap((scene) => scene.personas))) sessions[key] = await signIn(stack, key);
    // The API trusts no capture port as an origin, so the pages reach it with CORS off.
    const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-web-security'] });
    try {
        for (const scene of scenes) {
            console.log(`Filming ${scene.name}`);
            await film(browser, stack, sessions, scene);
        }
    } finally {
        await browser.close();
    }
} finally {
    await stack.stop();
}

async function film(
    browser: Browser,
    stack: Stack,
    sessions: Readonly<Record<string, string>>,
    scene: Scene,
): Promise<void> {
    const contexts = await Promise.all(scene.personas.map((key) => personaContext(browser, sessions[key], scene)));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const ctx: SceneContext = { pages, cursors: pages.map(cursor), stack };
    await scene.setup?.(ctx);
    if (scene.kind === 'video') await recordVideo(pages, scene, () => scene.run(ctx));
    else {
        await scene.run(ctx);
        await takeStill(pages[0], scene);
    }
    await scene.teardown?.(ctx);
    await Promise.all(contexts.map((context) => context.close()));
}
