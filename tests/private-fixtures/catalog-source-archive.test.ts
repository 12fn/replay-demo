import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {extractVerifiedSource} from '../../src/server/catalog-source-archive';
import {privateFixtureRoot} from './root';
const REJECTED = 'Source archive verification failed';
describe("existing handoff archive (regression)", () => {
  const archive = readFileSync(privateFixtureRoot + "/handoff/REPLAY-catalog-ontology-4/trial-records.tar.gz");
  const handoff = JSON.parse(readFileSync(privateFixtureRoot + "/handoff/REPLAY-catalog-ontology-4/manifest.json", "utf8")) as {
    files: { name: string; sha256: string }[];
    inputs: { kind: string; name?: string; manifestSha256?: string; summarySha256?: string }[];
  };
  const archiveSha256 = handoff.files.find((f) => f.name === "trial-records.tar.gz")!.sha256;
  const trial = handoff.inputs.find((i) => i.name === "feedback-20260915-held0001-v1-opus-blue-sol-red")!;

  it("is pinned to the published handoff hash", () => {
    expect(archiveSha256).toBe("c5befa2186e5fedb658e93cfac5251059bf21c66580a61dd42ec82237cd672c3");
  });

  it("extracts a real trial summary matching the handoff manifest's independent hash", () => {
    const result = extractVerifiedSource(archive, {
      archiveSha256,
      path: `evidence/dual-model-trial/${trial.name}/final/summary.json`,
      sha256: trial.summarySha256!,
      bytes: 29075,
    });
    expect(result.sha256).toBe(trial.summarySha256);
    expect(result.bytes).toBe(29075);
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("extracts a member whose path lives entirely in the ustar name field", () => {
    const result = extractVerifiedSource(archive, {
      archiveSha256,
      path: `evidence/dual-model-trial/${trial.name}/manifest.json`,
      sha256: trial.manifestSha256!,
      bytes: 19595,
    });
    expect(result.sha256).toBe(trial.manifestSha256);
  });

  it("rejects a single flipped byte in the real archive", () => {
    const flipped = Buffer.from(archive);
    flipped[flipped.length >> 1] ^= 0xff;
    expect(() =>
      extractVerifiedSource(flipped, { archiveSha256, path: "evidence/x.json", sha256: trial.summarySha256!, bytes: 1 }),
    ).toThrow(REJECTED);
  });
});
