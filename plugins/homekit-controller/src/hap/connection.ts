// The HAP transport: a TCP connection to an accessory that speaks HTTP/1.1 in the clear until
// pair-verify completes, and ChaCha20-Poly1305 framed HTTP after that.
//
// Two details drive the shape of this class:
//   - HAP accessories tolerate only one in flight request per connection, so requests are queued.
//   - The accessory pushes unsolicited "EVENT/1.0" messages down the same socket, interleaved
//     between responses, so the reader cannot assume every message answers a request.

import { EventEmitter } from 'events';
import net from 'net';
import { chacha20Poly1305Decrypt, chacha20Poly1305Encrypt, sessionNonce } from './crypto';

// HAP frames carry at most 1024 bytes of plaintext.
const MAX_FRAME_PAYLOAD = 1024;
const FRAME_LENGTH_BYTES = 2;
const AUTH_TAG_BYTES = 16;

export interface HapResponse {
    statusCode: number;
    statusMessage: string;
    protocol: string;
    headers: Record<string, string>;
    body: Buffer;
}

interface PendingRequest {
    resolve: (response: HapResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

interface ParsedMessage {
    message: HapResponse;
    consumed: number;
}

// Parses one complete HTTP style message out of the head of the buffer. Returns undefined if more
// bytes are needed. Handles both Content-Length and chunked bodies.
function parseMessage(buffer: Buffer): ParsedMessage {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0)
        return undefined;

    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const lines = headerText.split('\r\n');
    const statusLine = lines.shift();

    // "HTTP/1.1 200 OK" or "EVENT/1.0 200 OK"
    const match = statusLine.match(/^(\S+)\s+(\d+)\s*(.*)$/);
    if (!match)
        throw new Error(`unparseable HAP status line: ${statusLine}`);

    const headers: Record<string, string> = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        headers[line.substring(0, colon).trim().toLowerCase()] = line.substring(colon + 1).trim();
    }

    const bodyStart = headerEnd + 4;
    let body: Buffer;
    let consumed: number;

    if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
        const chunks: Buffer[] = [];
        let offset = bodyStart;
        while (true) {
            const lineEnd = buffer.indexOf('\r\n', offset);
            if (lineEnd < 0)
                return undefined;
            const size = parseInt(buffer.subarray(offset, lineEnd).toString('utf8').split(';')[0], 16);
            if (isNaN(size))
                throw new Error('invalid chunk size in HAP response');
            offset = lineEnd + 2;
            if (size === 0) {
                // trailing CRLF after the terminal chunk.
                if (buffer.length < offset + 2)
                    return undefined;
                offset += 2;
                break;
            }
            if (buffer.length < offset + size + 2)
                return undefined;
            chunks.push(buffer.subarray(offset, offset + size));
            offset += size + 2;
        }
        body = Buffer.concat(chunks);
        consumed = offset;
    }
    else {
        const contentLength = parseInt(headers['content-length'] || '0') || 0;
        if (buffer.length < bodyStart + contentLength)
            return undefined;
        body = buffer.subarray(bodyStart, bodyStart + contentLength);
        consumed = bodyStart + contentLength;
    }

    return {
        message: {
            protocol: match[1],
            statusCode: parseInt(match[2]),
            statusMessage: match[3],
            headers,
            body,
        },
        consumed,
    };
}

export class HapConnection extends EventEmitter {
    private socket: net.Socket;
    private encrypted = false;
    private accessoryToControllerKey: Buffer;
    private controllerToAccessoryKey: Buffer;
    private inCounter = 0;
    private outCounter = 0;

    // bytes received but not yet forming a complete frame.
    private cipherBuffer = Buffer.alloc(0);
    // decrypted (or plain) bytes not yet forming a complete HTTP message.
    private plainBuffer = Buffer.alloc(0);

    private inflight: PendingRequest;
    private queue: (() => void)[] = [];
    private closed = false;

    constructor(public host: string, public port: number, public console?: Console, public requestTimeout = 20000) {
        super();
        // many consumers subscribe to close; none of them are a leak.
        this.setMaxListeners(0);
    }

    /**
     * The local address this connection reaches the accessory from. This is exactly the address
     * the accessory can send RTP back to, which beats guessing from the interface list.
     */
    get localAddress(): string {
        return this.socket?.localAddress;
    }

    get isEncrypted() {
        return this.encrypted;
    }

    get isClosed() {
        return this.closed;
    }

    async connect(): Promise<void> {
        if (this.socket)
            throw new Error('HAP connection already started');

        await new Promise<void>((resolve, reject) => {
            this.socket = net.createConnection({ host: this.host, port: this.port });
            this.socket.setNoDelay(true);
            // HAP accessories keep the control connection open indefinitely; keepalive detects a
            // camera that dropped off the network without sending a FIN.
            this.socket.setKeepAlive(true, 30000);

            const onError = (e: Error) => {
                this.socket.removeListener('connect', onConnect);
                reject(e);
            };
            const onConnect = () => {
                this.socket.removeListener('error', onError);
                resolve();
            };
            this.socket.once('error', onError);
            this.socket.once('connect', onConnect);
        });

        this.socket.on('data', data => {
            try {
                this.onData(data);
            }
            catch (e) {
                this.console?.error('HAP connection read error', e);
                this.destroy(e as Error);
            }
        });
        this.socket.on('error', e => this.destroy(e));
        this.socket.on('close', () => this.destroy(new Error('HAP connection closed by accessory')));
    }

