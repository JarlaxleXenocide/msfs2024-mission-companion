import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoherentClient,
  CoherentError,
  discover,
  type WebSocketLike,
} from '../src/simulator/coherent';

const unrelated = { method: 'Console.messageAdded', params: { message: {
  parameters: [{ value: 'UNRELATED' }, { value: '{"kind":"done","value":99}' }]
}}};
const ack = (id: number) => ({ id, result: {} });
const completion = (marker: string, value: unknown) => ({ method: 'Console.messageAdded',
  params: { message: { parameters: [{ value: marker },
    { value: JSON.stringify({ kind: 'done', value }) }] } } });

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(frame: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(frame);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

function frame(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

function markerFrom(socket: FakeSocket, index: number): string {
  const expression = (frame(socket, index).params as { expression: string }).expression;
  const match = /console\.log\(("(?:[^"\\]|\\.)*")/.exec(expression);
  assert.ok(match, 'outgoing wrapper contains a serialized marker');
  return JSON.parse(match[1]) as string;
}

async function connectedClient(pageId = 'page/id'): Promise<{
  client: CoherentClient;
  socket: FakeSocket;
  urls: string[];
}> {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const client = new CoherentClient(19999, pageId, (url) => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const connecting = client.connect();
  const socket = sockets[0];
  socket.open();
  await Promise.resolve();
  assert.equal(frame(socket, 0).method, 'Console.enable');
  socket.message(ack(frame(socket, 0).id as number));
  await connecting;
  return { client, socket, urls };
}

test('discovers required local pages without trusting remote socket URLs', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input) => {
    requested = String(input);
    return new Response(JSON.stringify([
      { id: 'main/one', title: 'mainUi', webSocketDebuggerUrl: 'ws://evil.invalid/main' },
      { id: 'efb two', title: 'Electronic Flight Bag', webSocketDebuggerUrl: 'ws://evil.invalid/efb' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await discover(23456), { mainId: 'main/one', efbId: 'efb two' });
    assert.equal(requested, 'http://127.0.0.1:23456/pagelist.json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects invalid discovery settings and malformed or missing pages', async () => {
  for (const port of [0, 65536, 1.5]) await assert.rejects(discover(port));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { id: '', title: 'mainUi' },
    { id: 'efb', title: 'Electronic Flight Bag' },
  ]))) as typeof fetch;
  try {
    await assert.rejects(discover(19999), /required simulator pages/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes numeric simulator page IDs without accepting invalid identifiers', async () => {
  const originalFetch = globalThis.fetch;
  let id: unknown = 2;
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { id, title: 'mainUi', url: 'coui://html_UI/Global/mainUI.html' },
    { id: 6, title: 'Electronic Flight Bag', url: 'coui://html_ui/efb_ui/efb_os/efb_ui.html' },
  ]))) as typeof fetch;
  try {
    assert.deepEqual(await discover(19999), { mainId: '2', efbId: '6' });
    id = 0;
    assert.deepEqual(await discover(19999), { mainId: '0', efbId: '6' });
    for (id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, {}]) {
      await assert.rejects(discover(19999), /required simulator pages/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('correlates concurrent evaluations by marker and ignores unrelated logs', async () => {
  const { client, socket, urls } = await connectedClient();
  assert.equal(urls[0], 'ws://127.0.0.1:19999/devtools/page/page%2Fid');

  const first = client.evaluate('FIRST_FIXED_EXPRESSION');
  const second = client.evaluate('SECOND_FIXED_EXPRESSION');
  const firstFrame = frame(socket, 1);
  const secondFrame = frame(socket, 2);
  const firstMarker = markerFrom(socket, 1);
  const secondMarker = markerFrom(socket, 2);
  assert.notEqual(firstMarker, secondMarker);

  socket.message(unrelated);
  socket.message(ack(firstFrame.id as number));
  socket.message(ack(secondFrame.id as number));
  socket.message(completion(secondMarker, { result: 2 }));
  socket.message(completion(firstMarker, { result: 1 }));

  assert.deepEqual(await first, { result: 1 });
  assert.deepEqual(await second, { result: 2 });
  client.close();
});

test('ignores malformed frames and rejects definite evaluation failures safely', async () => {
  const { client, socket } = await connectedClient();
  const secret = 'FIXED_SECRET_EXPRESSION';
  const pending = client.evaluate(secret);
  const request = frame(socket, 1);
  const marker = markerFrom(socket, 1);

  socket.message('{');
  socket.message({ method: 'Console.messageAdded', params: null });
  socket.message({ method: 'Console.messageAdded', params: { message: { parameters: [{ value: marker }] } } });
  socket.message(ack(request.id as number));
  socket.message({ method: 'Console.messageAdded', params: { message: { parameters: [
    { value: marker }, { value: JSON.stringify({ kind: 'error', error: 'native failed' }) },
  ] } } });

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CoherentError);
    assert.equal(error.cause, 'evaluation');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  client.close();
});

test('rejects Runtime.evaluate thrown and protocol-error acknowledgements', async () => {
  const { client, socket } = await connectedClient();
  const thrown = client.evaluate('THROWN_FIXED_EXPRESSION');
  socket.message({ id: frame(socket, 1).id, result: { wasThrown: true } });
  await assert.rejects(thrown, (error: unknown) =>
    error instanceof CoherentError && error.cause === 'evaluation');

  const rejected = client.evaluate('REJECTED_FIXED_EXPRESSION');
  socket.message({
    id: frame(socket, 2).id,
    error: { code: -32000, message: 'payload details' },
  });
  await assert.rejects(rejected, (error: unknown) => {
    assert.ok(error instanceof CoherentError);
    assert.equal(error.cause, 'protocol');
    assert.doesNotMatch(error.message, /payload details|REJECTED_FIXED_EXPRESSION/);
    return true;
  });
  client.close();
});

test('connect rejects a Console.enable protocol failure', async () => {
  const socket = new FakeSocket();
  const client = new CoherentClient(19999, 'main', () => socket);
  const connecting = client.connect();
  socket.open();
  await Promise.resolve();
  socket.message({
    id: frame(socket, 0).id,
    error: { code: -32000, message: 'remote payload' },
  });
  await assert.rejects(connecting, (error: unknown) =>
    error instanceof CoherentError && error.cause === 'protocol');
  assert.equal(socket.readyState, 3);
});

test('malformed matched acknowledgements retire uncertain dispatched work', async () => {
  for (const malformed of [
    { result: null },
    { error: { message: 'missing numeric code' } },
  ]) {
    const { client, socket } = await connectedClient();
    const pending = client.evaluate('DISPATCHED_FIXED_EXPRESSION');
    const request = frame(socket, 1);
    const marker = markerFrom(socket, 1);

    socket.message({ id: request.id, ...malformed });
    await assert.rejects(pending, (error: unknown) =>
      error instanceof CoherentError && error.cause === 'transport-loss');
    assert.equal(socket.readyState, 3);

    socket.message(completion(marker, 'late'));
    await assert.rejects(client.evaluate('NEW_FIXED_EXPRESSION'), (error: unknown) =>
      error instanceof CoherentError && error.cause === 'transport-loss');
  }
});

test('close rejects unresolved work and stale sockets cannot complete new work', async () => {
  const sockets: FakeSocket[] = [];
  const client = new CoherentClient(19999, 'main', () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const firstConnect = client.connect();
  sockets[0].open();
  await Promise.resolve();
  sockets[0].message(ack(frame(sockets[0], 0).id as number));
  await firstConnect;

  const abandoned = client.evaluate('ABANDONED_FIXED_EXPRESSION');
  const abandonedMarker = markerFrom(sockets[0], 1);
  sockets[0].message(ack(frame(sockets[0], 1).id as number));
  sockets[0].close();
  await assert.rejects(abandoned, (error: unknown) =>
    error instanceof CoherentError && error.cause === 'transport-loss');

  const secondConnect = client.connect();
  sockets[1].open();
  await Promise.resolve();
  sockets[1].message(ack(frame(sockets[1], 0).id as number));
  await secondConnect;
  const fresh = client.evaluate('FRESH_FIXED_EXPRESSION');
  const freshRequest = frame(sockets[1], 1);
  const freshMarker = markerFrom(sockets[1], 1);
  sockets[1].message(ack(freshRequest.id as number));
  sockets[0].message(completion(freshMarker, 'stale'));
  sockets[0].message(completion(abandonedMarker, 'late'));

  const sentinel = Symbol('pending');
  assert.equal(await Promise.race([fresh, Promise.resolve(sentinel)]), sentinel);
  sockets[1].message(completion(freshMarker, 'fresh'));
  assert.equal(await fresh, 'fresh');
  client.close();
});

test('socket errors reject unresolved work as uncertain transport loss', async () => {
  const { client, socket } = await connectedClient();
  const pending = client.evaluate('FIXED_EXPRESSION');
  socket.fail();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof CoherentError && error.cause === 'transport-loss');
});

test('acknowledgement deadlines report uncertain work without a UI deadline', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void) => {
    timers.push(callback);
    return 1;
  }) as typeof setTimeout;
  try {
    const { client, socket } = await connectedClient();
    const pending = client.evaluate('SLOW_ACK_FIXED_EXPRESSION');
    timers[timers.length - 1]();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof CoherentError && error.cause === 'ack-deadline');
    assert.equal(socket.readyState, 3);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
