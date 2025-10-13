# Blog Media Files

Place your blog post images and videos in subdirectories named after the blog post ID.

## Directory Structure

```
media/
  ├── 2025-10-03-eigen-proof-of-concept/
  │   ├── screenshot1.jpg
  │   ├── screenshot2.jpg
  │   └── demo.mp4
  └── another-blog-post/
      └── image.jpg
```

## Usage in Markdown

### Single Media Item

```html
<media src="/blog/media/2025-10-03-eigen-proof-of-concept/screenshot1.jpg" type="image" caption="Optional caption text" />
```

### With Thumbnail (Optimized Loading)

For images, use a smaller thumbnail in the grid and show high-res in lightbox:

```html
<media 
  src="/blog/media/post-id/image-fullres.jpg" 
  thumbnail="/blog/media/post-id/image-thumb.jpg" 
  type="image" 
  caption="High quality image" />
```

### Video with Poster Image

For videos, use a poster image to avoid loading the video until clicked:

```html
<media 
  src="/blog/media/post-id/demo.mp4" 
  poster="/blog/media/post-id/demo-poster.jpg" 
  type="video" 
  caption="Demo video" />
```

### Media Grid (Multiple Items)

```html
<media-grid columns="2">
  <media 
    src="/blog/media/post-id/screenshot1-fullres.jpg" 
    thumbnail="/blog/media/post-id/screenshot1-thumb.jpg"
    type="image" 
    caption="Dashboard view" />
  <media 
    src="/blog/media/post-id/screenshot2-fullres.jpg" 
    thumbnail="/blog/media/post-id/screenshot2-thumb.jpg"
    type="image" 
    caption="Settings page" />
  <media 
    src="/blog/media/post-id/demo.mp4" 
    poster="/blog/media/post-id/demo-poster.jpg"
    type="video" 
    caption="Demo video" />
</media-grid>
```

### Supported Columns

- `columns="1"` - Single column
- `columns="2"` - 2 columns on desktop, 1 on mobile (default)
- `columns="3"` - 3 columns on large screens, 2 on tablet, 1 on mobile
- `columns="4"` - 4 columns on large screens, 2 on tablet, 1 on mobile

### Supported Media Types

- `type="image"` - For images (jpg, png, gif, webp, etc.)
- `type="video"` - For videos (mp4, webm, etc.)

### Attributes

- `src` (required) - Full resolution image or video URL (shown in lightbox)
- `type` (required) - Either "image" or "video"
- `caption` (optional) - Text shown below the media item
- `thumbnail` or `thumb` (optional) - Smaller image shown in grid (for images only)
- `poster` (optional) - Poster image shown for videos (video only loads in lightbox)

### Features

- **Click to enlarge**: Clicking on any media item opens it in a full-screen preview
- **Responsive grid**: Grid automatically adjusts to screen size
- **Captions**: Optional captions appear below each media item
- **Hover effects**: Subtle scaling effect on hover for images, play button overlay for videos
- **Optimized loading**: Use thumbnails for faster page loads, full-res only in lightbox
- **Video posters**: Videos show poster image and only load when opened
