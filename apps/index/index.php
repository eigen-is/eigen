<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Default metadata
$title = "eigen";
$description = "Eigen is your minimal, secure workspace in the cloud. Simple and secure. You control your data.";
$url = "https://eigen.is";
$type = "website";

// Check if it's a blog post
if (preg_match('#^/blog/([^/]+)$#', $path, $matches)) {
    $postId = $matches[1];
    
    // Load blog post metadata from JSON file
    $blogMetaPath = __DIR__ . '/blog-meta.json';
    if (file_exists($blogMetaPath)) {
        $blogData = json_decode(file_get_contents($blogMetaPath), true);
        
        if (isset($blogData[$postId])) {
            $post = $blogData[$postId];
            $title = htmlspecialchars($post['title']) . " - eigen blog";
            $description = htmlspecialchars($post['summary']);
            $url = "https://eigen.is/blog/" . urlencode($postId);
            $type = "article";
        }
    }
} elseif ($path === '/blog' || $path === '/blog/') {
    $title = "Blog - eigen";
    $description = "Read about the development of eigen, a minimal and secure workspace in the cloud where you control your own data.";
    $url = "https://eigen.is/blog";
}
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8"/>
    <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
    <link href="/favicon.svg" rel="icon" type="image/svg+xml">
    <title><?= $title ?></title>

    <meta name="description" content="<?= $description ?>">

    <meta property="og:title" content="<?= $title ?>" />
    <meta property="og:description" content="<?= $description ?>" />
    <meta property="og:type" content="<?= $type ?>" />
    <meta property="og:url" content="<?= $url ?>" />
    <meta property="og:image" content="https://eigen.is/eigen-space-logo.svg" />
    <meta property="og:image:width" content="400" />
    <meta property="og:image:height" content="100" />
</head>

<body>
<div id="app"></div>
<script src="/src/main.tsx" type="module"></script>
</body>
</html>
