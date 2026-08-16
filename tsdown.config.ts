import { defineConfig } from "tsdown";

/**
 * Node-half build: plain ESM (`lib/index.js`). The client half is built by
 * `scripts/build-client.mjs` (CJS + `__ModuleLoader__.load` wrapper).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "lib",
  platform: "node",
  dts: false,
  external: [/^@deepseek-ai\//],
  clean: true,
});
