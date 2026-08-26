import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const portableRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(portableRoot, "upstream-sync.json"), "utf8"),
);
const localOverride = await readJsonIfPresent(join(portableRoot, "UPSTREAM.local.json"));
const upstreamRoot = resolve(
  portableRoot,
  process.env.BELKI_UPSTREAM_PATH ?? localOverride?.path ?? manifest.defaultPath,
);
const apply = process.argv.includes("--apply");

const sourceFiles = await expandPaths(upstreamRoot, manifest.paths);
if (apply) {
  for (const path of sourceFiles) {
    const destination = join(portableRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(upstreamRoot, path), destination);
  }
}

const portableFiles = await expandPaths(portableRoot, manifest.paths);
const sourceSet = new Set(sourceFiles);
const portableSet = new Set(portableFiles);
const drift = [];
for (const path of [...new Set([...sourceFiles, ...portableFiles])].sort()) {
  if (!sourceSet.has(path)) {
    drift.push(`${path}: only in portable repository`);
    continue;
  }
  if (!portableSet.has(path)) {
    drift.push(`${path}: missing from portable repository`);
    continue;
  }
  const [source, portable] = await Promise.all([
    readFile(join(upstreamRoot, path)),
    readFile(join(portableRoot, path)),
  ]);
  if (!source.equals(portable)) drift.push(`${path}: content differs`);
}

const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: upstreamRoot }))
  .stdout.trim();
const treeHash = await checksumTree(upstreamRoot, sourceFiles);
const recordPath = join(portableRoot, "UPSTREAM.json");
const record = await readJsonIfPresent(recordPath);
if (!apply) {
  if (!record) drift.push("UPSTREAM.json: missing sync record");
  else {
    if (record.repository !== manifest.repository) {
      drift.push("UPSTREAM.json: repository does not match the sync manifest");
    }
    if (record.commit !== commit) drift.push("UPSTREAM.json: source commit is stale");
    if (record.treeHash !== treeHash) drift.push("UPSTREAM.json: allowlisted tree hash is stale");
    if (record.files !== sourceFiles.length) drift.push("UPSTREAM.json: file count is stale");
  }
}

if (drift.length > 0) {
  console.error(`Upstream sync drift (${drift.length} files):`);
  for (const item of drift) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    upstreamRoot,
    commit,
    treeHash,
    files: sourceFiles.length,
  }, null, 2));
  if (apply) {
    await writeFile(recordPath, `${JSON.stringify({
      repository: manifest.repository,
      commit,
      treeHash,
      files: sourceFiles.length,
    }, null, 2)}\n`);
  }
}

async function expandPaths(root, paths) {
  const files = [];
  for (const path of paths) {
    const absolute = join(root, path);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      files.push(...await walk(root, absolute));
    } else {
      files.push(relative(root, absolute));
    }
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

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}
