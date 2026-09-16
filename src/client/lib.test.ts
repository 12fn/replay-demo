import { describe, expect, it } from 'vitest';
import type { ExerciseSummary, GameState } from './api';
import {
  MAP_RGBA,
  commandAuthority,
  commitmentRatio,
  currentReportsAt,
  detailEntries,
  fitRect,
  hasMapData,
  hasLandBorder,
  lineage,
  ownerSide,
  paintMap,
  resolveEvidence,
  tickClock,
  tileToXY,
  truncate,
  xyToTile,
} from './lib';

describe('historical source availability',()=>{
  it('does not let a later correction erase what was current at the decision',()=>{
    const reports=[{id:'initial',tick:1},{id:'revision',tick:300,supersedes:'initial'},{id:'later',tick:600,supersedes:'revision'}];
    expect(currentReportsAt(reports,200).map(r=>r.id)).toEqual(['initial']);
    expect(currentReportsAt(reports,381).map(r=>r.id)).toEqual(['revision']);
    expect(currentReportsAt(reports,600).map(r=>r.id)).toEqual(['later']);
    expect(currentReportsAt(reports,0)).toEqual([]);
  });
});

function state(partial: Partial<GameState> = {}): GameState {
  return {
    tick: 0,
    fingerprint: 'abc',
    simulationId: 'SIM',
    map: 'plains',
    width: 3,
    height: 2,
    spawning: false,
    players: [
      { side: 'blue', id: 'b', name: 'Blue', smallId: 1, tiles: 1, troops: 10, gold: 0, maxTroops: 100, spawn: 0, alive: true, attacks: [], units: [] },
      { side: 'red', id: 'r', name: 'Red', smallId: 2, tiles: 1, troops: 10, gold: 0, maxTroops: 100, spawn: 5, alive: true, attacks: [], units: [] },
    ],
    owners: [1, 0, 0, 0, 0, 2],
    land: [1, 1, 0, 0, 1, 1],
    ...partial,
  };
}

describe('tile math', () => {
  it('round-trips tile <-> x,y using y*width+x like the engine', () => {
    expect(tileToXY(5, 3)).toEqual({ x: 2, y: 1 });
    expect(xyToTile(2, 1, 3)).toBe(5);
    expect(tileToXY(0, 3)).toEqual({ x: 0, y: 0 });
  });

  it('formats ticks as m:ss at 10 ticks per second', () => {
    expect(tickClock(0)).toBe('0:00');
    expect(tickClock(95)).toBe('0:09');
    expect(tickClock(6100)).toBe('10:10');
  });
});

describe('ownership', () => {
  it('maps engine smallIds to sides, 0 = unowned', () => {
    const s = state();
    expect(ownerSide(s, 0)).toBe('blue');
    expect(ownerSide(s, 5)).toBe('red');
    expect(ownerSide(s, 1)).toBeNull();
  });
});

describe('paintMap', () => {
  it('colours water, land, and owned tiles from backend arrays', () => {
    const s = state();
    const out = new Uint8ClampedArray(s.width * s.height * 4);
    paintMap(s, out);
    const px = (i: number) => Array.from(out.slice(i * 4, i * 4 + 4));
    expect(px(0)).toEqual([...MAP_RGBA.blue]);
    expect(px(1)).toEqual([...MAP_RGBA.land]);
    expect(px(2)).toEqual([...MAP_RGBA.water]);
    expect(px(5)).toEqual([...MAP_RGBA.red]);
  });

  it('marks owners that match no known player distinctly rather than as a side', () => {
    const s = state({ owners: [7, 0, 0, 0, 0, 0] });
    const out = new Uint8ClampedArray(s.width * s.height * 4);
    paintMap(s, out);
    expect(Array.from(out.slice(0, 4))).toEqual([...MAP_RGBA.unknownOwner]);
  });
});

describe('hasMapData', () => {
  it('requires arrays sized to width*height', () => {
    expect(hasMapData(state())).toBe(true);
    expect(hasMapData(state({ owners: [1] }))).toBe(false);
    expect(hasMapData(undefined)).toBe(false);
  });
});

describe('fitRect', () => {
  it('preserves aspect ratio and centres in the box', () => {
    const r = fitRect(200, 100, 400, 400);
    expect(r.scale).toBe(2);
    expect(r).toMatchObject({ x: 0, y: 100, w: 400, h: 200 });
  });
  it('handles empty boxes without NaN', () => {
    expect(fitRect(10, 10, 0, 0).scale).toBe(0);
  });
});

describe('commandAuthority (mirrors backend refusal rules)', () => {
  const live = { kind: 'live', status: 'running' } as const;
  it('allows a commander on a running live exercise at the live tick', () => {
    expect(commandAuthority({ role: 'commander', playbackTick: null, exercise: live })).toEqual({ allowed: true, reason: null });
  });
  it('refuses the intelligence seat', () => {
    expect(commandAuthority({ role: 'intelligence', playbackTick: null, exercise: live }).allowed).toBe(false);
  });
  it('refuses while a historical tick is displayed, even for instructors', () => {
    const r = commandAuthority({ role: 'instructor', playbackTick: 120, exercise: live });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/historical/i);
  });
  it('refuses recorded and non-running exercises', () => {
    expect(commandAuthority({ role: 'commander', playbackTick: null, exercise: { kind: 'recorded', status: 'completed' } }).reason).toMatch(/recorded/i);
    expect(commandAuthority({ role: 'commander', playbackTick: null, exercise: { kind: 'branch', status: 'fault' } }).reason).toMatch(/fault/);
    expect(commandAuthority({ role: 'commander', playbackTick: null, exercise: undefined }).allowed).toBe(false);
  });
});

