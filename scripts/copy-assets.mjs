import { copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "pdfjs-dist");
const destination = join(root, "dist", "vendor", "pdfjs");
const licenses = join(root, "dist", "licenses");

// Recreate copied assets so dependency upgrades cannot leave obsolete files behind.
await rm(destination, { recursive: true, force: true });
await rm(licenses, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await mkdir(licenses, { recursive: true });
await Promise.all([
  copyFile(join(source, "build", "pdf.min.mjs"), join(destination, "pdf.min.mjs")),
  copyFile(join(source, "build", "pdf.worker.min.mjs"), join(destination, "pdf.worker.min.mjs")),
  copyFile(join(source, "LICENSE"), join(destination, "LICENSE.pdfjs")),
  cp(join(source, "cmaps"), join(destination, "cmaps"), { recursive: true, force: true }),
  cp(join(source, "standard_fonts"), join(destination, "standard_fonts"), { recursive: true, force: true }),
  cp(join(source, "wasm"), join(destination, "wasm"), { recursive: true, force: true }),
  cp(join(source, "iccs"), join(destination, "iccs"), { recursive: true, force: true })
]);

// Preserve the licenses of packages whose code was included in the bundle.
const metadata = JSON.parse(await readFile(join(root, "dist", "extension.meta.json"), "utf8"));
const packages = new Set();
for (const output of Object.values(metadata.outputs)) {
  for (const [filename, input] of Object.entries(output.inputs)) {
    const match = filename.replaceAll("\\", "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match && input.bytesInOutput > 0) { packages.add(match[1]); }
  }
}

for (const directory of [...packages].sort()) {
  const packageRoot = join(root, directory);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const name = manifest.name.replaceAll("/", "__");
  const files = (await readdir(packageRoot)).filter(filename => /^(licen[cs]e|notice|copying)(?:[.-]|$)/i.test(filename));
  if (files.length) {
    await Promise.all(files.map(filename => copyFile(join(packageRoot, filename),
      join(licenses, `${name}@${manifest.version}-${filename}`))));
  } else {
    // Some npm packages omit their license file; retain a checked-in upstream copy.
    // @nodable/entities: https://github.com/nodable/val-parsers/blob/main/LICENSE
    await copyFile(join(root, "resources", "licenses", `${name}.txt`),
      join(licenses, `${name}@${manifest.version}-LICENSE`));
  }
}
