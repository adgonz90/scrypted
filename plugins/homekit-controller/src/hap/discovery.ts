// mDNS discovery of HAP accessories, advertised as _hap._tcp.

import Bonjour, { BonjourService, Browser } from 'bonjour-hap';
import { EventEmitter } from 'events';
import { Category } from './uuids';
import { probeService } from './unicast-mdns';

/** The DNS-SD service every HAP accessory publishes. */
export const HAP_SERVICE = '_hap._tcp.local';

export interface DiscoveredAccessory {
    // the accessory pairing id from the TXT record, stable across address changes.
    id: string;
    name: string;
    host: string;
    port: number;
    addresses: string[];
    // HAP accessory category, which tells us whether this is a camera, a bridge, a sensor...
    category: Category;
    model: string;
    protocolVersion: string;
    configNumber: number;
    // false once the accessory has been paired with some controller.
    available: boolean;
}

// HAP status flags, TXT record "sf". Bit 0 set means the accessory has not been paired.
const STATUS_FLAG_UNPAIRED = 0x01;

/** How long answers must stop arriving before a query is considered finished. */
const SETTLE_QUIET_MS = 750;

/** And the longest to wait regardless, so a chatty network cannot hold a refresh open. */
const SETTLE_CAP_MS = 3000;

/**
 * The fields a HAP TXT record carries, shared by both ways of obtaining one: overhearing a
 * multicast announcement, and asking a host directly.
 */
export function parseAccessoryTxt(txt: Record<string, string>): Omit<DiscoveredAccessory, 'name' | 'host' | 'port' | 'addresses'> {
    const statusFlags = parseInt(txt['sf'] ?? txt['statusflags'] ?? '0') || 0;

    return {
        id: (txt['id'] || '').toUpperCase(),
        category: parseInt(txt['ci'] || '1') || Category.OTHER,
        model: txt['md'] || '',
        protocolVersion: txt['pv'] || '1.0',
        configNumber: parseInt(txt['c#'] || '0') || 0,
        available: !!(statusFlags & STATUS_FLAG_UNPAIRED),
    };
}

function parseService(service: BonjourService): DiscoveredAccessory {
    return {
        ...parseAccessoryTxt(service.txt || {}),
        name: service.name,
        host: service.addresses?.find(address => !address.includes(':')) || service.addresses?.[0] || service.host,
        port: service.port,
        addresses: service.addresses || [],
    };
}

export class HapDiscovery extends EventEmitter {
    private bonjour: InstanceType<typeof Bonjour>;
    private browser: Browser;
    private accessories = new Map<string, DiscoveredAccessory>();

    constructor(public console?: Console) {
        super();
        this.setMaxListeners(0);
    }

    start() {
        if (this.browser)
            return;

        this.bonjour = new Bonjour();
        this.browser = this.bonjour.find({ type: 'hap', protocol: 'tcp' });

        // 'up' is only emitted for a service the browser has not seen before. An accessory that
        // re-announces - which is what it does after a reboot, a factory reset, or a move to a new
        // address - takes the 'update' path instead, and that is exactly when its port has changed:
        // a HAP accessory picks an arbitrary one each time its server starts. Listening to 'up'
        // alone means the browser tells us the accessory moved and we keep the address it moved
        // from, which then refuses every connection. Both events carry the same service, and
        // recording one is idempotent, so both take the same path.
        const onService = (service: BonjourService) => {
            try {
                const accessory = parseService(service);
                if (!accessory.id)
                    return;
                const previous = this.accessories.get(accessory.id);
                if (previous && (previous.host !== accessory.host || previous.port !== accessory.port)) {
                    this.console?.log(`${accessory.name || accessory.id} moved from `
                        + `${previous.host}:${previous.port} to ${accessory.host}:${accessory.port}`);
                }
                this.accessories.set(accessory.id, accessory);
                this.emit('accessory', accessory);
            }
            catch (e) {
                this.console?.warn('failed to parse a discovered HAP accessory', e);
            }
        };

        this.browser.on('up', onService);
        this.browser.on('update', onService);

        this.browser.on('down', service => {
            const id = (service.txt?.['id'] || '').toUpperCase();
            if (id && this.accessories.delete(id))
                this.emit('removed', id);
        });

        this.browser.start();
    }

