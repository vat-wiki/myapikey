import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    // Dev: vite serves the SPA, proxies API to the gateway running on :7800.
    proxy: {
      "/v1": "http://localhost:7800",
      "/admin": "http://localhost:7800",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