describe('lineage', () => {
  const exercises: ExerciseSummary[] = [
    { id: 'a', name: 'Original', kind: 'live', status: 'running', tick: 900, humanSide: 'blue' },
    { id: 'b', name: 'Original · red branch', kind: 'branch', status: 'running', tick: 500, humanSide: 'red', parentId: 'a', forkTick: 400 },
    { id: 'c', name: 'Other', kind: 'recorded', status: 'completed', tick: 30, humanSide: 'blue' },
  ];
  it('links a branch to its source and fork tick', () => {
    const l = lineage(exercises, 'b');
    expect(l?.source?.id).toBe('a');
    expect(l?.forkTick).toBe(400);
    expect(l?.branches).toEqual([]);
  });
  it('lists branches of an original and reports no fork', () => {
    const l = lineage(exercises, 'a');
    expect(l?.source).toBeUndefined();
    expect(l?.forkTick).toBeNull();
    expect(l?.branches.map((b) => b.id)).toEqual(['b']);
  });
  it('returns null for an unknown active id', () => {
    expect(lineage(exercises, 'zzz')).toBeNull();
  });
});

describe('resolveEvidence', () => {
  const data = {
    timeline: [{ id: 'ev1', tick: 40, kind: 'command', summary: 'Committed 1,200 forces against the opposing player' }],
    reports: [{ id: 'br:rep1', tick: 10, title: 'Initial resource estimate', parentSourceId: 'rep1' }],
  };
  it('labels events by summary and reports by title', () => {
    expect(resolveEvidence(data, 'ev1')).toMatchObject({ kind: 'event', tick: 40 });
    expect(resolveEvidence(data, 'br:rep1')).toMatchObject({ kind: 'report', tick: 10, label: 'Initial resource estimate' });
  });
  it('matches a source report id copied into a branch', () => {
    expect(resolveEvidence(data, 'rep1').kind).toBe('report');
  });
  it('falls back to a short id for unknown records', () => {
    expect(resolveEvidence(data, 'abcdefgh-1234').label).toBe('record abcdefgh');
  });
});

describe('detailEntries', () => {
  it('summarises command records instead of dumping objects', () => {
    const rows = detailEntries({
      commandId: 'c1',
      intent: { type: 'attack', targetID: 'red', troops: 1200 },
      origin: 'human',
      observedTick: 39,
      before: { troops: 2000, gold: 50, tiles: 300 },
      after: { troops: 800, gold: 50, tiles: 300 },
      fingerprint: 'abcdef0123456789',
      receipt: { id: 'r' },
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.intent).toBe('attack opponent with 1,200 troops');
    expect(byKey.before).toBe('2,000 troops · 50 gold · 300 tiles');
    expect(byKey.fingerprint).toBe('abcdef012345');
    expect(byKey.receipt).toMatch(/recorded/);
    expect(byKey.observedTick).toBe('39');
  });
  it('handles primitives, arrays and empty values', () => {
    expect(detailEntries(undefined)).toEqual([]);
    expect(detailEntries('x')).toEqual([{ key: 'detail', value: 'x' }]);
    expect(detailEntries([])).toEqual([]);
    expect(detailEntries({ a: null, b: '' })).toEqual([]);
  });
});

describe('commitmentRatio', () => {
  it('uses the recorded before-state', () => {
    expect(commitmentRatio({ before: { troops: 1000 }, intent: { troops: 700 } })).toBeCloseTo(0.7);
    expect(commitmentRatio({ before: { troops: 0 }, intent: { troops: 700 } })).toBe(0);
    expect(commitmentRatio('nope')).toBe(0);
  });
});

describe('truncate', () => {
  it('shortens with an ellipsis only when needed', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a fairly long sentence', 8)).toBe('a fairl…');
  });
});

it('land adjacency does not wrap rows or advertise a water-only crossing',()=>{
 const noBorder=state({owners:[0,0,1,2,0,0],land:[1,1,1,1,1,1]});
 expect(hasLandBorder(noBorder,'blue','red')).toBe(false);
 expect(hasLandBorder(state({owners:[1,2,0,0,0,0]}),'blue','red')).toBe(true);
 expect(hasLandBorder(state({owners:[1,0,0,0,0,0],land:[1,0,0,0,0,0]}),'blue',null)).toBe(false);
});


it('shows the verified client snapshot separately while keeping model observation payloads compact',()=>{
  const observation={basis:'app-snapshot-returned-with-order',tick:162,fingerprint:'a'.repeat(64),player:{troops:83398,gold:77000,tiles:43}};
  const detail={observation,admittedTick:172,before:{troops:86278},intent:{troops:41699}};
  expect(commitmentRatio(detail)).toBe(.5);
  const rows=detailEntries(detail);
  expect(rows.find(r=>r.key==='Client snapshot')?.value).toContain('tick 162');
  expect(rows.find(r=>r.key==='Client snapshot')?.value).toContain('83,398 troops');
  expect(rows.find(r=>r.key==='admittedTick')?.value).toBe('172');
  expect(detailEntries({observation:{reports:['large model input']}})).toEqual([{key:'observation',value:'recorded (see backend record)'}]);
});
