import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "pdfjs-dist");
const destination = join(root, "out", "vendor", "pdfjs");

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(join(source, "build", "pdf.min.mjs"), join(destination, "pdf.min.mjs")),
  copyFile(join(source, "build", "pdf.worker.min.mjs"), join(destination, "pdf.worker.min.mjs")),
  copyFile(join(source, "LICENSE"), join(destination, "LICENSE.pdfjs")),
  cp(join(source, "cmaps"), join(destination, "cmaps"), { recursive: true, force: true }),
  cp(join(source, "standard_fonts"), join(destination, "standard_fonts"), { recursive: true, force: true }),
  cp(join(source, "wasm"), join(destination, "wasm"), { recursive: true, force: true }),
  cp(join(source, "iccs"), join(destination, "iccs"), { recursive: true, force: true })
]);
