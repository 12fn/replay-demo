/** In-memory synthetic source archive plus temporary graph binding, never private trial data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createPresetCatalog} from '../../src/catalog/seed';
import {buildOntologyGraph} from '../../src/ontology/catalog-projection';
import {syntheticTrial} from './synthetic-trial';
import {tarOf, sha} from './synthetic-tar';

export function syntheticSourceFixture() {
  const trial = syntheticTrial();
  const graph = buildOntologyGraph({catalog: createPresetCatalog(), trials: [trial]});
  const graphBytes = Buffer.from(JSON.stringify(graph));
  const sources = new Map(trial.files.map(f => [`evidence/dual-model-trial/${trial.name}/${f.path}`, f.text]));
  const archiveBytes = gzipSync(tarOf([...sources].map(([repoPath, body]) => ({
    name: path.posix.basename(repoPath), prefix: path.posix.dirname(repoPath), body, pax: {},
  }))));
  const archive = {name: 'trial-records.tar.gz', sha256: sha(archiveBytes), bytes: archiveBytes.length};
  const manifest = {graphSha256: graph.graphSha256, nativeIngestion: false, files: [
    {name: 'graph.json', sha256: sha(graphBytes), bytes: graphBytes.length}, archive,
  ]};
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-synthetic-source-'));
  const graphPath = path.join(dir, 'graph.json'), manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(graphPath, graphBytes);
  fs.writeFileSync(manifestPath, manifestBytes);
  return {graph, graphBytes, manifest, manifestBytes, archive, archiveBytes, sources, graphPath, manifestPath,
    dispose: () => fs.rmSync(dir, {recursive: true, force: true})};
}
