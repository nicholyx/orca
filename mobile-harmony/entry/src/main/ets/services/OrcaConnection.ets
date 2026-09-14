/*
 * The app-level facade: the only object the views talk to.
 *
 * It owns the composition — host store, socket factory, RPC client — and
 * translates their events into the immutable snapshots the views render. Views
 * never touch `RpcClient` directly, so a change to the transport cannot leak
 * into the UI layer, and the terminal view cannot accidentally write to the
 * socket without going through the subscription it opened.
 *
 * A note on the terminal: the desktop streams a snapshot and then incremental
 * chunks, so the buffer here is append-only and bounded. Trimming from the
 * front is deliberate — a terminal that ran for hours must not be able to grow
 * the renderer's heap without limit.
 */
import { common } from '@kit.AbilityKit';
import { HostProfile } from '../core/host/HostProfile';
import { HostStore } from '../core/host/HostStore';
import { PairingOffer, parsePairingCode } from '../core/pairing/PairingOffer';
import { ConnectionLogEntry } from '../core/rpc/ConnectionLog';
import { RpcClient } from '../transport/RpcClient';
import { RpcResponse } from '../core/rpc/RpcProtocol';
import { RPC_METHOD_TERMINAL_SUBSCRIBE } from '../core/rpc/RpcStreamUnsubscribe';
import { STREAM_RESULT_TYPE_END } from '../core/rpc/RpcStreamRegistry';
import {
  TERMINAL_EVENT_DATA,
  TERMINAL_EVENT_ERROR,
  TERMINAL_EVENT_RESIZED,
  TERMINAL_EVENT_SCROLLBACK
} from '../core/rpc/TerminalStreamRouter';
import { asArray, asRecord, asString } from '../core/json/JsonValue';
import { AssetDeviceTokenStore } from '../platform/AssetDeviceTokenStore';
import { DirectClientArgs, buildDirectClientOptions } from '../platform/DirectRpcSocketFactory';
import { harmonyRandomBytes, newHostId } from '../platform/HarmonyRandom';
import { PreferencesHostMetadataStore } from '../platform/PreferencesHostMetadataStore';
import {
  ConnectionSnapshot,
  HostRow,
  LogRow,
  PairOutcome,
  TerminalLine,
  connectionLabel,
  connectionTone,
  toLogRow
} from '../state/AppState';

/** Terminal rows are capped so a long-lived session cannot exhaust memory. */
const MAX_TERMINAL_LINES = 2_000;
/** Terminal input method; the host applies the text to the PTY verbatim. */
const RPC_METHOD_TERMINAL_SEND = 'terminal.send';
const RPC_METHOD_TERMINAL_LIST = 'terminal.list';

export interface TerminalDescriptor {
  id: string;
  title: string;
}

export class OrcaConnection {
  private readonly context: common.Context;
  private readonly hostStore: HostStore;
  private readonly listeners: Set<() => void> = new Set();

  private client: RpcClient | null = null;
  private hosts: HostProfile[] = [];
  private currentHost: HostProfile | null = null;
  private state: string = 'disconnected';
  private reconnectAttempt: number = 0;
  private lastConnectedAt: number = 0;
  private logRows: LogRow[] = [];
  private terminalLines: TerminalLine[] = [];
  private nextLineId: number = 1;
  private terminalUnsubscribe: (() => void) | null = null;
  private activeTerminal: string = '';
  private initialized: boolean = false;

