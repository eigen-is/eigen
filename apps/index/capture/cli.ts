// `bun run capture [scene …]` films the seeded Tuimel demo world for the About pages of the public site: every scene,
// or the ones named. It starts one throwaway stack for the apps those scenes need, signs each scene's personas in,
// runs the scene in system Chrome and records it, then stops the stack. It runs on the owner's Mac, not in CI.

import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { personaContext, signIn } from './auth';
import { cursor } from './lib/cursor';
import type { Scene, SceneContext, Stack } from './lib/scene';
import { pickScenes } from './lib/scene';
import { typeLikeAPerson } from './lib/type';
import { recordVideo, takeStill } from './record';
import { SCENES } from './scenes';
import { startStack } from './stack';

let scenes: Scene[];
try {
    scenes = pickScenes(process.argv.slice(2), SCENES);
} catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
}
if (scenes.length === 0) {
    console.log('No scenes yet.');
    process.exit(0);
}

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
    const ctx: SceneContext = {
        pages,
        cursors: pages.map(cursor),
        stack,
        type: typeLikeAPerson,
        hold: (ms) => Bun.sleep(ms),
    };
    await scene.setup?.(ctx);
    if (scene.kind === 'video') await recordVideo(pages[0], scene, () => scene.run(ctx));
    else {
        await scene.run(ctx);
        await takeStill(pages[0], scene);
    }
    await Promise.all(contexts.map((context) => context.close()));
}
