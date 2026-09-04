import type { FillStyle } from '../vector/types';

export type BackgroundFill =
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'image'; mediaName: string; fit: 'cover' | 'contain' };

// The paint half of a fill: a background minus the image variant — a shape paints a colour or a
// two-stop linear gradient, never a picture (the `image` kind is how you put a picture on a canvas).
export type FillPaint = Exclude<BackgroundFill, { type: 'image' }>;

// An element fill: that paint PLUS the hatch style roughjs draws it with, one stored JSON scalar.
// Distributive, so `fill.type === 'gradient'` still narrows to the gradient stops.
type WithFillStyle<T> = T extends unknown ? T & { style: FillStyle } : never;
export type Fill = WithFillStyle<FillPaint>;