    // Switches the connection to encrypted framing. Called once pair-verify has derived the two
    // directional keys.
    enableEncryption(accessoryToControllerKey: Buffer, controllerToAccessoryKey: Buffer) {
        this.accessoryToControllerKey = accessoryToControllerKey;
        this.controllerToAccessoryKey = controllerToAccessoryKey;
        this.inCounter = 0;
        this.outCounter = 0;
        this.encrypted = true;
    }

    private onData(data: Buffer) {
        if (!this.encrypted) {
            this.plainBuffer = Buffer.concat([this.plainBuffer, data]);
            this.processPlaintext();
            return;
        }

        this.cipherBuffer = Buffer.concat([this.cipherBuffer, data]);

        while (this.cipherBuffer.length >= FRAME_LENGTH_BYTES) {
            const length = this.cipherBuffer.readUInt16LE(0);
            const frameLength = FRAME_LENGTH_BYTES + length + AUTH_TAG_BYTES;
            if (this.cipherBuffer.length < frameLength)
                break;

            // the 2 byte length prefix doubles as the additional authenticated data.
            const aad = this.cipherBuffer.subarray(0, FRAME_LENGTH_BYTES);
            const payload = this.cipherBuffer.subarray(FRAME_LENGTH_BYTES, frameLength);
            this.cipherBuffer = this.cipherBuffer.subarray(frameLength);

            const plaintext = chacha20Poly1305Decrypt(this.accessoryToControllerKey, sessionNonce(this.inCounter), aad, payload);
            this.inCounter++;
            this.plainBuffer = Buffer.concat([this.plainBuffer, plaintext]);
        }

        this.processPlaintext();
    }

    private processPlaintext() {
        while (this.plainBuffer.length) {
            let parsed: ParsedMessage;
            try {
                parsed = parseMessage(this.plainBuffer);
            }
            catch (e) {
                this.destroy(e as Error);
                return;
            }
            if (!parsed)
                return;

            this.plainBuffer = this.plainBuffer.subarray(parsed.consumed);

            // an accessory initiated characteristic change notification, not a response.
            if (parsed.message.protocol.startsWith('EVENT')) {
                let body: any;
                try {
                    body = JSON.parse(parsed.message.body.toString('utf8'));
                }
                catch (e) {
                    this.console?.warn('unparseable HAP event body', e);
                    continue;
                }
                this.emit('event', body);
                continue;
            }

            const pending = this.inflight;
            if (!pending) {
                this.console?.warn('received a HAP response with no request outstanding');
                continue;
            }
            this.inflight = undefined;
            clearTimeout(pending.timeout);
            pending.resolve(parsed.message);
            this.dequeue();
        }
    }

    private dequeue() {
        if (this.inflight || this.closed)
            return;
        const next = this.queue.shift();
        next?.();
    }

    private writeFramed(data: Buffer) {
        if (!this.encrypted) {
            this.socket.write(data);
            return;
        }

        for (let offset = 0; offset < data.length; offset += MAX_FRAME_PAYLOAD) {
            const chunk = data.subarray(offset, offset + MAX_FRAME_PAYLOAD);
            const aad = Buffer.alloc(FRAME_LENGTH_BYTES);
            aad.writeUInt16LE(chunk.length, 0);
            const sealed = chacha20Poly1305Encrypt(this.controllerToAccessoryKey, sessionNonce(this.outCounter), aad, chunk);
            this.outCounter++;
            this.socket.write(Buffer.concat([aad, sealed]));
        }
    }

    request(method: string, path: string, body?: Buffer, contentType = 'application/hap+json'): Promise<HapResponse> {
        if (this.closed)
            return Promise.reject(new Error('HAP connection is closed'));

        return new Promise<HapResponse>((resolve, reject) => {
            const send = () => {
                if (this.closed) {
                    reject(new Error('HAP connection is closed'));
                    return;
                }

                let head = `${method} ${path} HTTP/1.1\r\n`;
                head += `Host: ${this.host}:${this.port}\r\n`;
                if (body?.length) {
                    head += `Content-Type: ${contentType}\r\n`;
                    head += `Content-Length: ${body.length}\r\n`;
                }
                else if (method !== 'GET') {
                    head += 'Content-Length: 0\r\n';
                }
                head += '\r\n';

                const timeout = setTimeout(() => {
                    if (this.inflight !== pending)
                        return;
                    this.inflight = undefined;
                    reject(new Error(`HAP request timed out: ${method} ${path}`));
                    // a timed out request leaves the stream position ambiguous, because the
                    // response may still arrive later and be mistaken for the next one.
                    this.destroy(new Error('HAP request timeout'));
                }, this.requestTimeout);

                const pending: PendingRequest = { resolve, reject, timeout };
                this.inflight = pending;

                const packet = body?.length
                    ? Buffer.concat([Buffer.from(head, 'utf8'), body])
                    : Buffer.from(head, 'utf8');
                this.writeFramed(packet);
            };

            if (this.inflight)
                this.queue.push(send);
            else
                send();
        });
    }

    destroy(error?: Error) {
        if (this.closed)
            return;
        this.closed = true;

        const pending = this.inflight;
        this.inflight = undefined;
        if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(error || new Error('HAP connection destroyed'));
        }
        // each queued entry is a send closure that rejects once it sees the closed flag.
        for (const queued of this.queue.splice(0)) {
            try {
                queued();
            }
            catch (e) {
            }
        }

        try {
            this.socket?.destroy();
        }
        catch (e) {
        }

        this.emit('close', error);
    }
}
