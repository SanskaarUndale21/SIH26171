import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        sidepanel: resolve(__dirname, "sidepanel.html"),
        offscreen: resolve(__dirname, "offscreen.html")
      },
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "manifest.json", dest: "." },
        { src: "public/*", dest: "." }
      ]
    })
  ]
});
