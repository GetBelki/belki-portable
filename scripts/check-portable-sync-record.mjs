import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const portableRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(portableRoot, "upstream-sync.json"), "utf8"),
);
const record = JSON.parse(
  await readFile(join(portableRoot, "UPSTREAM.json"), "utf8"),
);
const files = await expandPaths(portableRoot, manifest.paths);
const treeHash = await checksumTree(portableRoot, files);
const failures = [];

if (record.repository !== manifest.repository) {
  failures.push("repository does not match upstream-sync.json");
}
if (record.files !== files.length) {
  failures.push(`file count is ${files.length}; expected ${record.files}`);
}
if (record.treeHash !== treeHash) {
  failures.push(`tree checksum is ${treeHash}; expected ${record.treeHash}`);
}
if (!/^[0-9a-f]{40}$/u.test(record.commit)) {
  failures.push("recorded upstream commit is not a full Git SHA");
}

if (failures.length > 0) {
  console.error("Portable upstream record validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    repository: record.repository,
    commit: record.commit,
    treeHash,
    files: files.length,
  }, null, 2));
}

async function expandPaths(root, paths) {
  const files = [];
  for (const path of paths) {
    const absolute = join(root, path);
    const info = await stat(absolute);
    if (info.isDirectory()) files.push(...await walk(root, absolute));
    else files.push(relative(root, absolute));
  }
  return files.sort();
}

async function walk(root, directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
  return files;
}

async function checksumTree(root, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
