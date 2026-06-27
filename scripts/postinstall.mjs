import { access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const astGrepBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "sg.cmd" : "sg");
try {
  await access(astGrepBin);
} catch {
  console.warn("@swiftengineer/pi-harness: ast-grep binary was not found; ast tools will fail until dependencies are installed.");
}
