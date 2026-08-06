import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Dev: vite serves the SPA, proxies API to the gateway running on :7800.
    proxy: {
      "/v1": "http://localhost:7800",
      "/admin": "http://localhost:7800",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
