/** Offline room-wire validation. No native client, filesystem, or inference dependencies. */
import assert from 'node:assert/strict';

const statuses = ['accepted', 'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'salvaged'] as const;
export interface Acceptance {
  input_id: string;
  accepted_position: number;
  journal_head: number;
  status: typeof statuses[number];
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function attemptArguments(args: string[]) {
  assert(args.length >= 1 && args.length <= 2, 'Usage: qualify-tomo-conversation.ts VERSION [ATTEMPT_SUFFIX]');
  const [version, suffix] = args;
  assert(/^\d+\.\d+\.\d+$/.test(version), 'Version must be numeric MAJOR.MINOR.PATCH');
  assert(suffix === undefined || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(suffix), 'Attempt suffix must be 1–48 letters, digits, underscores or hyphens, beginning with a letter or digit');
  return {version, suffix, attempt: suffix === undefined ? version : `${version}-${suffix}`};
}

export function roomCreated(httpStatus: number, body: unknown): string {
  assert.equal(httpStatus, 201, 'Room creation requires HTTP 201');
  assert(object(body) && typeof body.id === 'string' && /^[a-f0-9]{32}$/.test(body.id), 'Invalid compact public room ID');
  return body.id;
}

export function inputAccepted(httpStatus: number, body: unknown): Acceptance {
  assert.equal(httpStatus, 202, 'Input acceptance requires HTTP 202');
  assert(object(body), 'Invalid input acceptance body');
  assert(nonempty(body.input_id), 'Missing accepted input_id');
  assert(positive(body.accepted_position), 'Invalid accepted_position');
  assert(positive(body.journal_head), 'Invalid journal_head');
  assert(statuses.includes(body.status as Acceptance['status']), 'Invalid acceptance status');
  return {input_id: body.input_id, accepted_position: body.accepted_position, journal_head: body.journal_head, status: body.status as Acceptance['status']};
}

export interface RoomFrame {
  sseEvent: string;
  sseId?: string;
  envelope: JsonObject & {schema_version: 1; stream_kind: 'durable' | 'transient'; event: string; data: JsonObject};
}

export function parseRoomFrame(frame: string): RoomFrame | undefined {
  let sseEvent = 'message', sseId: string | undefined;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') sseEvent = value;
    else if (field === 'id') sseId = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  const envelope: unknown = JSON.parse(data.join('\n'));
  assert(object(envelope) && envelope.schema_version === 1, 'Invalid room SSE schema');
  assert(envelope.stream_kind === 'durable' || envelope.stream_kind === 'transient', 'Invalid room stream_kind');
  assert.equal(envelope.event, sseEvent, 'SSE event/envelope mismatch');
  assert(object(envelope.data), 'Missing nested room event data');
  if (envelope.stream_kind === 'durable') {
    assert(positive(envelope.position), 'Invalid durable position');
    assert.equal(sseId, String(envelope.position), 'SSE id/position mismatch');
    assert(nonempty(envelope.conversation_id), 'Missing durable conversation_id');
  } else {
    assert.equal(sseId, undefined, 'Transient event must not advance durable cursor');
  }
  return {sseEvent, sseId, envelope: envelope as RoomFrame['envelope']};
}

/** Retains chunk boundaries, including a CRLF split between chunks. */
export class RoomFrameDecoder {
  private decoder = new TextDecoder();
  private pending = '';
  push(bytes: Uint8Array): RoomFrame[] {
    this.pending += this.decoder.decode(bytes, {stream: true});
    this.pending = this.pending.replace(/\r\n/g, '\n');
    assert(this.pending.length <= 2_000_000, 'Event frame bound exceeded');
    const result: RoomFrame[] = [];
    let split: number;
    while ((split = this.pending.indexOf('\n\n')) >= 0) {
      const frame = parseRoomFrame(this.pending.slice(0, split));
      this.pending = this.pending.slice(split + 2);
      if (frame) result.push(frame);
    }
    return result;
  }
}

export interface TerminalOutcome {
  event: string;
  inputId: string;
  runId: string;
  position: number;
  status: 'completed' | 'failed' | 'cancelled' | 'salvaged';
  reason?: string;
  assistant?: {position: number; text: string; data: JsonObject};
}
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'salvaged']);

export class RoomObservation {
  private durable = new Map<number, RoomFrame>();
  private acceptance?: Acceptance;
  readonly eventTypes: string[] = [];
  lastPosition = 0;
  constructor(readonly roomId: string) {}

  accept(acceptance: Acceptance) {
    assert(!this.acceptance, 'Input acceptance already bound');
    this.acceptance = acceptance;
  }

  add(frame: RoomFrame) {
    this.eventTypes.push(frame.sseEvent);
    assert(this.eventTypes.length <= 2000, 'Event count bound exceeded');
    const e = frame.envelope;
    if (e.stream_kind === 'transient') {
      if (e.event === 'access_revoked') throw new Error('Room access revoked; observation incomplete');
      if (e.event === 'live_degraded') throw new Error('Room live delivery degraded; replay required, no input retry');
      return;
    }
    assert.equal(e.conversation_id, this.roomId, 'Durable event belongs to another room');
    const position = e.position as number;
    const previous = this.durable.get(position);
    if (previous) {
      assert.deepEqual(previous, frame, 'Conflicting replay at durable position');
      return;
    }
    assert(position > this.lastPosition, 'Durable positions out of order');
    this.durable.set(position, frame);
    this.lastPosition = position;
  }

  outcome(): TerminalOutcome | undefined {
    if (!this.acceptance) return undefined;
    const {input_id, accepted_position} = this.acceptance;
    for (const {envelope: e} of this.durable.values()) {
      if (e.input_id !== input_id || Number(e.position) < accepted_position) continue;
      const status = e.event.replace(/^agent_run_/, '');
      if (!e.event.startsWith('agent_run_') || !terminalStatuses.has(status)) continue;
      assert(nonempty(e.run_id), 'Terminal missing run_id');
      assert.equal(e.data.v, 1, 'Invalid terminal payload version');
      assert.equal(e.data.status, status, 'Terminal event/status mismatch');
      assert(e.data.reason === undefined || typeof e.data.reason === 'string', 'Invalid terminal reason');
      const outcome: TerminalOutcome = {
        event: e.event, inputId: input_id, runId: e.run_id, position: e.position as number,
        status: status as TerminalOutcome['status'], ...(e.data.reason === undefined ? {} : {reason: e.data.reason}),
      };
      for (const {envelope: answer} of this.durable.values()) {
        if (answer.event !== 'assistant_message' || answer.input_id !== input_id || answer.run_id !== e.run_id || Number(answer.position) >= Number(e.position)) continue;
        assert.equal(answer.data.v, 1, 'Invalid assistant payload version');
        assert(nonempty(answer.data.text), 'Durable assistant message missing text');
        outcome.assistant = {position: answer.position as number, text: answer.data.text, data: answer.data};
      }
      assert(status !== 'completed' || outcome.assistant, 'Completed run missing matching durable assistant message');
      return outcome;
    }
    return undefined;
  }
}

/** One attempt only, including response-body reading; races even a noncooperative transport. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}
