import { defineConfig } from "astro/config";
import AstroPWA from "@vite-pwa/astro";

export default defineConfig({
  site: "https://guitare-songbook.guitare-songbook.workers.dev",
  integrations: [
    AstroPWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/icon.svg"],
      manifest: {
        name: "Guitare Songbook",
        short_name: "Songbook",
        description: "适合手机、平板和电脑使用的私人吉他级数歌谱库",
        lang: "zh-CN",
        theme_color: "#123b5d",
        background_color: "#f4f0e8",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{html,css,js,json,svg,woff2}"],
        navigateFallback: "/",
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.map((entry) => {
              const looksLikeDirectoryRoute =
                !entry.url.includes(".") &&
                entry.url !== "/" &&
                !entry.url.endsWith("/");
              return looksLikeDirectoryRoute
                ? { ...entry, url: `${entry.url}/` }
                : entry;
            }),
            warnings: []
          })
        ],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === "document",
            handler: "NetworkFirst",
            options: {
              cacheName: "song-pages",
              networkTimeoutSeconds: 3
            }
          }
        ]
      }
    })
  ]
});
