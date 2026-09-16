import fs from 'node:fs';
import path from 'node:path';

const selected = process.env.REPLAY_PRIVATE_FIXTURE_ROOT;
if (!selected || !path.isAbsolute(selected) || !fs.existsSync(path.join(selected, 'evidence/dual-model-trial'))) {
  throw new Error('Private recorded-input tests require REPLAY_PRIVATE_FIXTURE_ROOT pointing to the separately retained private checkout. Do not copy private records into the public repository.');
}
export const privateFixtureRoot = selected;
