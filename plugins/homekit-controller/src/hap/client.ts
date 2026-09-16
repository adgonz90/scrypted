// A long lived, self healing HAP client for one accessory.
//
// Scrypted expects a device to be usable at any time, but a HAP control connection is fragile: the
// accessory drops it when it reboots, changes network, or simply decides to. This class owns the
// reconnect loop and restores characteristic event subscriptions afterwards, so callers can treat
// the accessory as continuously available.

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { HapConnection, HapResponse } from './connection';
import { PairingData, pairVerify, removePairing } from './pairing';
import { HapAccessories, HapAccessory, HapCharacteristic, hapStatusMessages, HapService } from './types';
import { normalizeUuid, uuidEquals } from './uuids';

export interface CharacteristicWrite {
    aid: number;
    iid: number;
    value?: any;
    ev?: boolean;
}

export interface CharacteristicEvent {
    aid: number;
    iid: number;
    value: any;
}

export interface SnapshotRequest {
    width?: number;
    height?: number;
    // set for a bridged accessory so the bridge knows which camera to snapshot.
    aid?: number;
}

// Minimum gap between connection attempts made on behalf of a consumer. Long enough that a camera
// with few controller slots is not swamped, short enough not to stall a genuine recovery.
const CONNECT_COOLDOWN_MS = 10000;

function characteristicKey(aid: number, iid: number) {
    return `${aid}.${iid}`;
}

export class HapClient extends EventEmitter {
    private connection: HapConnection;
    private connecting: Promise<void>;
    private subscriptions = new Set<string>();
    private reconnectTimer: NodeJS.Timeout;
    private reconnectDelay = 1000;
    private lastAttempt = 0;
    private lastError: Error;
    private stopped = false;

    accessories: HapAccessories;

    constructor(
        public host: string,
        public port: number,
        public pairingData: PairingData,
        public console?: Console,
    ) {
        super();
        this.setMaxListeners(0);
    }

    get connected() {
        return !!this.connection && !this.connection.isClosed && this.connection.isEncrypted;
    }

    /** The address the accessory sees us at, and therefore the one to advertise for RTP. */
    get localAddress(): string {
        return this.connection?.localAddress;
    }

    /**
     * Opens and verifies a connection if one is not already up. Concurrent callers share a single
     * attempt rather than racing several TCP connections at the accessory.
     */
    async ensureConnected(force = false): Promise<void> {
        if (this.stopped)
            throw new Error('HAP client has been stopped');
        if (this.connected)
            return;
        if (this.connecting)
            return this.connecting;

        // Fail fast while a recent attempt is still cooling off.
        //
        // Every consumer - each rebroadcast retry, every snapshot - calls this, so without a
        // cooldown a camera that has stopped answering gets a new TCP connection every few
        // seconds from each of them at once. That is the surest way to exhaust the small number
        // of controller connections a camera allows and keep it unreachable. Recovery belongs to
        // the single backoff timer in scheduleReconnect, which passes force to bypass this.
        const since = Date.now() - this.lastAttempt;
        if (!force && this.lastError && since < CONNECT_COOLDOWN_MS) {
            throw new Error(`not connected to the accessory: ${this.lastError.message} `
                + `(retrying in ${Math.ceil((CONNECT_COOLDOWN_MS - since) / 1000)}s)`);
        }

        this.lastAttempt = Date.now();
        this.connecting = this.doConnect()
            .then(() => {
                this.lastError = undefined;
            })
            .catch(e => {
                this.lastError = e;
                this.scheduleReconnect();
                throw e;
            })
            .finally(() => this.connecting = undefined);
        return this.connecting;
    }

    private async doConnect() {
        const connection = new HapConnection(this.host, this.port, this.console);

        connection.on('event', body => this.onEvent(body));
        connection.on('close', error => {
            if (this.connection !== connection)
                return;
            this.connection = undefined;
            this.emit('disconnected', error);
            this.scheduleReconnect();
        });

        try {
            await connection.connect();
            await pairVerify(connection, this.pairingData);
        }
        catch (e) {
            // A socket that opened but never finished pair-verify still occupies one of the
            // accessory's controller slots, and cheap camera firmware holds a half open one for
            // minutes. Leaking these is what turns a single failure into a camera that refuses
            // every subsequent connection.
            connection.destroy();
            throw e;
        }

        // The same hazard as the catch above, on the path where nothing went wrong. Until the
        // assignment below this socket is known only to this invocation, so a stop() during either
        // await destroys whatever `connection` held at the time - not this one - and then this
        // resumes and hands a live socket to a client that has been torn down. Nothing would ever
        // close it, and it would hold one of the accessory's controller slots until the accessory
        // itself gave up on it.
        if (this.stopped) {
            connection.destroy();
            throw new Error('HAP client was stopped while connecting');
        }

        this.connection = connection;

        // a fresh connection starts with no event subscriptions, so restore them.
        if (this.subscriptions.size) {
            const writes = [...this.subscriptions].map(key => {
                const [aid, iid] = key.split('.').map(Number);
                return { aid, iid, ev: true };
            });
            try {
                await this.writeCharacteristics(writes);
            }
            catch (e) {
                this.console?.warn('failed to restore HAP event subscriptions', e);
            }
        }

        this.reconnectDelay = 1000;
        this.emit('connected');
    }

