import { randomUUID } from 'node:crypto';

export type CoherentErrorCause =
  | 'transport-loss'
  | 'ack-deadline'
  | 'protocol'
  | 'evaluation';

export class CoherentError extends Error {
  override readonly cause: CoherentErrorCause;

  constructor(cause: CoherentErrorCause, message: string) {
    super(message);
    this.name = 'CoherentError';
    this.cause = cause;
  }
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(frame: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
};

type PendingRequest = Deferred<void> & {
  method: 'Console.enable' | 'Runtime.evaluate';
  timer: ReturnType<typeof setTimeout>;
};

const OPEN = 1;
const ACK_DEADLINE_MS = 5_000;

export async function discover(port: number): Promise<{ mainId: string; efbId: string }> {
  validatePort(port);
  let value: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pagelist.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('HTTP request failed');
    value = await response.json();
  } catch {
    throw new CoherentError('transport-loss', 'Simulator page discovery failed');
  }

  if (!Array.isArray(value)) throw new CoherentError('protocol', 'Simulator page list is invalid');
  const mainId = pageId(value, 'mainUi');
  const efbId = pageId(value, 'Electronic Flight Bag');
  if (mainId === null || efbId === null) {
    throw new CoherentError('protocol', 'Required simulator pages are unavailable');
  }
  return { mainId, efbId };
}

export class CoherentClient {
  private socket: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private enabled = false;
  private nextId = 0;
  private readonly requests = new Map<number, PendingRequest>();
  private readonly evaluations = new Map<string, Deferred<unknown>>();

  constructor(
    private readonly port: number,
    private readonly pageId: string,
    private readonly createSocket: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    validatePort(port);
    if (typeof pageId !== 'string' || pageId.trim().length === 0) {
      throw new TypeError('pageId must be a nonempty string');
    }
  }

  async connect(): Promise<void> {
    if (this.enabled && this.socket !== null && this.socket.readyState === OPEN) return;
    if (this.connecting !== null) return this.connecting;

    const attempt = this.open();
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  async evaluate(expression: string): Promise<unknown> {
    const socket = this.socket;
    if (!this.enabled || socket === null || socket.readyState !== OPEN) {
      throw new CoherentError('transport-loss', 'Simulator connection is unavailable');
    }

    const marker = `MSFS_COMPANION_${randomUUID()}`;
    const completion = deferred<unknown>();
    this.evaluations.set(marker, completion);
    void completion.promise.catch(() => undefined);
    const wrapped = `(function () {
  const emit = v => console.log(${JSON.stringify(marker)}, JSON.stringify(v));
  Promise.resolve().then(() => (${expression})).then(
    value => emit({kind:'done', value}),
    error => emit({kind:'error', error:String(error)}));
})()`;

    try {
      await this.request(socket, 'Runtime.evaluate', { expression: wrapped });
      return await completion.promise;
    } finally {
      this.evaluations.delete(marker);
    }
  }

  close(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.disconnect(socket, new CoherentError('transport-loss', 'Simulator connection closed'));
    socket.close();
  }

  private async open(): Promise<void> {
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(
        `ws://127.0.0.1:${this.port}/devtools/page/${encodeURIComponent(this.pageId)}`,
      );
    } catch {
      throw new CoherentError('transport-loss', 'Simulator connection failed');
    }

    this.socket = socket;
    this.enabled = false;
    const opened = deferred<void>();
    socket.onopen = () => opened.resolve();
    socket.onmessage = (event) => this.receive(socket, event.data);
    socket.onclose = () => {
      const error = new CoherentError('transport-loss', 'Simulator connection closed');
      opened.reject(error);
      this.disconnect(socket, error);
    };
    socket.onerror = () => {
      const error = new CoherentError('transport-loss', 'Simulator connection failed');
      opened.reject(error);
      this.disconnect(socket, error);
      socket.close();
    };

    try {
      await opened.promise;
      await this.request(socket, 'Console.enable', {});
      if (this.socket !== socket) {
        throw new CoherentError('transport-loss', 'Simulator connection was replaced');
      }
      this.enabled = true;
    } catch (error) {
      this.disconnect(socket, error);
      socket.close();
      throw error;
    }
  }

