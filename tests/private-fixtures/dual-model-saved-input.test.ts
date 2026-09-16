import {it, expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {gameStatus, rebuildSavedRound} from '../../scripts/dual-model-trial';
import {privateFixtureRoot} from './root';
const readJson = <T>(dir: string, file: string): T => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  it('still reads the saved actual six-round default game unchanged', () => {
    const dir = path.join(privateFixtureRoot, 'evidence/dual-model-trial/dual-sol-blue-opus-red-20260915');
    const s = gameStatus(dir);
    expect(s.manifest.config).toEqual({ maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001' });
    expect(readJson<any>(dir, 'initialization/game.json')).not.toHaveProperty('scenario');
  });

it.each(['dual-sol-blue-opus-red-20260915', 'taiwan-sol-blue-opus-red-full-20260915', 'taiwan-paired-20260915-pair0002-opus-blue-sol-red'])(
  'rebuilds the separately retained private no-flag game %s byte for byte', async name => {
    const dir = path.join(privateFixtureRoot, 'evidence/dual-model-trial', name);
    const m = gameStatus(dir).manifest, last = m.cursor ? m.cursor.round : m.history.length - 1;
    expect(m.config).not.toHaveProperty('observationProfile');
    for (const k of [...new Set([0, 1, last])]) {
      const rebuilt = await rebuildSavedRound(dir, k);
      for (const seat of ['blue', 'red'] as const) {
        const prefix = path.join(dir, 'rounds', String(k).padStart(2, '0'), seat);
        expect(rebuilt[seat].snapshot).toBe(fs.readFileSync(path.join(prefix, 'snapshot.json'), 'utf8'));
        expect(rebuilt[seat].prompt).toBe(fs.readFileSync(path.join(prefix, 'prompt.md'), 'utf8'));
        expect(rebuilt[seat].snapshot).not.toContain('roundContext');
      }
    }
  }, 600_000,
);