    private scheduleReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        const delay = this.reconnectDelay;
        // back off to a minute; a camera that is off the network should not be hammered.
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.ensureConnected(true)
                .catch(e => {
                    this.console?.warn(`HAP reconnect to ${this.host} failed: ${e.message}`);
                    this.scheduleReconnect();
                });
        }, delay);
    }

    private onEvent(body: any) {
        const characteristics: CharacteristicEvent[] = body?.characteristics;
        if (!Array.isArray(characteristics))
            return;
        for (const characteristic of characteristics)
            this.emit('characteristic', characteristic);
    }

    private async request(method: string, path: string, body?: Buffer, contentType?: string): Promise<HapResponse> {
        await this.ensureConnected();
        return this.connection.request(method, path, body, contentType);
    }

    /** Fetches and caches the accessory's full service and characteristic graph. */
    async getAccessories(refresh = false): Promise<HapAccessories> {
        if (this.accessories && !refresh)
            return this.accessories;

        const response = await this.request('GET', '/accessories');
        if (response.statusCode !== 200)
            throw new Error(`GET /accessories returned ${response.statusCode}`);

        this.accessories = JSON.parse(response.body.toString('utf8'));
        // normalize every type up front so that lookups never have to care about short UUIDs.
        for (const accessory of this.accessories.accessories) {
            for (const service of accessory.services) {
                service.type = normalizeUuid(service.type);
                for (const characteristic of service.characteristics)
                    characteristic.type = normalizeUuid(characteristic.type);
            }
        }
        return this.accessories;
    }

    async readCharacteristics(ids: { aid: number, iid: number }[]): Promise<HapCharacteristic[]> {
        if (!ids.length)
            return [];
        const query = ids.map(id => characteristicKey(id.aid, id.iid)).join(',');
        const response = await this.request('GET', `/characteristics?id=${query}`);
        // 207 is a partial success; individual entries carry their own status.
        if (response.statusCode !== 200 && response.statusCode !== 207)
            throw new Error(`GET /characteristics returned ${response.statusCode}`);

        const parsed = JSON.parse(response.body.toString('utf8'));
        return parsed.characteristics || [];
    }

    async readCharacteristic(aid: number, iid: number): Promise<any> {
        const [result] = await this.readCharacteristics([{ aid, iid }]);
        if (result?.status)
            throw new Error(hapStatusMessages[result.status] || `characteristic read failed with status ${result.status}`);
        return result?.value;
    }

    /**
     * True if any of these characteristics is marked timed write, which HAP spells "tw".
     *
     * Such a characteristic refuses an ordinary write: the controller has to announce the write
     * first with a PUT /prepare carrying a transaction id and a deadline, then repeat that id on
     * the write itself. Camera operating mode toggles - the status LED and night vision among
     * them - are commonly declared this way, as are locks and security systems.
     */
    private requiresTimedWrite(writes: CharacteristicWrite[]): boolean {
        if (!this.accessories)
            return false;

        for (const write of writes) {
            // an event subscription is not a value write and never needs preparing.
            if (write.value === undefined)
                continue;
            const accessory = this.accessories.accessories.find(candidate => candidate.aid === write.aid);
            for (const service of accessory?.services || []) {
                const characteristic = service.characteristics.find(candidate => candidate.iid === write.iid);
                if (characteristic?.perms?.includes('tw'))
                    return true;
            }
        }
        return false;
    }

    async writeCharacteristics(writes: CharacteristicWrite[]): Promise<void> {
        if (!writes.length)
            return;

        const payload: { characteristics: CharacteristicWrite[], pid?: number } = { characteristics: writes };

        if (this.requiresTimedWrite(writes)) {
            // a 32 bit id is plenty to disambiguate concurrent writes on one connection.
            const pid = crypto.randomInt(0, 0xffffffff);
            const ttl = 5000;

            const prepare = await this.request('PUT', '/prepare',
                Buffer.from(JSON.stringify({ pid, ttl }), 'utf8'));
            if (prepare.statusCode !== 200)
                throw new Error(`PUT /prepare returned ${prepare.statusCode}; the accessory refused to start a timed write`);

            const prepareStatus = JSON.parse(prepare.body.toString('utf8') || '{}').status;
            if (prepareStatus)
                throw new Error(`the accessory rejected the timed write preparation: ${hapStatusMessages[prepareStatus] || prepareStatus}`);

            // the write must quote the prepared id, and land inside the ttl.
            payload.pid = pid;
        }

        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const response = await this.request('PUT', '/characteristics', body);

        // 204 means every write succeeded. 207 means check each entry.
        if (response.statusCode === 204)
            return;
        if (response.statusCode !== 207)
            throw new Error(`PUT /characteristics returned ${response.statusCode}`);

        const parsed = JSON.parse(response.body.toString('utf8'));
        for (const characteristic of parsed.characteristics || []) {
            if (characteristic.status)
                throw new Error(`write to ${characteristicKey(characteristic.aid, characteristic.iid)} failed: ${hapStatusMessages[characteristic.status] || characteristic.status}`);
        }
    }

    async writeCharacteristic(aid: number, iid: number, value: any): Promise<void> {
        return this.writeCharacteristics([{ aid, iid, value }]);
    }

    /** TLV8 characteristics are carried as base64 in the HAP JSON representation. */
    async readTlvCharacteristic(aid: number, iid: number): Promise<Buffer> {
        const value = await this.readCharacteristic(aid, iid);
        if (typeof value !== 'string')
            throw new Error(`characteristic ${characteristicKey(aid, iid)} did not return a TLV8 value`);
        return Buffer.from(value, 'base64');
    }

    async writeTlvCharacteristic(aid: number, iid: number, value: Buffer): Promise<void> {
        return this.writeCharacteristic(aid, iid, value.toString('base64'));
    }

    async subscribe(ids: { aid: number, iid: number }[]): Promise<void> {
        const added = ids.filter(id => !this.subscriptions.has(characteristicKey(id.aid, id.iid)));
        if (!added.length)
            return;
        await this.writeCharacteristics(added.map(id => ({ ...id, ev: true })));
        for (const id of added)
            this.subscriptions.add(characteristicKey(id.aid, id.iid));
    }

    async unsubscribe(ids: { aid: number, iid: number }[]): Promise<void> {
        const removed = ids.filter(id => this.subscriptions.has(characteristicKey(id.aid, id.iid)));
        if (!removed.length)
            return;
        for (const id of removed)
            this.subscriptions.delete(characteristicKey(id.aid, id.iid));
        await this.writeCharacteristics(removed.map(id => ({ ...id, ev: false })));
    }

    /** Requests a JPEG snapshot. This is the only HAP way to get a still image. */
    async snapshot(request: SnapshotRequest = {}): Promise<Buffer> {
        const body: any = {
            'resource-type': 'image',
            'image-width': request.width || 1920,
            'image-height': request.height || 1080,
        };
        if (request.aid !== undefined)
            body.aid = request.aid;

        const response = await this.request('POST', '/resource', Buffer.from(JSON.stringify(body), 'utf8'));
        if (response.statusCode !== 200)
            throw new Error(`POST /resource returned ${response.statusCode}; the accessory may not support snapshots while streaming`);
        return response.body;
    }

    async identify(): Promise<void> {
        // the unpaired /identify endpoint is not available once paired; write the characteristic.
        const accessories = await this.getAccessories();
        for (const accessory of accessories.accessories) {
            for (const service of accessory.services) {
                for (const characteristic of service.characteristics) {
                    if (uuidEquals(characteristic.type, '14')) {
                        await this.writeCharacteristic(accessory.aid, characteristic.iid, true);
                        return;
                    }
                }
            }
        }
    }

    /** Unpairs this controller from the accessory. The client is unusable afterwards. */
    async unpair(): Promise<void> {
        await this.ensureConnected();
        await removePairing(this.connection, this.pairingData.controllerPairingId);
        this.stop();
    }

    /**
     * Drops the connection and establishes a new one.
     *
     * An accessory ties a camera streaming session to the controller connection that set it up and
     * releases it when that connection goes away, so this is the way to clear a session stranded by
     * a controller that vanished - a plugin restart mid stream, for instance. Subscriptions are
     * restored automatically by the reconnect path.
     */
    async reconnect(): Promise<void> {
        const connection = this.connection;
        this.connection = undefined;
        connection?.destroy();

        // let the accessory notice the close and tear its session down before reconnecting.
        await new Promise(resolve => setTimeout(resolve, 500));
        // deliberate, so it bypasses the consumer cooldown.
        await this.ensureConnected(true);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.connection?.destroy();
        this.connection = undefined;
    }
}

// ---------------------------------------------------------------------------------------------
// Accessory graph helpers
// ---------------------------------------------------------------------------------------------

export function findServices(accessory: HapAccessory, type: string): HapService[] {
    return accessory.services.filter(service => uuidEquals(service.type, type));
}

export function findService(accessory: HapAccessory, type: string): HapService {
    return findServices(accessory, type)[0];
}

export function findCharacteristic(service: HapService, type: string): HapCharacteristic {
    return service?.characteristics.find(characteristic => uuidEquals(characteristic.type, type));
}

export function getCharacteristicValue(service: HapService, type: string): any {
    return findCharacteristic(service, type)?.value;
}
