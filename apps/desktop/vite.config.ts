import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    // three.js is one chunk of about 740 kB, loaded only when a 3D preview is
    // opened, never with the window. The window's own chunk stays well under.
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
