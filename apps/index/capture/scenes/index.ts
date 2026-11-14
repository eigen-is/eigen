// The scenes the capture tool can film, in the order a plain `bun run capture` films them. Each is a plain Scene
// object, such as a still of a drive or a video of two people in one document.

import type { Scene } from '../lib/scene';
import { ROWS } from './rows';
import { sheetsChart } from './sheets-chart';
import { sheetsCollabPair } from './sheets-collab';
import { sheetsHero } from './sheets-hero';
import { sheetsStillBudget, sheetsStillChart } from './sheets-stills';
import { suite } from './suite';

export const SCENES: Scene[] = [
    sheetsHero,
    sheetsCollabPair,
    sheetsChart,
    sheetsStillBudget,
    sheetsStillChart,
    suite,
    ...ROWS,
];
