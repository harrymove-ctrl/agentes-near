import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { BlobStore } from "./blob";

/**
 * Platform storage in a folder on this server's disk (`FILES_DIR`), for a
 * self-hosted server without a bucket. Each object is the file at its key,
 * with its content type in a `.type` file beside it (no stored key ends in
 * `.type`). Can't sign URLs: downloads are streamed by the server after its
 * checks.
 */
export function createDiskBlobStore(root: string): BlobStore {
  const base = resolve(root);
  // Parts of some keys come from people (skill file paths): no key reaches outside the folder.
  const pathOf = (key: string) => {
    const path = resolve(base, key);
    if (!path.startsWith(`${base}${sep}`)) throw new Error(`blob key outside the files folder: ${key}`);
    return path;
  };
  const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code ?? "");
  return {
    kind: "disk",
    async put(key, body, { contentType }) {
      const path = pathOf(key);
      // Readable by the server's user alone: other accounts on the host never see uploads.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, body, { mode: 0o600 });
      await writeFile(`${path}.type`, contentType, { mode: 0o600 });
    },
    async get(key) {
      const path = pathOf(key);
      try {
        const [body, contentType] = await Promise.all([readFile(path), readFile(`${path}.type`, "utf8")]);
        return { body: new Uint8Array(body), contentType };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async stream(key) {
      const file = Bun.file(pathOf(key));
      return (await file.exists()) ? file.stream() : null;
    },
    async delete(key) {
      const path = pathOf(key);
      await rm(`${path}.type`, { force: true });
      await rm(path, { force: true });
    },
    async deletePrefix(prefix) {
      const path = pathOf(prefix);
      // Recursive, so the prefix must name its folder as written: `orgs//` resolves to every workspace's folder.
      if (`${relative(base, path).split(sep).join("/")}/` !== prefix) throw new Error(`not a folder prefix: ${prefix}`);
      await rm(path, { recursive: true, force: true });
    },
    async list(prefix, limit = 1000) {
      // Walk the deepest folder the prefix names, then keep the keys that start with the whole prefix.
      const folder = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      let names: string[];
      try {
        names = await readdir(folder ? pathOf(folder) : base, { recursive: true });
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const files = new Set(names);
      return names
        .filter((name) => files.has(`${name}.type`))
        .map((name) => `${folder}${name.split(sep).join("/")}`)
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, limit);
    },
    async signedUrl() {
      return null;
    },
  };
}
