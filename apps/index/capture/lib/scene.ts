// What a capture scene is: a plain object that names its output, the apps and personas it needs and how it looks, and
// a run that drives one page per persona. The scene list holds them; the CLI picks the ones named on its command line,
// films each and hands it this context.

import type { Page } from 'playwright-core';
import type { Cursor } from './cursor';

// The throwaway Eigen a scene films in, which startStack runs.
export type Stack = {
    apiUrl: string;
    adminPassword: string;
    personaPassword: string;
    appUrl(app: string): string;
    stop(): Promise<void>;
};

export type SceneContext = {
    pages: Page[];
    // One per page, in the same order.
    cursors: Cursor[];
    stack: Stack;
};

export type Scene = {
    name: string;
    kind: 'video' | 'still';
    theme: 'light' | 'dark';
    viewport: { width: number; height: number };
    apps: string[];
    // Persona keys, such as `saar`, or the seeded admin's local part.
    personas: string[];
    // A video films only the first persona's page, or every page side by side.
    composite?: 'side-by-side';
    // A still draws no pointer unless it points at something on purpose, such as an open menu.
    pointer?: boolean;
    // Runs before the camera rolls, such as opening the app and waiting for it to load.
    setup?: (ctx: SceneContext) => Promise<void>;
    run: (ctx: SceneContext) => Promise<void>;
};
