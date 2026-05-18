export type BackgroundFill =
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'image'; mediaName: string; fit: 'cover' | 'contain' };
