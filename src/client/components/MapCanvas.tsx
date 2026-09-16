import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { GameState, Side } from '../api';
import { clamp, fitRect, hasMapData, ownerSide, paintMap, sideLabel, tileToXY, xyToTile } from '../lib';

interface Props {
  stations?:import('../../campaign/network').StationView[];
  state: GameState | undefined;
  selectedTile: number | null;
  onSelectTile: (tile: number | null) => void;
  /** Displayed perspective; the label of this side is emphasised. */
  perspective: Side;
  /** Optional caption shown at the bottom-left (e.g. "Recorded · tick 420"). */
  caption?: string;
  interactive?: boolean;
}

const SIDE_COLOR: Record<Side, string> = { blue: '#5fb7de', red: '#f08a78' };

export function MapCanvas({ stations, state, selectedTile, onSelectTile, perspective, caption, interactive = true }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [hoverTile, setHoverTile] = useState<number | null>(null);

  const ready = hasMapData(state);

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = useMemo(
    () => (ready ? fitRect(state.width, state.height, box.w, box.h) : { x: 0, y: 0, w: 0, h: 0, scale: 0 }),
    [ready, state, box.w, box.h],
  );

  // Rebuild the offscreen pixel image when the arrays change.
  useEffect(() => {
    if (!ready) {
      imageRef.current = null;
      return;
    }
    let img = imageRef.current;
    if (!img || img.canvas.width !== state.width || img.canvas.height !== state.height) {
      const canvas = document.createElement('canvas');
      canvas.width = state.width;
      canvas.height = state.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      img = { canvas, ctx, data: ctx.createImageData(state.width, state.height) };
      imageRef.current = img;
    }
    paintMap(state, img.data.data);
    img.ctx.putImageData(img.data, 0, 0);
  }, [ready, state]);

  // Compose onto the visible canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(box.w * dpr));
    canvas.height = Math.max(1, Math.floor(box.h * dpr));
    canvas.style.width = `${box.w}px`;
    canvas.style.height = `${box.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    const img = imageRef.current;
    if (!ready || !img || rect.w === 0) return;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img.canvas, rect.x, rect.y, rect.w, rect.h);

    // Frame.
    ctx.strokeStyle = 'rgba(120, 160, 190, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    const s = rect.scale;
    const toScreen = (tile: number) => {
      const { x, y } = tileToXY(tile, state.width);
      return { sx: rect.x + x * s, sy: rect.y + y * s };
    };

    // Geographic labels belong to this pinned regional terrain; relays below are fictional exercise sites.
    if(state.map==='taiwan-strait-400'){
      ctx.save();ctx.font='600 12px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
      for(const [label,x,y] of [['MAINLAND COAST',.19,.14],['TAIWAN STRAIT',.47,.42],['TAIWAN',.79,.62]] as const){
        const sx=rect.x+x*rect.w,sy=rect.y+y*rect.h,tw=ctx.measureText(label).width;
        ctx.fillStyle='rgba(8,18,29,.76)';ctx.fillRect(sx-tw/2-6,sy-10,tw+12,20);ctx.fillStyle='#cde5ed';ctx.fillText(label,sx,sy);
      }ctx.restore();
    }

    // Actual scored station footprints. The region, not just its center, defines control.
    for(const station of stations??[]){
      ctx.fillStyle=station.priority?'rgba(255,209,102,.32)':'rgba(229,241,255,.17)';
      for(const tile of station.tiles){const {sx,sy}=toScreen(tile);ctx.fillRect(sx,sy,Math.max(1,s),Math.max(1,s));}
      const {sx,sy}=toScreen(station.tile);ctx.beginPath();ctx.arc(sx+s/2,sy+s/2,station.priority?7:5,0,Math.PI*2);ctx.strokeStyle=station.priority?'#ffd166':'#ecf4ff';ctx.lineWidth=2;ctx.stroke();
      ctx.font='11px system-ui';ctx.textAlign='right';ctx.textBaseline='bottom';ctx.fillStyle='#08121ddd';const label=station.name;const tw=ctx.measureText(label).width;ctx.fillRect(sx-tw-12,sy-19,tw+8,17);ctx.fillStyle=station.priority?'#ffd166':'#ecf4ff';ctx.fillText(label,sx-8,sy-5);
    }

    // Structures.
    for (const p of state.players) {
      for (const u of p.units) {
        const { sx, sy } = toScreen(u.tile);
        const cx = sx + s / 2;
        const cy = sy + s / 2;
        const r = Math.max(3, Math.min(6, s * 1.5));
        ctx.beginPath();
        if (u.type === 'City') ctx.rect(cx - r, cy - r, r * 2, r * 2);
        else if (u.type === 'Port') {
          ctx.moveTo(cx, cy - r);
          ctx.lineTo(cx + r, cy + r);
          ctx.lineTo(cx - r, cy + r);
          ctx.closePath();
        } else ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8, 14, 24, 0.85)';
        ctx.fill();
        ctx.strokeStyle = SIDE_COLOR[p.side];
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Player labels at actual spawn coordinates.
    ctx.textAlign = 'left';
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    for (const p of state.players) {
      if (p.spawn === null) continue;
      const { sx, sy } = toScreen(p.spawn);
      const cx = sx + s / 2;
      const cy = sy + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = SIDE_COLOR[p.side];
      ctx.fill();
      const label = `${sideLabel(p.side)}${p.alive ? '' : state.spawning ? ' (deploying)' : ' (eliminated)'}`;
      const tw = ctx.measureText(label).width;
      const lx = clamp(cx + 8, rect.x + 2, rect.x + rect.w - tw - 10);
      const ly = clamp(cy, rect.y + 10, rect.y + rect.h - 10);
      ctx.fillStyle = p.side === perspective ? 'rgba(6, 12, 22, 0.92)' : 'rgba(6, 12, 22, 0.7)';
      ctx.fillRect(lx - 4, ly - 9, tw + 8, 18);
      ctx.fillStyle = SIDE_COLOR[p.side];
      ctx.fillText(label, lx, ly);
    }

    // Hover.
    if (hoverTile !== null && interactive) {
      const { sx, sy } = toScreen(hoverTile);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, s) - 1, Math.max(1, s) - 1);
    }

    // Selected tile marker.
    if (selectedTile !== null && selectedTile >= 0 && selectedTile < state.width * state.height) {
      const { sx, sy } = toScreen(selectedTile);
      const size = Math.max(s, 1);
      const cx = sx + size / 2;
      const cy = sy + size / 2;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 2, sy - 2, size + 4, size + 4);
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy);
      ctx.lineTo(cx - 6, cy);
      ctx.moveTo(cx + 6, cy);
      ctx.lineTo(cx + 12, cy);
      ctx.moveTo(cx, cy - 12);
      ctx.lineTo(cx, cy - 6);
      ctx.moveTo(cx, cy + 6);
      ctx.lineTo(cx, cy + 12);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [ready, state, box, rect, selectedTile, hoverTile, perspective, interactive, stations]);

  const tileAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas || !ready || rect.scale === 0) return null;
      const b = canvas.getBoundingClientRect();
      const px = clientX - b.left - rect.x;
      const py = clientY - b.top - rect.y;
      if (px < 0 || py < 0 || px >= rect.w || py >= rect.h) return null;
      const x = Math.floor(px / rect.scale);
      const y = Math.floor(py / rect.scale);
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
      return xyToTile(x, y, state.width);
    },
    [ready, rect, state],
  );

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    onSelectTile(tileAt(e.clientX, e.clientY));
  };
  const onMove = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    setHoverTile(tileAt(e.clientX, e.clientY));
  };

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!interactive || !ready) return;
    const step = e.shiftKey ? 10 : 1;
    const w = state.width;
    const h = state.height;
    let { x, y } = selectedTile !== null ? tileToXY(selectedTile, w) : tileToXY(state.players[0]?.spawn ?? Math.floor((w * h) / 2), w);
    switch (e.key) {
      case 'ArrowLeft': x -= step; break;
      case 'ArrowRight': x += step; break;
      case 'ArrowUp': y -= step; break;
      case 'ArrowDown': y += step; break;
      case 'Escape': onSelectTile(null); e.preventDefault(); return;
      case 'Home': {
        const mine = state.players.find((p) => p.side === perspective);
        if (mine?.spawn !== null && mine?.spawn !== undefined) onSelectTile(mine.spawn);
        e.preventDefault();
        return;
      }
      default: return;
    }
    e.preventDefault();
    onSelectTile(xyToTile(clamp(x, 0, w - 1), clamp(y, 0, h - 1), w));
  };

  const hoverInfo = useMemo(() => {
    if (!ready || hoverTile === null) return null;
    const { x, y } = tileToXY(hoverTile, state.width);
    const side = ownerSide(state, hoverTile);
    return `${x}, ${y} · ${side ? sideLabel(side) : state.land[hoverTile] ? 'Unclaimed land' : 'Water'}`;
  }, [ready, hoverTile, state]);

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`map-canvas${interactive ? ' is-interactive' : ''}`}
        role="img"
        tabIndex={interactive ? 0 : -1}
        aria-label={
          ready
            ? `Operational map ${state.width} by ${state.height} tiles. ${interactive ? 'Arrow keys move the selection, Home jumps to your deployment, Escape clears.' : ''}`
            : 'Operational map loading'
        }
        onClick={onClick}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverTile(null)}
        onKeyDown={onKey}
      />
      {!ready && (
        <div className="map-empty" role="status">
          {state ? 'Map arrays not present in this snapshot.' : 'Waiting for map data…'}
        </div>
      )}
      {caption && <div className="map-caption">{caption}</div>}
      {hoverInfo && <div className="map-hover" aria-hidden="true">{hoverInfo}</div>}
      <div className="map-legend" aria-label="Map legend">
        <span><i style={{ background: '#2c84b0' }} />Blue</span>
        <span><i style={{ background: '#d66054' }} />Red</span>
        <span><i style={{ background: '#48505c' }} />Unclaimed</span>
        <span><i style={{ background: '#0c182c' }} />Water</span>
      </div>
    </div>
  );
}
