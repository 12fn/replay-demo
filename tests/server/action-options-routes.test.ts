import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {mountActionOptionsRoutes, type ActionOptionsSnapshot} from '../../src/server/action-options-routes';
import {createApp, type AppConfig, type NativeSessionPort} from '../../src/server/native-http';
import {NativeSessionError, type NativeResolved, type NativeIdentity, type ResolveOptions} from '../../src/server/native-session';
import {GameService, type Session} from '../../src/server/service';
import type {ExerciseRow} from '../../src/server/store';
import * as agentTools from '../../src/agents/tools';
import {UnitType} from '../../vendor/openfront/src/core/game/Game';
import {BLUE_SPAWN, RED_SPAWN, ISLAND_SHORE, boat, navalEngine} from '../naval-fixture';

console.debug = () => {};
const WORKROOM = 'action-preview-workroom';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of clean.splice(0).reverse()) await cleanup();
});

async function fixture(nativeMode = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-action-options-'));
  clean.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  const service = new GameService(dir);
  clean.push(() => service.close());
  const engine = await navalEngine();
  const row: ExerciseRow = {id: randomUUID(), name: 'Naval preview fixture', kind: 'live', status: 'running', createdAt: '2026-09-13T00:00:00Z', humanSide: 'blue', agentEnabled: false,
    options: {...engine.record().options, ownerSubject: 'owner', workroomId: WORKROOM}};
  service.store.putExercise(row);
  for (const turn of engine.turns) {
    const tick = turn.turnNumber + 1;
    service.store.recordTurn(row.id, tick, turn, engine.record().fingerprints[tick]);
  }
  service.worlds.set(row.id, {row, engine, modelBusy: false, baselineAt: engine.game.ticks(), lastDecisionAt: 0});
  const session: Session = {identity: {subject: 'owner', name: 'Fixture user', role: 'commander', organization: 'Synthetic', mode: nativeMode ? 'kamiwaza' : 'local-demo'}, activeId: row.id, selectedSide: 'red', playbackTick: null};
  const sessionId = randomUUID();
  const saveSession = () => service.store.putSession(sessionId, session);
  saveSession();

  // Script the verified native-session boundary. Signature validation itself belongs to the
  // platform/native-session suites; HTTP authorization must consume this identity, never the cookie row.
  const authority = {identity: {...session.identity, mode: 'kamiwaza'} as NativeIdentity, signedIn: true};
  const metadata = () => ({signedIn: authority.signedIn, subject: authority.identity.subject, username: null, workroomId: WORKROOM, accessExpiresAt: null, refreshable: false, binding: 'session' as const, createdAt: null});
  const resolve = vi.fn(async (_id: string, opts: ResolveOptions = {}): Promise<NativeResolved> => {
    if (!authority.signedIn) throw new NativeSessionError('signed_out', 401, 'Sign in to Kamiwaza');
    if (opts.requireWrite || opts.requireAgents) throw new NativeSessionError('read_only', 403, 'Read-only fixture');
    return {identity: {...authority.identity}, context: {workroomId: WORKROOM, workroomName: 'Fixture', nativeRole: 'viewer', mappedRole: authority.identity.role, profileApplied: false, accessState: 'active', interactionMode: 'readonly', lifecycleState: 'active', canEdit: false, canRunAgents: false, canShare: false, readOnlyReason: 'Read-only fixture', statusBanner: null, fresh: false, validatedAt: '2026-09-13T00:00:00Z'}, nativeReceipts: [], metadata: metadata(), platformClient: {} as NativeResolved['platformClient']};
  });
  const native: NativeSessionPort = {workroomId: WORKROOM, resolve, metadata, login: async () => {throw new Error('No login used by this fixture');}, logout: () => {authority.signedIn = false;}};
  const config: AppConfig = nativeMode ? {mode: 'kamiwaza', workroomId: WORKROOM, apiBase: 'https://fixture.invalid/api', forwardedHost: 'fixture.invalid', forwardedProto: 'https', cookieSecure: false, allowedOrigins: [], allowLegacyRecordings: false} : {mode: 'local-demo', cookieSecure: false, allowedOrigins: []};
  const app = createApp({service, config, native: nativeMode ? native : null, root: dir, mount: app => mountActionOptionsRoutes(app, service)});
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  clean.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const request = async (url = `/api/action-options?exerciseId=${row.id}`, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, {method: body === undefined ? 'GET' : 'POST', headers: {Cookie: `replay_session=${sessionId}`, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, headers: response.headers, body: await response.json()};
  };
  const read = async () => {const response = await request(); expect(response.status).toBe(200); return response.body as ActionOptionsSnapshot;};
  return {service, engine, row, session, sessionId, saveSession, authority, resolve, request, read};
}

describe('action options HTTP preview', () => {
  it('requires an explicit matching exercise and rejects malformed or side-controlled queries before scans', async () => {
    const f = await fixture();
    const scan = vi.spyOn(agentTools, 'listNavalOptions');
    for (const query of ['', '?exerciseId=', `?exerciseId=${f.row.id}&exerciseId=other`, `?exerciseId=${f.row.id}&side=red`]) {
      expect((await f.request(`/api/action-options${query}`)).status).toBe(400);
    }
    const other = {...f.row, id: randomUUID()};
    f.service.store.putExercise(other);
    f.service.worlds.set(other.id, {...f.service.world(f.row.id), row: other});
    expect((await f.request(`/api/action-options?exerciseId=${other.id}`)).status).toBe(409);
    expect(scan).not.toHaveBeenCalled();
    expect(f.service.store.session(f.sessionId)).toEqual(f.session);
  });

  it('refuses real rewind navigation even at the current tick, then permits return to live', async () => {
    const f = await fixture();
    for (const tick of [1, f.engine.game.ticks()]) {
      expect((await f.request('/api/replay', {exerciseId: f.row.id, tick})).status).toBe(200);
      expect((await f.request()).status).toBe(409);
    }
    expect((await f.request('/api/replay', {exerciseId: f.row.id, tick: null})).status).toBe(200);
    await f.read();
  });

  it.each(['completed', 'paused'])('refuses a %s world without scanning', async status => {
    const f = await fixture();
    f.row.status = status;
    f.service.store.putExercise(f.row);
    const scan = vi.spyOn(agentTools, 'listNavalOptions');
    expect((await f.request()).status).toBe(409);
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(['commander', 'intelligence', 'instructor'] as const)('lets the %s seat preview only the assigned side', async role => {
    const f = await fixture(true);
    f.authority.identity.role = role;
    f.row.humanSide = 'red';
    f.service.store.putExercise(f.row);
    f.session.selectedSide = 'blue';
    f.saveSession();
    expect((await f.read()).side).toBe('red');
    expect(f.resolve.mock.calls.every(([, options]) => !options?.requireWrite && !options?.requireAgents)).toBe(true);
  });

  it('requires native sign-in and ignores a stored instructor role when the resolved analyst lacks scope', async () => {
    const f = await fixture(true);
    f.session.identity.role = 'instructor';
    f.saveSession();
    f.authority.identity = {...f.authority.identity, subject: 'analyst', role: 'intelligence'};
    // A separately owned world must not become an implicit fallback for the unauthorized active one.
    const owned = {...f.row, id: randomUUID(), options: {...f.row.options, ownerSubject: 'analyst'}};
    f.service.store.putExercise(owned);
    f.service.worlds.set(owned.id, {...f.service.world(f.row.id), row: owned});
    expect((await f.request()).status).toBe(403);
    expect(f.service.store.session(f.sessionId).activeId).toBe(f.row.id);
    f.authority.signedIn = false;
    expect((await f.request()).status).toBe(401);
  });

  it('allows an enrolled read-only analyst, then refuses revoked enrollment and a foreign workroom', async () => {
    const f = await fixture(true);
    f.authority.identity = {...f.authority.identity, subject: 'analyst', role: 'intelligence'};
    f.service.teams.enroll(f.row, f.authority.identity, f.engine.game.ticks());
    await f.read();
    f.service.teams.remove(f.row, 'analyst', 'owner');
    expect((await f.request()).status).toBe(403);
    f.authority.identity = {...f.authority.identity, subject: 'owner', role: 'instructor'};
    f.row.options.workroomId = 'foreign-workroom';
    f.service.store.putExercise(f.row);
    expect((await f.request()).status).toBe(403);
  });

  it('returns actual naval fixture options exactly as the agent helper, including retreat-aware recalls', async () => {
    const f = await fixture();
    const compare = async () => {
      const result = await f.read();
      expect(result.naval).toEqual(agentTools.listNavalOptions(f.service.agentContext(f.service.world(f.row.id), 'blue', 'staff')));
      for (const landing of result.naval.landings) expect(() => f.engine.validate('blue', landing.intent)).not.toThrow();
      return result;
    };
    const before = await compare();
    expect(before.naval.status).toBe('available');
    expect(before.naval.landings.some(landing => landing.landing.x >= 14)).toBe(true);
    f.engine.step([boat('blue', ISLAND_SHORE, 10), boat('red', ISLAND_SHORE, 10)]);
    const launched = await compare();
    expect(launched.naval.transportsAtSea).toHaveLength(1);
    expect(launched.units.map(unit => unit.id)).toEqual(f.engine.player('blue').units().filter(unit => unit.isActive()).map(unit => unit.id()));
    expect(launched.units.some(unit => f.engine.player('red').units().some(opposing => opposing.id() === unit.id))).toBe(false);
    const id = launched.naval.transportsAtSea[0].unitId;
    expect(launched.units.find(unit => unit.id === id)?.retreating).toBe(false);
    f.engine.step([{side: 'blue', intent: {type: 'cancel_boat', unitID: id}}]);
    f.engine.step(); // The upstream retreat execution applies on the following tick.
    const recalled = await compare();
    expect(recalled.naval.transportsAtSea[0]).toMatchObject({unitId: id, retreating: true, cancelIntent: null});
    expect(recalled.units.find(unit => unit.id === id)?.retreating).toBe(true);
  });

  it('reads own active units, real upgrade/construction flags and resource-dependent costs', async () => {
    const f = await fixture();
    const player = f.engine.player('blue');
    player.addGold(1_000_000n);
    const city = player.buildUnit(UnitType.City, BLUE_SPAWN, {});
    const removed = player.buildUnit(UnitType.DefensePost, BLUE_SPAWN, {});
    removed.delete(false);
    const opponent = f.engine.player('red').buildUnit(UnitType.City, RED_SPAWN, {});
    let result = await f.read();
    expect(result.units).toEqual([{id: city.id(), type: UnitType.City, tile: city.tile(), level: city.level(), canUpgrade: true, underConstruction: false}]);
    expect(result.units.some(unit => unit.id === opponent.id() || unit.id === removed.id())).toBe(false);
    for (const type of [UnitType.City, UnitType.DefensePost, UnitType.Port, UnitType.Warship] as const) {
      expect(result.buildCosts[type]).toBe(Number(f.engine.game.config().unitInfo(type).cost(f.engine.game, player)));
    }
    city.setUnderConstruction(true);
    result = await f.read();
    expect(result.units[0]).toMatchObject({canUpgrade: false, underConstruction: true});
    city.setUnderConstruction(false);
    player.removeGold(player.gold());
    expect((await f.read()).units[0].canUpgrade).toBe(false);
  });

  it('returns null when the engine cannot provide a build cost', async () => {
    const f = await fixture();
    const config = f.engine.game.config();
    const unitInfo = config.unitInfo.bind(config);
    vi.spyOn(config, 'unitInfo').mockImplementation(type => {
      const info = unitInfo(type);
      return type === UnitType.City ? {...info, cost: () => {throw new Error('Fixture cost unavailable');}} : info;
    });
    const result = await f.read();
    expect(result.buildCosts.City).toBeNull();
    expect(result.buildCosts.Warship).toBe(Number(unitInfo(UnitType.Warship).cost(f.engine.game, f.engine.player('blue'))));
  });

  it('does not alter engine state, replay inputs, database history, session, or inference; overview does not scan', async () => {
    const f = await fixture();
    const scan = vi.spyOn(agentTools, 'listNavalOptions');
    const inference = vi.spyOn(f.service.luna, 'complete');
    const state = f.engine.state();
    const record = f.engine.record();
    const dbChanges = () => f.service.store.db.prepare('SELECT total_changes() AS n').get();
    const before = dbChanges();
    const first = await f.request();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(first.body).toMatchObject({exerciseId: f.row.id, side: 'blue', tick: state.tick, fingerprint: state.fingerprint});
    expect(Object.keys(first.body).sort()).toEqual(['buildCosts', 'exerciseId', 'fingerprint', 'naval', 'side', 'tick', 'units']);
    expect((await f.read())).toEqual(first.body);
    expect(f.engine.state()).toEqual(state);
    expect(f.engine.record()).toEqual(record);
    expect(dbChanges()).toEqual(before);
    expect(f.service.store.session(f.sessionId)).toEqual(f.session);
    expect(scan).toHaveBeenCalledTimes(2);
    expect((await f.request('/api/overview')).status).toBe(200);
    expect((await f.request('/api/overview')).status).toBe(200);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(inference).not.toHaveBeenCalled();
  });
});