  constructor(context: common.Context) {
    this.context = context;
    this.hostStore = new HostStore(
      new PreferencesHostMetadataStore(context),
      new AssetDeviceTokenStore(),
      () => newHostId()
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await this.refreshHosts();
  }

  private async refreshHosts(): Promise<void> {
    this.hosts = await this.hostStore.loadHosts();
    this.emit();
  }

  /**
   * Re-reads the host list from storage, discarding the in-memory cache. Called
   * when the app returns to the foreground: while it was suspended, the system
   * may have wiped a credential (the lock screen was removed), so a cached list
   * can name hosts that can no longer authenticate.
   */
  async reloadHosts(): Promise<HostRow[]> {
    this.hostStore.invalidate();
    await this.refreshHosts();
    return this.hostRows();
  }

  // -------------------------------------------------------------------------
  // Subscription for views
  // -------------------------------------------------------------------------

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = Array.from(this.listeners);
    for (let index = 0; index < snapshot.length; index++) {
      snapshot[index]();
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(): ConnectionSnapshot {
    const host = this.currentHost;
    const out: ConnectionSnapshot = {
      state: this.state,
      label: connectionLabel(this.state),
      tone: connectionTone(this.state),
      reconnectAttempt: this.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      hostId: host === null ? '' : host.id,
      hostName: host === null ? '' : host.name,
      hostEndpoint: host === null ? '' : host.endpoint,
      hostCount: this.hosts.length
    };
    return out;
  }

  hostRows(): HostRow[] {
    const rows: HostRow[] = [];
    const activeId = this.currentHost === null ? '' : this.currentHost.id;
    for (let index = 0; index < this.hosts.length; index++) {
      const host = this.hosts[index];
      rows.push({
        id: host.id,
        name: host.name,
        endpoint: host.endpoint,
        lastConnected: host.lastConnected,
        isActive: host.id === activeId
      });
    }
    return rows;
  }

  /** A copy, so a re-render is always triggered by a fresh array identity. */
  log(): LogRow[] {
    return this.logRows.slice();
  }

  /**
   * Returns a copy, not the live buffer. ArkUI decides whether a `@State` array
   * changed by identity, so handing back the same array reference would leave
   * the terminal frozen after the first frame.
   */
  terminal(): TerminalLine[] {
    return this.terminalLines.slice();
  }

  activeTerminalId(): string {
    return this.activeTerminal;
  }

  getHostName(): string {
    return this.currentHost === null ? '' : this.currentHost.name;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  /** Accepts an `orca://pair?…` URL, a bare base64 blob, or raw JSON. */
  async pairFromInput(input: string): Promise<PairOutcome> {
    const offer = parsePairingCode(input, () => Date.now());
    if (offer === null) {
      return {
        ok: false,
        message: 'That does not look like an Orca pairing code.',
        hostName: ''
      };
    }
    return this.pairFromOffer(offer);
  }

  async pairFromOffer(offer: PairingOffer): Promise<PairOutcome> {
    // The parser accepts a relay offer (it is a valid offer, and rejecting it
    // there would diverge from the reference validator). This client has no
    // relay transport, so it is refused HERE, where the missing capability
    // actually lives — and with a reason the user can act on. Accepting it would
    // store a pairing that can never connect.
    if (offer.relay !== undefined) {
      return {
        ok: false,
        message:
          'This pairing code uses the Orca relay, which this app does not support yet. Use a direct (LAN or Tailscale) pairing code instead.',
        hostName: ''
      };
    }
    try {
      const host = await this.hostStore.saveHostFromOffer(offer, null);
      await this.refreshHosts();
      return {
        ok: true,
        message: `Paired with ${host.name}.`,
        hostName: host.name
      };
    } catch (error) {
      return {
        ok: false,
        message: `Could not save the pairing: ${String(error)}`,
        hostName: ''
      };
    }
  }

  async removeHost(hostId: string): Promise<void> {
    if (this.currentHost !== null && this.currentHost.id === hostId) {
      this.disconnect();
    }
    await this.hostStore.removeHost(hostId);
    await this.refreshHosts();
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  connect(hostId: string): void {
    let target: HostProfile | null = null;
    for (let index = 0; index < this.hosts.length; index++) {
      if (this.hosts[index].id === hostId) {
        target = this.hosts[index];
        break;
      }
    }
    if (target === null) {
      this.pushLog('error', 'Host not found', `No paired host with id ${hostId}`, 'host-missing');
      return;
    }
    this.disconnect();
    this.currentHost = target;
    this.logRows = [];
    this.terminalLines = [];
    const options: DirectClientArgs = {
      endpoint: target.endpoint,
      deviceToken: target.deviceToken,
      desktopPublicKeyB64: target.publicKeyB64,
      random: harmonyRandomBytes,
      onStateChange: (state: string) => this.handleStateChange(state),
      onLog: (entry: ConnectionLogEntry) => this.handleLog(entry)
    };
    const clientOptions = buildDirectClientOptions(options);
    this.client = new RpcClient(clientOptions);
    this.state = this.client.getState();
    this.emit();
  }

  disconnect(): void {
    this.closeTerminal();
    if (this.client !== null) {
      this.client.close();
      this.client = null;
    }
    this.state = 'disconnected';
    this.reconnectAttempt = 0;
    this.emit();
  }

  /** Called when the app returns to the foreground. */
  notifyForeground(): void {
    if (this.client !== null) {
      this.client.notifyForeground();
    }
  }

  private handleStateChange(state: string): void {
    this.state = state;
    if (this.client !== null) {
      this.reconnectAttempt = this.client.getReconnectAttempt();
      this.lastConnectedAt = this.client.getLastConnectedAt();
    }
    if (state === 'connected' && this.currentHost !== null) {
      this.hostStore.markConnected(this.currentHost.id, Date.now()).catch(() => {
        // A failed timestamp write must not break a working connection.
      });
    }
    this.emit();
  }

  private handleLog(entry: ConnectionLogEntry): void {
    this.logRows.push(toLogRow(entry));
    if (this.logRows.length > 400) {
      this.logRows.splice(0, this.logRows.length - 400);
    }
    this.emit();
  }

  private pushLog(level: string, message: string, detail: string, code: string): void {
    this.logRows.push({
      id: this.logRows.length + 1,
      clock: '',
      level: level,
      message: message,
      detail: detail,
      code: code
    });
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async request(method: string, params: Object | undefined): Promise<RpcResponse | null> {
    if (this.client === null) {
      return null;
    }
    try {
      return await this.client.sendRequest(method, params);
    } catch (error) {
      return null;
    }
  }

  /** Lists terminals the host is willing to stream. */
  async listTerminals(): Promise<TerminalDescriptor[]> {
    const response = await this.request(RPC_METHOD_TERMINAL_LIST, undefined);
    if (response === null || !response.ok) {
      return [];
    }
    const raw = asArray(response.result);
    if (raw === null) {
      return [];
    }
    const out: TerminalDescriptor[] = [];
    for (let index = 0; index < raw.length; index++) {
      const record = asRecord(raw[index]);
      if (record === null) {
        continue;
      }
      const id = asString(record.id);
      if (id === null) {
        continue;
      }
      const title = asString(record.title);
      out.push({ id: id, title: title === null ? id : title });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Terminal stream
  // -------------------------------------------------------------------------

  /**
   * Opens the terminal feed. A viewer id is sent so two devices watching the
   * same terminal do not tear down each other's subscription.
   */
  openTerminal(terminalId: string, cols: number, rows: number): boolean {
    if (this.client === null) {
      return false;
    }
    this.closeTerminal();
    this.activeTerminal = terminalId;
    this.terminalLines = [];
    const params: Record<string, Object> = {};
    params.terminal = terminalId;
    params.cols = cols;
    params.rows = rows;
    const clientRef: Record<string, Object> = {};
    clientRef.id = `harmony-${newHostId()}`;
    params.client = clientRef;
    const unsubscribe = this.client.subscribe(
      RPC_METHOD_TERMINAL_SUBSCRIBE,
      params,
      (result: Object | null) => this.handleTerminalResult(result)
    );
    this.terminalUnsubscribe = unsubscribe;
    this.emit();
    return true;
  }

  closeTerminal(): void {
    if (this.terminalUnsubscribe !== null) {
      this.terminalUnsubscribe();
      this.terminalUnsubscribe = null;
    }
    this.activeTerminal = '';
    this.emit();
  }

  /** Sends user input to the active terminal. */
  async sendTerminalInput(text: string): Promise<void> {
    if (this.client === null || this.activeTerminal.length === 0) {
      return;
    }
    const params: Record<string, Object> = {};
    params.terminal = this.activeTerminal;
    params.text = text;
    try {
      await this.client.sendRequest(RPC_METHOD_TERMINAL_SEND, params);
    } catch (error) {
      this.pushLog('warn', 'Input send failed', String(error), 'terminal-send-failed');
    }
  }

  /**
   * Terminal output arrives on two channels, and both land here:
   *
   *   - binary frames, reassembled by the router into `TerminalStreamEvent`
   *     (`data` carries `chunk`; `scrollback`/`resized` carry a full `serialized`
   *     snapshot),
   *   - plain JSON results, where `scrollback` likewise carries `serialized`.
   *
   * `scrollback`/`resized` REPLACE the buffer rather than appending: they are a
   * whole-screen snapshot, so appending one would duplicate the visible history.
   * That is also why an `end` is a log line and not a buffer clear — the last
   * screen the user was reading must stay on screen.
   */
  private handleTerminalResult(result: Object | null): void {
    const record = asRecord(result);
    if (record === null) {
      return;
    }
    const type = asString(record.type);
    if (type === TERMINAL_EVENT_DATA) {
      const chunk = asString(record.chunk);
      if (chunk !== null) {
        this.appendTerminalText(chunk);
      }
      return;
    }
    if (type === TERMINAL_EVENT_SCROLLBACK || type === TERMINAL_EVENT_RESIZED) {
      const serialized = asString(record.serialized);
      if (serialized !== null) {
        this.replaceTerminalText(serialized);
      }
      return;
    }
    if (type === TERMINAL_EVENT_ERROR) {
      const message = asString(record.message);
      this.pushLog('error', 'Terminal error', message === null ? '' : message, 'terminal-error');
      return;
    }
    if (type === STREAM_RESULT_TYPE_END) {
      this.pushLog('info', 'Terminal stream ended', '', 'terminal-stream-end');
    }
  }

  /** Replaces the buffer with a full snapshot from the host. */
  private replaceTerminalText(text: string): void {
    this.terminalLines = [];
    this.appendTerminalText(text);
  }

  private appendTerminalText(text: string): void {
    // Split on line boundaries so the list can virtualise. A newline in the
    // incoming chunk is what makes a line final, and only a final line's
    // trailing CR can be dropped — an unterminated CR may still be the first
    // half of a CRLF split across two chunks.
    const pieces = text.split('\n');
    const lastIndex = this.terminalLines.length - 1;
    let firstWrittenIndex: number;
    if (lastIndex >= 0 && this.terminalLines[lastIndex].text.length > 0) {
      const previous = this.terminalLines[lastIndex];
      // A NEW object, so its identity changes: ArkUI keys rows by identity and
      // mutating the old object in place would leave a growing final line
      // invisible until something else forced a redraw.
      this.terminalLines[lastIndex] = {
        id: previous.id,
        text: `${previous.text}${pieces[0]}`
      };
      firstWrittenIndex = lastIndex;
    } else {
      this.terminalLines.push({ id: this.nextLineId++, text: pieces[0] });
      firstWrittenIndex = lastIndex + 1;
    }
    for (let index = 1; index < pieces.length; index++) {
      this.terminalLines.push({ id: this.nextLineId++, text: pieces[index] });
    }

    // Normalise only the lines this chunk completed, so the work stays bounded
    // by the chunk rather than by the buffer. The trailing CR is dropped
    // because this list renders plain text, not a terminal grid: keeping it
    // would corrupt copy/paste and make every line compare unequal.
    const finalIndex = this.terminalLines.length - 2;
    for (let index = firstWrittenIndex; index <= finalIndex; index++) {
      const line = this.terminalLines[index];
      if (line.text.length > 0 && line.text.charCodeAt(line.text.length - 1) === 13) {
        this.terminalLines[index] = {
          id: line.id,
          text: line.text.substring(0, line.text.length - 1)
        };
      }
    }

    if (this.terminalLines.length > MAX_TERMINAL_LINES) {
      this.terminalLines.splice(0, this.terminalLines.length - MAX_TERMINAL_LINES);
    }
    this.emit();
  }
}
