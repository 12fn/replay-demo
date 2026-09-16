import { useEffect, useMemo, useState } from 'react';
import { Anchor, ArrowUpCircle, Crosshair, Hammer, Maximize2, Navigation, Ship, Swords, Undo2, XCircle } from 'lucide-react';
import { api, BUILDABLE_UNITS, errorMessage, type BuildableUnit, type GameState, type Side, type Report } from '../api';
import { clamp, fmtInt, hasLandBorder, isValidTile, otherSide, ownerSide, playerBySide, sideLabel, tileToXY, type CommandAuthority } from '../lib';
import { ownFleet, selectedWater, toApiIntent, transportRecallOption, upgradeOption, warshipBuildOption, warshipMoveOption, type ActionContext, type ParityIntent } from '../action-options';
import { Busy, Empty, InlineError, Panel } from './ui';
import {ActionPreview} from './ActionPreview';

interface Props {
  exerciseId:string;
  canPreview:boolean;
  onSelectTile:(tile:number)=>void;
  state: GameState;
  observationReceipt?: string;
  reports?: Report[];
  /** Backend-assigned side; orders are always submitted for this side. */
  side: Side;
  selectedTile: number | null;
  refresh: () => Promise<void>;
  authority: CommandAuthority;
}

interface Receipt {
  at: Date;
  text: string;
  ok: boolean;
}

