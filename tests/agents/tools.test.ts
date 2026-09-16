import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GameService, type Identity } from '../../src/server/service';
import { TOOL_CATALOG, UNAVAILABLE_CAPABILITIES, executeTool, listLegalActions, toolsForScope, type AgentContext } from '../../src/agents/index';

console.debug = () => {};
const dirs: string[] = [];
const services: GameService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const luna: Identity = { subject: 'luna-test-red', name: 'Luna opponent', role: 'commander', organization: 'Exercise', mode: 'local-demo' };

async function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-agent-tools-')); dirs.push(d);
  const s = new GameService(d); services.push(s);
  const row = await s.create('Tools', 'plains'); const w = s.world(row.id);
  for (let i = 0; i < 25; i++) s.tick(w);
  return { s, row, w };
}

describe('tool catalog', () => {
  it('is typed, side-scoped and honest about what does not exist', () => {
    expect(TOOL_CATALOG.map((t) => t.name)).toContain('list_legal_actions');
    expect(toolsForScope('staff').every((t) => t.kind === 'query')).toBe(true);
    expect(toolsForScope('player').some((t) => t.name === 'submit_order')).toBe(true);
    expect(UNAVAILABLE_CAPABILITIES).toEqual(expect.arrayContaining(['code execution', 'shell access', 'network access']));
    for (const t of TOOL_CATALOG) expect(t.args.type).toBe('object');
  });

  it('enumerates only actions the engine validator accepts, and nothing during deployment', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    const legal = listLegalActions(ctx);
    expect(legal.actions.length).toBeGreaterThan(0);
    for (const a of legal.actions) expect(() => w.engine.validate('red', a.intent)).not.toThrow();
    expect(legal.actions.some((a) => a.intent.type === 'attack' && a.intent.targetID === null)).toBe(true);
    // A Defense Post costs 50k gold in this scenario; with starting gold above that a build option must be enumerated.
    if (w.engine.player('red').gold() >= 50_000n) expect(legal.actions.some((a) => a.intent.type === 'build_unit' && a.intent.unit === 'Defense Post')).toBe(true);
    // Every enumerated build option names a tile this side owns.
    for (const a of legal.actions.filter((x) => x.intent.type === 'build_unit')) expect(w.engine.game.ownerID(a.intent.tile as number)).toBe(w.engine.player('red').smallID());
    // Fresh engine still in deployment: no orders are legal and the tool says so instead of guessing.
    const fresh = await s.create('Fresh', 'plains'); const fw = s.world(fresh.id);
    const early = listLegalActions(s.agentContext(fw, 'red', 'staff'));
    if (fw.engine.game.inSpawnPhase()) { expect(early.actions).toEqual([]); expect(early.note).toMatch(/deployment/); }
  });

  it('inspect_tile and border/unit/resource queries answer from the engine with coordinates', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'staff');
    const spawn = w.engine.player('red').spawnTile()!;
    const t = executeTool({ tool: 'inspect_tile', arguments: JSON.stringify({ tile: spawn }) }, 'staff', ctx);
    expect(t.ok).toBe(true);
    expect(t.output).toMatchObject({ tile: spawn, land: true, ownerSide: 'red', ownedByYou: true });
    expect(executeTool({ tool: 'inspect_tile', arguments: '{"tile":-5}' }, 'staff', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/valid tile/) });
    const border = executeTool({ tool: 'list_border_tiles', arguments: '{"limit":5}' }, 'staff', ctx);
    expect(border.ok).toBe(true);
    expect((border.output as any).tiles.length).toBeLessThanOrEqual(5);
    expect((border.output as any).tiles[0]).toHaveProperty('beyond');
    const res = executeTool({ tool: 'list_resources', arguments: '' }, 'staff', ctx);
    expect((res.output as any)).toMatchObject({ side: 'red', opponent: { side: 'blue' } });
    expect(JSON.stringify(res.output)).not.toMatch(/report|staff/i);
  });

  it('refuses unknown tools, out-of-scope tools and actions without an action capability', async () => {
    const { s, w } = await world();
    const staff = s.agentContext(w, 'blue', 'staff');
    expect(executeTool({ tool: 'run_shell', arguments: '{}' }, 'player', s.agentContext(w, 'red', 'player', luna))).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown tool/) });
    expect(executeTool({ tool: 'submit_order', arguments: '{"intent":{"type":"attack","targetID":null,"troops":10}}' }, 'staff', staff)).toMatchObject({ ok: false, reason: expect.stringMatching(/not available in staff scope/) });
    expect(executeTool({ tool: 'delegate_watch', arguments: '{"objective":"x"}' }, 'staff', staff).ok).toBe(false);
    // Player scope without wired capabilities still cannot act.
    const noCaps: AgentContext = { ...s.agentContext(w, 'red', 'staff') };
    expect(executeTool({ tool: 'submit_order', arguments: '{"intent":{}}' }, 'player', noCaps)).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be issued/) });
    expect(s.store.pending(w.row.id)).toHaveLength(0);
  });

  it('submit_order goes through the engine validator; illegal intents are rejected with the engine reason', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    const bad = executeTool({ tool: 'submit_order', arguments: JSON.stringify({ intent: { type: 'attack', targetID: null, troops: 1e12 } }) }, 'player', ctx);
    expect(bad).toMatchObject({ ok: false, reason: expect.stringMatching(/available forces/) });
    const host = executeTool({ tool: 'submit_order', arguments: JSON.stringify({ intent: { type: 'toggle_pause', paused: true } }) }, 'player', ctx);
    expect(host.ok).toBe(false);
    expect(host.reason).toMatch(/host capability/);
    const good = executeTool({ tool: 'submit_order', arguments: JSON.stringify({ intent: { type: 'attack', targetID: null, troops: 20 } }) }, 'player', ctx);
    expect(good.ok).toBe(true);
    expect((good.output as any).status).toBe('queued');
    s.tick(w); s.tick(w);
    const ev = s.store.events(w.row.id).find((e) => e.kind === 'command' && e.details.commandId === (good.output as any).id);
    expect(ev?.details.origin).toBe('luna');
    expect(ev?.side).toBe('red');
  });

  it('never returns the opposing side\'s reports, orders or staff records', async () => {
    const { s, w } = await world();
    s.injectReport(w.row.id);
    const blueIds = s.store.reports(w.row.id).filter((r) => r.side === 'blue').map((r) => r.id);
    expect(blueIds.length).toBeGreaterThan(0);
    s.createTask(w.row.id, s.defaultSession().identity, 'Watch reserves below 123456', 'blue');
    s.command(w.row.id, 'blue', { type: 'attack', targetID: null, troops: 15 }, 'blue-secret-1', s.defaultSession().identity);
    s.tick(w); s.tick(w);
    const red = s.agentContext(w, 'red', 'player', luna);
    const dump = ['observe', 'list_legal_actions', 'list_owned_units', 'list_resources', 'list_border_tiles', 'search_reports', 'recent_orders', 'resource_delta']
      .map((tool) => executeTool({ tool, arguments: '{}' }, 'player', red));
    expect(dump.every((r) => r.ok)).toBe(true);
    const text = JSON.stringify(dump);
    for (const id of blueIds) expect(text).not.toContain(id);
    expect(text).not.toContain('Watch reserves below 123456');
    expect(text).not.toContain('blue-secret-1');
    const orders = dump.find((r) => r.tool === 'recent_orders')!.output as any;
    expect(orders.orders.every((o: any) => o.origin !== 'human')).toBe(true);
    const reports = dump.find((r) => r.tool === 'search_reports')!.output as any;
    expect(reports.reports.every((r: any) => !blueIds.includes(r.id))).toBe(true);
  });
});
