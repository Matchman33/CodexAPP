import { build } from "esbuild";
import fs from "node:fs/promises";

await build({
  entryPoints: ["web/ui-vendor.mjs"], outfile: "web/vendor/chat-ui.js", bundle: true,
  format: "iife", platform: "browser", target: ["safari15", "chrome100"], minify: true,
  legalComments: "eof",
});
await build({ entryPoints: ["web/terminal-vendor.mjs"], outfile: "web/vendor/terminal.js", bundle: true,
  format: "iife", platform: "browser", target: ["safari15", "chrome100"], minify: true, legalComments: "eof" });
await fs.copyFile("node_modules/@xterm/xterm/css/xterm.css", "web/vendor/terminal.css");
console.log("网页依赖构建完成：图标与安全 Markdown 由本地托管。");
