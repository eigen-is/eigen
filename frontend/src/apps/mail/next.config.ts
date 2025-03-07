import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  basePath: '/mail',
  assetPrefix: '/mail',
  trailingSlash: true,
  /* export */
  output: 'export',
  distDir: 'build',
  
};

export default nextConfig;