    /**
     * Asks one host directly what HAP accessory it is, for the ones multicast cannot reach.
     *
     * This is what makes adding a camera by address workable: the port a HAP accessory listens on
     * is arbitrary and published only over mDNS, so a user who cannot discover the camera has no
     * way to know it either. The answer is remembered like any other, so the camera is then
     * addressable by its accessory id the same way a discovered one is.
     */
    async probe(host: string, timeoutMs?: number, port?: number): Promise<DiscoveredAccessory> {
        const record = await probeService(host, HAP_SERVICE, timeoutMs, port);

        const accessory: DiscoveredAccessory = {
            ...parseAccessoryTxt(record.txt),
            name: record.instance?.replace(`.${HAP_SERVICE}`, '') || host,
            host,
            port: record.port,
            // the address that answered demonstrably works, whatever the responder published.
            addresses: record.addresses?.length ? record.addresses : [host],
        };

        if (!accessory.id)
            throw new Error(`${host} answered an mDNS query but published no HomeKit accessory id`);
        if (!accessory.port)
            throw new Error(`${host} answered an mDNS query but published no port`);

        this.accessories.set(accessory.id, accessory);
        this.emit('accessory', accessory);
        return accessory;
    }

    /** Re-issues the mDNS query; discovery is passive otherwise. */
    refresh() {
        this.browser?.update();
    }

    /**
     * Queries, then gives the answers time to arrive.
     *
     * `refresh` only puts a query on the wire. Reading the cache immediately after it therefore
     * describes the network as it was *before* the query - which is what made pressing refresh
     * show the result of the press before it, and an accessory that had just appeared look absent
     * until it was pressed a second time.
     *
     * Waiting for quiet rather than for a fixed period matters in both directions: answers arrive
     * within milliseconds on a quiet segment but straggle when a router is reflecting them across
     * a VLAN, and a caller should not sit on the cap once the network has clearly finished.
     */
    async refreshAndSettle(quiet = SETTLE_QUIET_MS, cap = SETTLE_CAP_MS): Promise<void> {
        if (!this.browser)
            return;

        this.refresh();

        await new Promise<void>(resolve => {
            let quietTimer: NodeJS.Timeout;

            const finish = () => {
                clearTimeout(quietTimer);
                clearTimeout(capTimer);
                this.removeListener('accessory', onAccessory);
                resolve();
            };

            // each answer resets the clock, so a burst of them is waited out as one.
            const onAccessory = () => {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, quiet);
            };

            const capTimer = setTimeout(finish, cap);
            quietTimer = setTimeout(finish, quiet);
            this.on('accessory', onAccessory);
        });
    }

    get discovered(): DiscoveredAccessory[] {
        return [...this.accessories.values()];
    }

    find(id: string): DiscoveredAccessory {
        return this.accessories.get(id?.toUpperCase());
    }

    /**
     * Resolves an accessory's current address, waiting briefly if it has not been seen yet. HAP
     * accessories move around on DHCP, so the TXT record id is the durable handle, not the host.
     */
    async resolve(id: string, timeout = 10000): Promise<DiscoveredAccessory> {
        const existing = this.find(id);
        if (existing)
            return existing;

        this.refresh();

        return new Promise<DiscoveredAccessory>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener('accessory', onAccessory);
                reject(new Error(`HomeKit accessory ${id} was not found on the network`));
            }, timeout);

            const onAccessory = (accessory: DiscoveredAccessory) => {
                if (accessory.id !== id?.toUpperCase())
                    return;
                clearTimeout(timer);
                this.removeListener('accessory', onAccessory);
                resolve(accessory);
            };

            this.on('accessory', onAccessory);
        });
    }

    stop() {
        try {
            this.browser?.stop();
            this.bonjour?.destroy();
        }
        catch (e) {
        }
        this.browser = undefined;
        this.bonjour = undefined;
    }
}
