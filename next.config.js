/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'avatar.vercel.sh' },
    ],
  },
  typedRoutes: false,
}

module.exports = nextConfig
