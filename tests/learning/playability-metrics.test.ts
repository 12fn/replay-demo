import { describe, expect, it } from 'vitest';
import { objectiveProgress, sidePlayability, type PulseObservation } from '../../src/learning/playability-metrics';

const win = { startTick: 45, endTick: 900, idleThresholdTicks: 200 };

const pulse = (tick: number, category: string, intentType: string | null, admitted: boolean | null, rejectedAtTick = false, side: 'blue' | 'red' = 'blue'): PulseObservation =>
  ({ tick, side, category, intentType, admitted, rejectedAtTick });

describe('sidePlayability', () => {
  // Fictional abstract-game pulses: expansion, a hold, two attacks, a submission rejection, a tick-time drop, a build.
  const pulses: PulseObservation[] = [
    pulse(45, 'expansion', 'attack', true),
    pulse(90, 'none', null, null),
    pulse(135, 'attack', 'attack', true),
    pulse(180, 'attack', 'attack', true),
    pulse(225, 'construction', 'build_unit', false),
    pulse(270, 'transport', 'boat', true, true),
    pulse(315, 'none', null, null),
    pulse(360, 'none', null, null),
    pulse(405, 'none', null, null),
    pulse(450, 'none', null, null),
    pulse(495, 'none', null, null),
    pulse(540, 'construction', 'build_unit', true),
    pulse(135, 'attack', 'attack', true, false, 'red'),
  ];

  it('separates proposals, holds, submission rejections and tick-time drops', () => {
    const m = sidePlayability(pulses, 'blue', win);
    expect(m.pulses).toBe(12);
    expect(m.proposed).toBe(6);
    expect(m.held).toBe(6);
    expect(m.admittedAtSubmission).toBe(5);
    expect(m.rejectedAtSubmission).toBe(1);
    expect(m.rejectedAtTick).toBe(1);
    expect(m.executed).toBe(4);
    expect(m.legalRate).toBe(0.6667);
    expect(m.categoryCounts).toEqual({ expansion: 1, none: 6, attack: 2, construction: 2, transport: 1 });
    expect(m.executedIntentTypes).toEqual({ attack: 3, build_unit: 1 });
  });

  it('measures diversity and repetition over executed orders only', () => {
    const m = sidePlayability(pulses, 'blue', win);
    // executed categories: expansion 1, attack 2, construction 1 -> H = 1.5 bits over 3 categories
    expect(m.distinctExecutedCategories).toBe(3);
    expect(m.categoryEntropyBits).toBe(1.5);
    expect(m.normalizedCategoryEntropy).toBe(+(1.5 / Math.log2(3)).toFixed(4));
    expect(m.dominantCategoryShare).toBe(0.5);
    expect(m.longestSameCategoryStreak).toBe(2);
  });

  it('reports leading, inner and trailing idle gaps and the longest no-execution pulse streak', () => {
    const m = sidePlayability(pulses, 'blue', win);
    expect(m.firstExecutedTick).toBe(45);
    expect(m.lastExecutedTick).toBe(540);
    expect(m.idleGapsTicks).toEqual([0, 90, 45, 360, 360]);
    expect(m.longestIdleTicks).toBe(360);
    expect(m.longIdleGaps).toBe(2);
    // 225 rejected, 270 dropped, then five holds -> seven pulses without an executed order
    expect(m.longestIdlePulseStreak).toBe(7);
  });

  it('treats a side that never acts as idle for the whole window', () => {
    const m = sidePlayability([pulse(45, 'none', null, null), pulse(90, 'reserve', 'attack', false)], 'blue', win);
    expect(m.executed).toBe(0);
    expect(m.legalRate).toBe(0);
    expect(m.idleGapsTicks).toEqual([855]);
    expect(m.longIdleGaps).toBe(1);
    expect(m.dominantCategoryShare).toBeNull();
    expect(m.normalizedCategoryEntropy).toBe(0);
    expect(m.longestIdlePulseStreak).toBe(2);
    expect(sidePlayability([], 'red', win).legalRate).toBeNull();
  });

  it('ignores pulses outside the window and orders by tick', () => {
    const m = sidePlayability([pulse(1000, 'attack', 'attack', true), pulse(300, 'attack', 'attack', true), pulse(100, 'expansion', 'attack', true), pulse(10, 'attack', 'attack', true)], 'blue', win);
    expect(m.pulses).toBe(2);
    expect(m.idleGapsTicks).toEqual([55, 200, 600]);
    expect(m.longIdleGaps).toBe(1);
    expect(m.longestSameCategoryStreak).toBe(1);
  });

  it('rejects an inverted window', () => {
    expect(() => sidePlayability([], 'blue', { startTick: 50, endTick: 40, idleThresholdTicks: 10 })).toThrow(/before it starts/);
  });
});

describe('objectiveProgress', () => {
  it('counts lead changes without letting ties reset the leader, and station gains/losses', () => {
    const p = objectiveProgress(
      [
        { tick: 900, scores: { blue: 3, red: 3 } },
        { tick: 300, scores: { blue: 0, red: 1 } },
        { tick: 600, scores: { blue: 3, red: 2 } },
        { tick: 1200, scores: { blue: 4, red: 6 } },
      ],
      [
        { tick: 250, station: 'S1', from: null, to: 'red' },
        { tick: 500, station: 'S2', from: null, to: 'blue' },
        { tick: 1100, station: 'S2', from: 'blue', to: 'red' },
      ],
    );
    expect(p.awards).toBe(4);
    expect(p.scoresAtLastAward).toEqual({ blue: 4, red: 6 });
    expect(p.firstPointTick).toEqual({ blue: 600, red: 300 });
    expect(p.leadChanges).toBe(2);
    expect(p.stationsGained).toEqual({ blue: 1, red: 2 });
    expect(p.stationsLost).toEqual({ blue: 1, red: 0 });
    expect(p.stationChanges).toBe(3);
  });

  it('reports zero progress when no award was reached', () => {
    expect(objectiveProgress([], [])).toEqual({ awards: 0, scoresAtLastAward: { blue: 0, red: 0 }, firstPointTick: { blue: null, red: null }, leadChanges: 0, stationsGained: { blue: 0, red: 0 }, stationsLost: { blue: 0, red: 0 }, stationChanges: 0 });
  });
});
