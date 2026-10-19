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
await writeFile(
  generated,
  (
    await transform(await readFile(generated, "utf8"), {
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
    else if (!file.endsWith(".gz"))
      await writeFile(
        `${file}.gz`,
        gzipSync(await readFile(file), { level: 9, mtime: 0 }),
      );
  }
}
await pack("firmware/web");