export function ActionsInspector({ exerciseId,canPreview,onSelectTile,state, side, selectedTile, refresh, authority, reports=[], observationReceipt }: Props) {
  const me = playerBySide(state, side);
  const enemy = playerBySide(state, otherSide(side));
  const [pct, setPct] = useState(50);
  const [rationale,setRationale]=useState('');
  const [sourceIds,setSourceIds]=useState<string[]>([]);
  const [unit, setUnit] = useState<BuildableUnit>('City');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  useEffect(() => setErr(null), [selectedTile]);

  const tileInfo = useMemo(() => {
    if (!isValidTile(selectedTile, state)) return null;
    const { x, y } = tileToXY(selectedTile, state.width);
    const owner = ownerSide(state, selectedTile);
    const land = state.land[selectedTile] === 1;
    const structure = state.players.flatMap((p) => p.units.map((u) => ({ ...u, side: p.side }))).find((u) => u.tile === selectedTile);
    return { x, y, owner, land, structure };
  }, [selectedTile, state]);

  const troops = me ? Math.max(1, Math.floor((me.troops * pct) / 100)) : 0;

  // Parity controls (warship build/move, upgrade, transport recall) share the tile/side context and the
  // same submit path as every other order, so receipts, rationale, sources and the observation receipt
  // are attributed identically. The helper only reads this side's own units from public state.
  const ctx: ActionContext = { state, side, selectedTile };
  const warshipBuild = warshipBuildOption(ctx);
  const upgrade = upgradeOption(ctx);
  const fleet = ownFleet(ctx);
  const waterSelected = selectedWater(ctx);

  const submit = async (label: string, intent: ParityIntent) => {
    if (busy) return; // one order in flight at a time; each carries its own idempotency key
    setBusy(label);
    setErr(null);
    try {
      await api.command(side, toApiIntent(intent), undefined, {rationale:rationale.trim()||undefined,sourceIds,observationReceipt});
      setRationale('');setSourceIds([]);
      setReceipts((r) => [{ at: new Date(), text: label, ok: true }, ...r].slice(0, 5));
      await refresh();
    } catch (e) {
      const msg = errorMessage(e);
      setErr(msg);
      setReceipts((r) => [{ at: new Date(), text: `${label} — rejected: ${msg}`, ok: false }, ...r].slice(0, 5));
    } finally {
      setBusy(null);
    }
  };

  if (!authority.allowed) {
    return (
      <Panel title="Inspector" className="orders">
        {tileInfo ? <TileSummary info={tileInfo} /> : <Empty>Click the map or use arrow keys to inspect a tile.</Empty>}
        <p className="muted small">{authority.reason}</p>
        {canPreview&&<ActionPreview exerciseId={exerciseId} tick={state.tick} onSelect={onSelectTile}/>}
      </Panel>
    );
  }

  if (!me) {
    return (
      <Panel title="Orders" className="orders">
        <Empty>No player for {sideLabel(side)} in this state.</Empty>
      </Panel>
    );
  }

  const disabled = busy !== null || !me.alive || state.spawning || me.spawn === null;
  const canActOnTile = tileInfo !== null && isValidTile(selectedTile, state);
  const ownedByMe = tileInfo?.owner === side;
  const enemyTarget = enemy && enemy.alive ? enemy : null;
  const adjoiningEnemy = hasLandBorder(state, side, otherSide(side));
  const adjoiningNeutral = hasLandBorder(state, side, null);

  return (
    <Panel title={`Orders · ${sideLabel(side)}`} className="orders" aside={busy ? <Busy label="Sending…" /> : null}>
      {!me.alive && !state.spawning && <p className="muted small">This side has no remaining territory.</p>}
      {state.spawning && me.spawn === null && <p className="muted small">Deployment phase: this side has not been placed yet.</p>}

      {tileInfo ? <TileSummary info={tileInfo} /> : <Empty>Select a tile on the map for build and boat orders.</Empty>}
      {canPreview&&<ActionPreview exerciseId={exerciseId} tick={state.tick} onSelect={onSelectTile}/>}

      <div className="field">
        <label htmlFor="troop-pct">
          Commit {pct}% · {fmtInt(troops)} of {fmtInt(me.troops)} troops
        </label>
        <input
          id="troop-pct"
          type="range"
          min={1}
          max={100}
          value={pct}
          disabled={disabled}
          onChange={(e) => setPct(clamp(Number(e.target.value), 1, 100))}
        />
      </div>

      <details className="decision-note">
        <summary>Decision note <span className="muted">(optional)</span></summary>
        <label htmlFor="order-reason" className="small">What do you expect, and what are you keeping in reserve?</label>
        <textarea id="order-reason" value={rationale} maxLength={2000} rows={2} onChange={e=>setRationale(e.target.value)} placeholder="Recorded with your next order; play continues." />
        {reports.filter(r=>r.side===side&&r.tick<=state.tick).map(r=><label key={r.id} className="small decision-source"><input type="checkbox" checked={sourceIds.includes(r.id)} onChange={e=>setSourceIds(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title} · t{r.tick}</label>)}
      </details>
      <div className="order-grid">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || me.troops < 1 || !adjoiningNeutral}
          onClick={() => void submit(`Expand with ${fmtInt(troops)}`, { type: 'attack', targetID: null, troops })}
        >
          <Maximize2 size={14} aria-hidden="true" /> Expand
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={disabled || !enemyTarget || me.troops < 1 || !adjoiningEnemy}
          title={!adjoiningEnemy ? 'A land attack requires a shared border' : enemyTarget ? `Attack ${enemyTarget.name}` : 'No attackable opposing player'}
          onClick={() =>
            enemyTarget && void submit(`Attack ${sideLabel(enemyTarget.side)} with ${fmtInt(troops)}`, { type: 'attack', targetID: enemyTarget.id, troops })
          }
        >
          <Swords size={14} aria-hidden="true" /> Attack {enemyTarget ? sideLabel(enemyTarget.side) : ''}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || !canActOnTile || !tileInfo?.land || ownedByMe || me.troops < 1}
          title={!canActOnTile ? 'Select a destination tile' : !tileInfo?.land ? 'Destination must be land' : ownedByMe ? 'Destination is already yours' : 'Send troops by boat'}
          onClick={() => canActOnTile && void submit(`Boat ${fmtInt(troops)} to ${tileInfo?.x},${tileInfo?.y}`, { type: 'boat', dst: selectedTile, troops })}
        >
          <Anchor size={14} aria-hidden="true" /> Boat to tile
        </button>
        {waterSelected ? (
          // A water tile takes only naval construction; the land-structure menu is not shown for it.
          <button
            type="button"
            className="btn"
            disabled={disabled || !warshipBuild.available}
            title={warshipBuild.reason}
            onClick={() => warshipBuild.intent && void submit(warshipBuild.label, warshipBuild.intent)}
          >
            <Ship size={14} aria-hidden="true" /> Build Warship
          </button>
        ) : (
          <div className="build-row">
            <label className="sr-only" htmlFor="unit-select">Structure type</label>
            <select id="unit-select" className="select" value={unit} disabled={disabled} onChange={(e) => setUnit(e.target.value as BuildableUnit)}>
              {BUILDABLE_UNITS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={disabled || !canActOnTile || !ownedByMe}
              title={!canActOnTile ? 'Select a tile first' : !ownedByMe ? 'Build only on your own territory' : `Build ${unit} at ${tileInfo?.x},${tileInfo?.y}`}
              onClick={() => canActOnTile && void submit(`Build ${unit} at ${tileInfo?.x},${tileInfo?.y}`, { type: 'build_unit', unit, tile: selectedTile })}
            >
              <Hammer size={14} aria-hidden="true" /> Build
            </button>
          </div>
        )}
        {tileInfo?.structure && tileInfo.structure.side === side && (
          // Shown only for the assigned side's own structure on the selected tile; the helper decides
          // whether that type can be upgraded and the engine still checks cost and construction state.
          <button
            type="button"
            className="btn"
            disabled={disabled || !upgrade.available}
            title={upgrade.reason}
            onClick={() => upgrade.intent && void submit(upgrade.label, upgrade.intent)}
          >
            <ArrowUpCircle size={14} aria-hidden="true" /> Upgrade {tileInfo.structure.type} to L{tileInfo.structure.level + 1}
          </button>
        )}
      </div>

      {(fleet.warships.length > 0 || fleet.transports.length > 0) && (
        <div className="orders-active">
          <h3 className="sub">Ships</h3>
          <ul className="order-list">
            {fleet.warships.map((u) => {
              const move = warshipMoveOption(ctx, u.id);
              const at = tileToXY(u.tile, state.width);
              return (
                <li key={`w${u.id}`}>
                  <span><Ship size={12} aria-hidden="true" /> Warship #{u.id} at {at.x},{at.y}</span>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !move.available} title={move.reason} onClick={() => move.intent && void submit(move.label, move.intent)}>
                    <Navigation size={13} aria-hidden="true" /> Move to tile
                  </button>
                </li>
              );
            })}
            {fleet.transports.map((u) => {
              const recall = transportRecallOption(ctx, u.id);
              const at = tileToXY(u.tile, state.width);
              return (
                <li key={`t${u.id}`}>
                  <span><Anchor size={12} aria-hidden="true" /> Transport #{u.id} at {at.x},{at.y}</span>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !recall.available} title={recall.reason} onClick={() => recall.intent && void submit(recall.label, recall.intent)}>
                    <Undo2 size={13} aria-hidden="true" /> Recall
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="orders-active">
        <h3 className="sub">Active orders</h3>
        {me.attacks.length === 0 ? (
          <Empty>No active attacks.</Empty>
        ) : (
          <ul className="order-list">
            {me.attacks.map((a) => {
              const target = a.target ? state.players.find((p) => p.id === a.target) : null;
              return (
                <li key={a.id}>
                  <span>
                    <Crosshair size={12} aria-hidden="true" /> {fmtInt(a.troops)} → {target ? sideLabel(target.side) : 'unclaimed land'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={disabled}
                    onClick={() => void submit('Cancel attack', { type: 'cancel_attack', attackID: a.id })}
                  >
                    <XCircle size={13} aria-hidden="true" /> Cancel
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <InlineError message={err} />
      {receipts.length > 0 && (
        <ul className="receipts" aria-label="Recent order results">
          {receipts.map((r, i) => (
            <li key={i} className={r.ok ? 'ok' : 'bad'}>
              <span className="mono">{r.at.toLocaleTimeString()}</span> {r.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function TileSummary({ info }: { info: { x: number; y: number; owner: Side | null; land: boolean; structure?: { type: string; level: number; side: Side } } }) {
  return (
    <dl className="tile-summary tile-summary-row">
      <div>
        <dt>Tile</dt>
        <dd className="mono">{info.x}, {info.y}</dd>
      </div>
      <div>
        <dt>Terrain</dt>
        <dd>{info.land ? 'Land' : 'Water'}</dd>
      </div>
      <div>
        <dt>Owner</dt>
        <dd>{info.owner ? sideLabel(info.owner) : 'Unclaimed'}</dd>
      </div>
      {info.structure && (
        <div>
          <dt>Structure</dt>
          <dd>{info.structure.type} L{info.structure.level} ({sideLabel(info.structure.side)})</dd>
        </div>
      )}
    </dl>
  );
}
