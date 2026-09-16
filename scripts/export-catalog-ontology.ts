/**
 * Portable typed ontology export of the authored preset catalog plus completed actual dual-model trials.
 *
 *   tsx scripts/export-catalog-ontology.ts <new-output-dir> [--trial <name>]...
 *
 * Reads only the files a trial's own index names (never scans a directory), refuses symlinks and paths
 * outside the trial directory, and writes a new immutable directory. No app state, identity, network,
 * model or native calls; nothing is ingested.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPresetCatalog } from "../src/catalog/seed.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  TRIAL_BOUNDS,
  buildOntologyGraph,
  checkGraphIntegrity,
  checkTrialName,
  curatedKnowledgeExport,
  engineReceiptPath,
  fixedTrialPaths,
  referencedTrialPaths,
  sha256Hex,
  type OntologyGraph,
  type TrialFile,
  type TrialInput,
} from "../src/ontology/catalog-projection.ts";

function readContained(base: string, relative: string): string {
  const realBase = fs.realpathSync(base);
  const target = path.resolve(realBase, relative);
  if (!target.startsWith(realBase + path.sep)) throw new Error(`path: ${relative} escapes ${base}`);
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`path: ${relative} is not a regular file`);
  if (fs.realpathSync(target) !== target) throw new Error(`path: ${relative} resolves through a link`);
  if (st.size > TRIAL_BOUNDS.maxFileBytes) throw new Error(`bounds: ${relative} is ${st.size} bytes`);
  return fs.readFileSync(target, "utf8");
}

/** Reads exactly the referenced files of one trial. Validation happens in the pure core. */
export function readTrialInput(root: string, name: string, opts: { engineReceipt?: boolean } = {}): TrialInput {
  checkTrialName(name);
  const dir = path.join(root, "evidence/dual-model-trial", name);
  const fixed = new Map<string, string>(fixedTrialPaths().map((p) => [p, readContained(dir, p)]));
  const paths = referencedTrialPaths(name, { manifest: fixed.get("manifest.json")!, proof: fixed.get("provider-proof.json")!, summary: fixed.get("final/summary.json")! });
  const files: TrialFile[] = paths.map((p) => ({ path: p, text: fixed.get(p) ?? readContained(dir, p) }));
  let engineReceipt: TrialFile | null = null;
  if (opts.engineReceipt !== false) {
    const rp = engineReceiptPath(name);
    if (fs.existsSync(path.join(root, rp))) engineReceipt = { path: rp, text: readContained(path.join(root, "evidence/platform"), path.basename(rp)) };
  }
  return { name, files, engineReceipt };
}

export function exportFiles(graph: OntologyGraph): Record<string, string> {
  const curated = curatedKnowledgeExport(graph);
  const counts = (xs: { type: string }[]) => Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x.type] = (a[x.type] ?? 0) + 1), a), {})).sort(([a], [b]) => (a < b ? -1 : 1));
  const trials = graph.inputs.filter((i) => i.kind === "dual-model-trial");
  return {
    "graph.json": JSON.stringify(graph, null, 2) + "\n",
    "nodes.jsonl": graph.nodes.map((n) => JSON.stringify(n)).join("\n") + "\n",
    "edges.jsonl": graph.edges.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "observations.json": JSON.stringify(graph.observations, null, 2) + "\n",
    "graphiti-curated-messages.json": JSON.stringify(curated, null, 2) + "\n",
    "README.md": [
      "# REPLAY typed ontology projection",
      "",
      `Projection ${graph.projection.id}@${graph.projection.version}; graph sha256 ${graph.graphSha256}.`,
      "",
      graph.notice,
      "",
      `Inputs: ${graph.inputs.map((i) => (i.kind === "preset-catalog" ? `preset catalog ${i.version} (sha256 ${i.sha256})` : `actual trial ${i.name} (game ${i.gameId}, ${i.files} hash-verified files${i.engineReceipt ? ", engine receipt linked" : ", no engine receipt"})`)).join("; ")}.`,
      "",
      "## Nodes", "", ...counts(graph.nodes).map(([t, n]) => `- ${t}: ${n}`), "",
      "## Edges", "", ...counts(graph.edges).map(([t, n]) => `- ${t}: ${n}`), "",
      "## Native ingestion", "",
      curated.notice, "", curated.deterministicImportGap, "",
      `${trials.length ? "Observations are mechanical counts with numerators and denominators (no confidence interval for dependent within-game observations) from one game each; see observations.json." : "No actual trial was included."}`,
      "",
    ].join("\n"),
  };
}

function main(argv: string[]) {
  const out = argv[0];
  if (!out || out.startsWith("--")) throw new Error("Usage: export-catalog-ontology.ts <new-output-dir> [--trial <name>]...");
  if (fs.existsSync(out)) throw new Error("Provide a new output directory; existing exports are immutable");
  const trialNames: string[] = [];
  let withRecords = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--with-records") withRecords = true;
    else if (argv[i] === "--trial" && argv[i + 1]) trialNames.push(checkTrialName(argv[++i]!));
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  const root = process.cwd();
  const trials = trialNames.map((n) => readTrialInput(root, n));
  const graph = buildOntologyGraph({ catalog: createPresetCatalog(), trials });
  const problems = checkGraphIntegrity(graph);
  if (problems.length) throw new Error(`Graph integrity failed: ${problems.slice(0, 5).join("; ")}`);
  const files = exportFiles(graph);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), body, { flag: "wx" });
  const manifest = {
    projection: graph.projection, graphSha256: graph.graphSha256, inputs: graph.inputs, nodes: graph.nodes.length, edges: graph.edges.length, observations: graph.observations.length, nativeIngestion: false,
    files: Object.entries(files).map(([name, body]) => ({ name, bytes: Buffer.byteLength(body), sha256: sha256Hex(body) })),
  };
  if (withRecords) {
    const paths = trials.flatMap(t => [...t.files.map(f => `evidence/dual-model-trial/${t.name}/${f.path}`), ...(t.engineReceipt ? [t.engineReceipt.path] : [])]);
    if (!paths.length) throw new Error('--with-records needs at least one completed trial');
    const archive = path.join(out, 'trial-records.tar.gz');
    // Paths and bytes were checked by readTrialInput/buildOntologyGraph. No directory scan or private config is included.
    execFileSync('tar', ['-czf', path.resolve(archive), '--null', '-T', '-'], {cwd: root, env: {...process.env, COPYFILE_DISABLE: '1'}, input: Buffer.from([...new Set(paths)].sort().join('\0') + '\0')});
    const bytes = fs.readFileSync(archive);
    manifest.files.push({name: 'trial-records.tar.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output: out, ...manifest }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
