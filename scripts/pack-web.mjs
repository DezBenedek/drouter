import "./build-style.mjs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { transform, build } from "../cloud/node_modules/esbuild/lib/main.js";
await build({
  entryPoints: ["scripts/browser-crypto.js"],
  bundle: true,
  minify: true,
  format: "esm",
  legalComments: "none",
  outfile: "firmware/web/shared/crypto.js",
});
const generated = "firmware/web/shared/auth.js";
// wasm-bindgen emits readable JS; leave already-minified bindings untouched.
// Re-minifying the checked-in binding renamed symbols on every asset rebuild.
const binding = await readFile(generated, "utf8");
if (binding.split("\n").length > 3)
  await writeFile(
    generated,
    (
      await transform(binding, {
        minify: true,
        legalComments: "none",
        format: "esm",
      })
    ).code,
  );
async function pack(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = `${path}/${entry.name}`;
    if (entry.isDirectory()) await pack(file);
    else if (!file.endsWith(".gz")) {
      let content = await readFile(file);
      // Ship minified JS without replacing the readable, reviewable source files.
      if (
        file.endsWith(".js") &&
        !file.endsWith("/auth.js") &&
        !file.endsWith("/crypto.js")
      )
        content = Buffer.from(
          (
            await transform(content.toString(), {
              minify: true,
              legalComments: "none",
              format: "esm",
            })
          ).code,
        );
      await writeFile(`${file}.gz`, gzipSync(content, { level: 9, mtime: 0 }));
    }
  }
}
await pack("firmware/web");
