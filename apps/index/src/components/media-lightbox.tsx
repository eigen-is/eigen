// A picture or film from a page of the public site, shown bigger in the quick preview lightbox the apps use, with its
// caption as the title and no actions. Opened from a group, such as a media grid or a carousel, it pages through the
// group. A film plays with controls unless the reader asked for less motion, and a looping one stays a muted loop.
// The corner button that opens one, which shows while the pointer is over it, lives here too.

import { useMediaQuery } from '@workspace/lib/media';
import { PreviewLightbox, previewFitStyle } from '@workspace/ui/components/preview-lightbox';
import { Maximize } from 'lucide-react';
import { useState } from 'react';
import type { MediaItem } from '../../scripts/lib/content-types';
import { splitKetNames } from './ket-names';

export type LightboxItem = MediaItem & { loop?: boolean };

// Opens the page's lightbox on one item of a group, such as a grid's.
export type OpenLightbox = (items: readonly LightboxItem[], index: number) => void;

type MediaLightboxProps = {
    items: readonly LightboxItem[];
    index: number;
    onIndexChange: (index: number) => void;
    onClose: () => void;
};

export function MediaLightbox({ items, index, onIndexChange, onClose }: MediaLightboxProps) {
    const item = items[index];
    return (
        <PreviewLightbox
            title={<Caption text={item.caption} />}
            hasPrev={index > 0}
            hasNext={index < items.length - 1}
            onPrev={() => onIndexChange(index - 1)}
            onNext={() => onIndexChange(index + 1)}
            onClose={onClose}
        >
            <LightboxMedia key={item.src} item={item} />
        </PreviewLightbox>
    );
}

// The site stores no sizes, so a picture or film fits the lightbox once it has loaded enough to give its shape.
function LightboxMedia({ item }: { item: LightboxItem }) {
    const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const [ratio, setRatio] = useState<number>();
    const style = previewFitStyle(ratio);
    if (item.type === 'image') {
        return (
            <img
                src={item.src}
                alt={item.caption}
                className="rounded"
                style={style}
                onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
            />
        );
    }
    return (
        <video
            src={item.src}
            poster={item.poster}
            controls
            playsInline
            autoPlay={!reduceMotion}
            muted={item.loop}
            loop={item.loop}
            aria-label={item.caption}
            className="rounded"
            style={style}
            onLoadedMetadata={(e) => setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
        />
    );
}

// The Markdown's own pictures get the same button from the build, so the two keep one label and icon.
export function ExpandButton({ onClick }: { onClick: () => void }) {
    return (
        <button type="button" className="media-expand" aria-label="Full screen" title="Full screen" onClick={onClick}>
            <Maximize aria-hidden="true" />
        </button>
    );
}

// A caption as text, with each app name in the class the site's prose gives app names.
export function Caption({ text }: { text: string }) {
    return splitKetNames(text).map((part, i) =>
        i % 2 ? (
            <span key={i} className="ket-name">
                {part}
            </span>
        ) : (
            part
        ),
    );
}
