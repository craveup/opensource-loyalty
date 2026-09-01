import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Relative assets keep the Admin bundle beneath a managed tenant prefix as
  // well as the standalone /admin/ mount.
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../packages/server/dist/admin",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    proxy: {
      "/admin/api": "http://127.0.0.1:3210"
    }
  }
});
