// The scenes the capture tool can film, in the order a plain `bun run capture` films them. Each is a plain Scene
// object, such as a still of a drive or a video of two people in one document.

import type { Scene } from '../lib/scene';
import { docsCollabPair } from './docs-collab';
import { docsComment } from './docs-comment';
import { docsHero } from './docs-hero';
import { docsStillDownload, docsStillEquation } from './docs-stills';
import { ROWS } from './rows';
import { sheetsChart } from './sheets-chart';
import { sheetsCollabPair } from './sheets-collab';
import { sheetsHero } from './sheets-hero';
import { sheetsStillBudget, sheetsStillChart } from './sheets-stills';
import { slidesHero } from './slides-hero';
import { slidesPresent } from './slides-present';
import { slidesStillHeading } from './slides-still';
import { suite } from './suite';
import { vectorHero } from './vector-hero';
import { vectorStillSketch } from './vector-still';
import { vectorZoom } from './vector-zoom';

export const SCENES: Scene[] = [
    sheetsHero,
    sheetsCollabPair,
    sheetsChart,
    sheetsStillBudget,
    sheetsStillChart,
    docsHero,
    docsCollabPair,
    docsComment,
    docsStillEquation,
    docsStillDownload,
    slidesHero,
    slidesPresent,
    slidesStillHeading,
    vectorHero,
    vectorZoom,
    vectorStillSketch,
    suite,
    ...ROWS,
];
