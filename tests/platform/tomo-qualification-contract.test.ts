import {afterEach, describe, expect, it, vi} from 'vitest';
import {attemptArguments, inputAccepted, roomCreated, RoomFrameDecoder, RoomObservation, parseRoomFrame, withDeadline} from '../../scripts/platform/tomo-qualification-contract';

const roomId = '54edeaaf04645a89a71bd1703715b9f9';
const inputId = '22222222-2222-4222-8222-222222222222';
const accepted = {input_id: inputId, accepted_position: 1, journal_head: 2, status: 'queued' as const};
const wire = (event: string, position: number, data: object, extra: object = {}) =>
  `id: ${position}\nevent: ${event}\ndata: ${JSON.stringify({schema_version: 1, stream_kind: 'durable', conversation_id: roomId, event, position, input_id: inputId, run_id: 'run-1', data, ...extra})}\n\n`;
const transient = (event: string, data: object = {}) =>
  `event: ${event}\ndata: ${JSON.stringify({schema_version: 1, stream_kind: 'transient', event, data})}\n\n`;
const add = (room: RoomObservation, frame: string) => room.add(parseRoomFrame(frame)!);
afterEach(() => vi.useRealTimers());

describe('Tomo qualifier request contracts', () => {
  it('keeps default proof names and separates attempts for the same build', () => {
    expect(attemptArguments(['0.14.1'])).toEqual({version: '0.14.1', attempt: '0.14.1'});
    expect(attemptArguments(['0.14.1', 'route-fix_2']).attempt).toBe('0.14.1-route-fix_2');
  });
  it.each(['../overwrite', '', '.hidden', 'a/b', 'a.b', 'x'.repeat(49)])('rejects unsafe suffix %j', suffix => {
    expect(() => attemptArguments(['0.14.1', suffix])).toThrow();
  });
  it('rejects unsafe version, missing version and extra arguments', () => {
    for (const args of [[], ['../0.14.1'], ['0.14.1', 'one', 'two']]) expect(() => attemptArguments(args)).toThrow();
  });
  it('requires actual compact create ID and HTTP 201 without normalization', () => {
    expect(roomCreated(201, {id: roomId})).toBe(roomId);
    expect(() => roomCreated(200, {id: roomId})).toThrow();
    expect(() => roomCreated(201, {id: inputId})).toThrow();
    expect(() => roomCreated(201, {id: {value: roomId}})).toThrow();
  });
  it.each(['accepted', 'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'salvaged'])('accepts vendor status %s and preserves all fields', status => {
    const body = {...accepted, status};
    expect(inputAccepted(202, body)).toEqual(body);
  });
  it('rejects missing/invalid acceptance fields and the resume response', () => {
    for (const body of [{accepted: true, status: 'running'}, {...accepted, input_id: ''}, {...accepted, accepted_position: 0}, {...accepted, journal_head: 1.5}, {...accepted, status: 'ok'}])
      expect(() => inputAccepted(202, body)).toThrow();
    expect(() => inputAccepted(200, accepted)).toThrow(/202/);
  });
});

describe('Tomo room SSE correlation', () => {
  it('buffers an answer and terminal before acceptance, ignoring a different input terminal', () => {
    const room = new RoomObservation(roomId);
    add(room, wire('agent_run_failed', 2, {v: 1, status: 'failed', reason: 'unrelated'}, {input_id: 'other'}));
    add(room, transient('delta', {text: 'provisional', input_id: inputId, run_id: 'run-1'}));
    add(room, wire('assistant_message', 3, {v: 1, text: 'Recorded forces', citations: ['fixture']}));
    add(room, wire('agent_run_completed', 4, {v: 1, status: 'completed'}));
    expect(room.outcome()).toBeUndefined();
    room.accept(accepted);
    expect(room.outcome()).toMatchObject({status: 'completed', inputId, runId: 'run-1', position: 4, assistant: {text: 'Recorded forces', position: 3}});
  });
  it.each(['failed', 'cancelled', 'salvaged'])('retains nested %s reason without requiring an answer', status => {
    const room = new RoomObservation(roomId);
    room.accept(accepted);
    add(room, wire(`agent_run_${status}`, 3, {v: 1, status, reason: 'runtime_failed'}));
    expect(room.outcome()).toMatchObject({status, reason: 'runtime_failed', inputId});
  });
  it('does not borrow an answer from a different run', () => {
    const room = new RoomObservation(roomId);
    room.accept(accepted);
    add(room, wire('assistant_message', 2, {v: 1, text: 'Wrong run'}, {run_id: 'other-run'}));
    add(room, wire('agent_run_completed', 3, {v: 1, status: 'completed'}));
    expect(() => room.outcome()).toThrow(/missing matching/);
  });
  it('rejects an event/status contradiction', () => {
    const room = new RoomObservation(roomId);
    room.accept(accepted);
    add(room, wire('agent_run_failed', 3, {v: 1, status: 'completed'}));
    expect(() => room.outcome()).toThrow(/status mismatch/);
  });
  it('checks room identity and deduplicates identical replay positions', () => {
    const room = new RoomObservation(roomId);
    const frame = wire('member_message', 1, {v: 1, text: 'hello'});
    add(room, frame); add(room, frame);
    expect(room.lastPosition).toBe(1);
    expect(() => add(room, wire('member_message', 1, {v: 1, text: 'changed'}))).toThrow(/Conflicting replay/);
    expect(() => add(room, wire('member_message', 2, {}, {conversation_id: 'other-room'}))).toThrow(/another room/);
  });
  it.each(['live_degraded', 'access_revoked'])('treats %s as incomplete observation', event => {
    expect(() => add(new RoomObservation(roomId), transient(event))).toThrow();
  });
  it('parses wrapped transient tools; metadata does not complete or advance a position', () => {
    const room = new RoomObservation(roomId);
    room.accept(accepted);
    const tool = parseRoomFrame(transient('tool', {name: 'fixture-read', input_id: inputId, run_id: 'run-1'}))!;
    expect(tool.envelope.data.input_id).toBe(inputId);
    room.add(tool);
    add(room, transient('keepalive'));
    expect(room.outcome()).toBeUndefined();
    expect(room.lastPosition).toBe(0);
  });
  it('rejects wrong envelopes and SSE name/cursor disagreement', () => {
    expect(() => parseRoomFrame('event: delta\ndata: {"text":"raw"}\n\n')).toThrow(/schema/);
    expect(() => parseRoomFrame(wire('agent_run_failed', 3, {}).replace('event: agent_run_failed', 'event: done'))).toThrow(/mismatch/);
    expect(() => parseRoomFrame(wire('member_message', 3, {}).replace('id: 3', 'id: 4'))).toThrow(/mismatch/);
    expect(parseRoomFrame(': keepalive\n\n')).toBeUndefined();
  });
  it('handles arbitrarily split UTF-8 and CRLF without losing a frame', () => {
    const decoder = new RoomFrameDecoder();
    const bytes = new TextEncoder().encode(transient('delta', {text: 'héllo'}).replaceAll('\n', '\r\n'));
    const frames = [...bytes].flatMap(byte => decoder.push(Uint8Array.of(byte)));
    expect(frames).toHaveLength(1);
    expect(frames[0].envelope.data.text).toBe('héllo');
  });
});

it('bounds an uncooperative input response, aborts, and never retries', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const operation = vi.fn((s: AbortSignal) => { signal = s; return new Promise<never>(() => {}); });
  const pending = withDeadline(operation, 30000, 'acceptance uncertain');
  const assertion = expect(pending).rejects.toThrow('acceptance uncertain');
  await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
