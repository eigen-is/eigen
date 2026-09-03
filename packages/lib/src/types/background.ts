export type ImageBackgroundFill = { type: 'image'; mediaName: string; fit: 'cover' | 'contain' };

export type BackgroundFill =
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | ImageBackgroundFill;

// An element fill is a background fill minus the image variant: a shape paints a colour or a
// two-stop linear gradient, never a picture (the `image` kind is how you put a picture on a canvas).
export type Fill = Exclude<BackgroundFill, ImageBackgroundFill>;