  private request(
    socket: WebSocketLike,
    method: 'Console.enable' | 'Runtime.evaluate',
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.socket !== socket || socket.readyState !== OPEN) {
      return Promise.reject(
        new CoherentError('transport-loss', 'Simulator connection is unavailable'),
      );
    }

    const id = ++this.nextId;
    const result = deferred<void>();
    const timer = setTimeout(() => {
      if (!this.requests.delete(id)) return;
      const error = new CoherentError(
        'ack-deadline',
        'Simulator acknowledgement deadline exceeded',
      );
      result.reject(error);
      this.disconnect(socket, error);
      socket.close();
    }, ACK_DEADLINE_MS);
    this.requests.set(id, { ...result, method, timer });

    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      this.requests.delete(id);
      const error = new CoherentError('transport-loss', 'Simulator request could not be sent');
      result.reject(error);
      this.disconnect(socket, error);
      socket.close();
    }
    return result.promise;
  }

  private receive(socket: WebSocketLike, data: unknown): void {
    if (this.socket !== socket || typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;

    if (Number.isInteger(frame.id)) this.receiveAcknowledgement(socket, frame);
    if (frame.method === 'Console.messageAdded') this.receiveConsole(frame);
  }

  private receiveAcknowledgement(
    socket: WebSocketLike,
    frame: Record<string, unknown>,
  ): void {
    const id = frame.id as number;
    const request = this.requests.get(id);
    if (request === undefined) return;
    this.requests.delete(id);
    clearTimeout(request.timer);

    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error');
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
    const uncertain = () => {
      const error = new CoherentError(
        'transport-loss',
        'Simulator acknowledgement was invalid',
      );
      request.reject(error);
      this.disconnect(socket, error);
      socket.close();
    };

    if (hasError && !hasResult && isProtocolError(frame.error)) {
      request.reject(new CoherentError('protocol', 'Simulator rejected the request'));
      return;
    }
    if (hasError || !hasResult || !isRecord(frame.result)) {
      uncertain();
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(frame.result, 'wasThrown') &&
      typeof frame.result.wasThrown !== 'boolean'
    ) {
      uncertain();
      return;
    }
    if (frame.result.wasThrown === true) {
      const cause = request.method === 'Runtime.evaluate' ? 'evaluation' : 'protocol';
      request.reject(new CoherentError(cause, 'Simulator request failed'));
      return;
    }
    request.resolve();
  }

  private receiveConsole(frame: Record<string, unknown>): void {
    if (!isRecord(frame.params) || !isRecord(frame.params.message)) return;
    const parameters = frame.params.message.parameters;
    if (!Array.isArray(parameters) || parameters.length < 2) return;
    if (!isRecord(parameters[0]) || !isRecord(parameters[1])) return;
    const marker = parameters[0].value;
    const serialized = parameters[1].value;
    if (typeof marker !== 'string' || typeof serialized !== 'string') return;
    const evaluation = this.evaluations.get(marker);
    if (evaluation === undefined) return;

    let payload: unknown;
    try {
      payload = JSON.parse(serialized);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    if (payload.kind === 'done') {
      this.evaluations.delete(marker);
      evaluation.resolve(payload.value);
    } else if (payload.kind === 'error' && typeof payload.error === 'string') {
      this.evaluations.delete(marker);
      evaluation.reject(new CoherentError('evaluation', 'Simulator evaluation failed'));
    }
  }

  private disconnect(socket: WebSocketLike, error: unknown): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.enabled = false;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.requests.clear();
    for (const evaluation of this.evaluations.values()) evaluation.reject(error);
    this.evaluations.clear();
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pageId(pages: unknown[], title: string): string | null {
  for (const page of pages) {
    if (isRecord(page) && page.title === title && typeof page.id === 'number' &&
        Number.isSafeInteger(page.id) && page.id >= 0) return String(page.id);
    if (
      isRecord(page) &&
      page.title === title &&
      typeof page.id === 'string' &&
      page.id.trim().length > 0
    ) {
      return page.id;
    }
  }
  return null;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('port must be an integer from 1 through 65535');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProtocolError(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === 'string'
  );
}
