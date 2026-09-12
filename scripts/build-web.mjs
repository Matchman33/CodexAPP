import { build } from "esbuild";

await build({
  entryPoints: ["web/ui-vendor.mjs"], outfile: "web/vendor/chat-ui.js", bundle: true,
  format: "iife", platform: "browser", target: ["safari15", "chrome100"], minify: true,
  legalComments: "eof",
});
console.log("网页依赖构建完成：图标与安全 Markdown 由本地托管。");
