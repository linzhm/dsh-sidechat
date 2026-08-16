// Build the client half programmatically: tsdown CJS bundle + wrap in the DSH
// client-plugin module format. `--watch` rebuilds and rewraps on every change
// (used by the running client-plugin HMR receiver).
import { build } from "tsdown";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "../lib/client.js");

function wrap() {
  const body = readFileSync(OUT, "utf8").trim();
  writeFileSync(
    OUT,
    `window.__ModuleLoader__.load({
\tid: "dsh-sidechat",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`,
  );
  console.log("[dsh-sidechat] wrapped lib/client.js");
}

await build({
  entry: ["src/client.ts"],
  format: ["cjs"],
  outDir: "lib",
  platform: "browser",
  dts: false,
  external: [/^react$/, /^react\//, /^@deepseek-ai\//],
  clean: false,
  outExtensions: () => ({ js: ".js" }),
  watch: process.argv.includes("--watch"),
  hooks: {
    "build:done": () => wrap(),
  },
});
