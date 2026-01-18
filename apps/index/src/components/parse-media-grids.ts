interface MediaItem {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    thumbnail?: string;
    poster?: string;
}

interface MediaGridData {
    columns: string;
    items: MediaItem[];
}

export function parseMediaGrids(markdown: string): {
    content: string;
    mediaGrids: MediaGridData[];
} {
    const mediaGrids: MediaGridData[] = [];
    let gridIndex = 0;

    const regex = /<media-grid\s+columns="(\d+)">([\s\S]*?)<\/media-grid>/g;

    const content = markdown.replace(regex, (_match, columns, innerContent) => {
        const mediaRegex = /<media\s+([\s\S]+?)\/>/g;
        const items: MediaItem[] = [];

        let mediaMatch;
        while ((mediaMatch = mediaRegex.exec(innerContent)) !== null) {
            const attrs = mediaMatch[1];
            const item: any = {type: 'image'};

            const srcMatch = attrs.match(/src="([^"]+)"/);
            if (srcMatch) item.src = srcMatch[1];

            const typeMatch = attrs.match(/type="([^"]+)"/);
            if (typeMatch) item.type = typeMatch[1];

            const captionMatch = attrs.match(/caption="([^"]+)"/);
            if (captionMatch) item.caption = captionMatch[1];

            const thumbnailMatch = attrs.match(/thumbnail="([^"]+)"/);
            if (thumbnailMatch) item.thumbnail = thumbnailMatch[1];

            const thumbMatch = attrs.match(/thumb="([^"]+)"/);
            if (thumbMatch) item.thumbnail = thumbMatch[1];

            const posterMatch = attrs.match(/poster="([^"]+)"/);
            if (posterMatch) item.poster = posterMatch[1];

            items.push(item);
        }

        mediaGrids.push({columns, items});

        return `\n\n[MEDIAGRID:${gridIndex++}]\n\n`;
    });

    return {content, mediaGrids};
}
