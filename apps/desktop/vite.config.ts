import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              // Node/native-ish deps that must resolve from node_modules at runtime, not be bundled.
              // youtubei.js powers YouTube search; music-metadata reads local file tags. The
              // packaged build ships the prod-dep closure so these resolve.
              external: ["youtubei.js", "music-metadata"]
            }
          }
        }
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            rollupOptions: {
              output: {
                entryFileNames: "[name].cjs",
                chunkFileNames: "[name].cjs",
                assetFileNames: "[name].[ext]"
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  }
});
