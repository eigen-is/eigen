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
            const srcMatch = attrs.match(/src="([^"]+)"/);
            const typeMatch = attrs.match(/type="([^"]+)"/);
            const captionMatch = attrs.match(/caption="([^"]+)"/);
            const thumbnailMatch = attrs.match(/thumbnail="([^"]+)"/);
            const thumbMatch = attrs.match(/thumb="([^"]+)"/);
            const posterMatch = attrs.match(/poster="([^"]+)"/);

            const item: MediaItem = {
                src: srcMatch ? srcMatch[1] : '',
                type: (typeMatch?.[1] === 'video' ? 'video' : 'image'),
                caption: captionMatch?.[1],
                thumbnail: thumbnailMatch?.[1] ?? thumbMatch?.[1],
                poster: posterMatch?.[1],
            };

            items.push(item);
        }

        mediaGrids.push({columns, items});

        return `\n\n[MEDIAGRID:${gridIndex++}]\n\n`;
    });

    return {content, mediaGrids};
}
