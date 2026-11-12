import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5175,
    open: false,
  },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});

