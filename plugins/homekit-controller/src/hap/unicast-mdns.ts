// Asking one host directly what it publishes, rather than waiting to overhear it.
//
// Discovery is multicast, and routers do not forward multicast between subnets - so an accessory
// on another VLAN, or behind an access point with multicast filtering, is invisible even though it
// is perfectly reachable by unicast. That is precisely the case where a user knows the camera's
// address and still cannot add it.
//
// RFC 6762 section 5.4 covers it: a query sent straight to a host's port 5353 is answered
// directly. Sending it from an ephemeral port makes it a one-shot query, which a responder answers
// unicast without any of the multicast machinery being involved.
//
// What this mostly buys is the port. A HAP accessory listens on an arbitrary one - a camera
// observed here uses 5051, while hap-nodejs defaults to 51826 - published only in the SRV record,
// so a user adding a camera by address has no way to know it.
//
// This knows nothing about HAP on purpose: it resolves a DNS-SD service on a host and returns what
// the records said.
//
// It depends on the accessory implementing section 5.4, which the responders embedded in real
// devices do and which `bonjour-hap` - and so anything built on hap-nodejs, including Homebridge -
// does not: it answers every query to the multicast group regardless of who asked. So this is
// best effort, and the port stays enterable by hand for the accessories it cannot reach.

import dgram from 'dgram';
import dnsPacket from 'dns-packet';

const MDNS_PORT = 5353;

export interface MdnsServiceRecord {
    /** The full service instance name, as published. */
    instance: string;
    port: number;
    /** Addresses the responder published for itself, which need not include the one asked. */
    addresses: string[];
    /** The TXT record, split on the first `=` of each part, keys lowercased. */
    txt: Record<string, string>;
}

/** Flattens a TXT record's parts into a key=value map. */
function decodeTxt(data: any): Record<string, string> {
    const parts: any[] = Array.isArray(data) ? data : [data];
    const txt: Record<string, string> = {};
    for (const part of parts) {
        const text = Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
        const split = text.indexOf('=');
        if (split > 0)
            txt[text.substring(0, split).toLowerCase()] = text.substring(split + 1);
    }
    return txt;
}

/**
 * Resolves a DNS-SD service by asking one host for it directly.
 *
 * Rejects on timeout, which is the normal outcome for a host that publishes nothing, is not
 * reachable on 5353, or is not the kind of device expected.
 */
export function probeService(host: string, service: string, timeoutMs = 4000, port = MDNS_PORT): Promise<MdnsServiceRecord> {
    return new Promise<MdnsServiceRecord>((resolve, reject) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        let settled = false;
        const finish = (error: Error, record?: MdnsServiceRecord) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.close();
            }
            catch (e) {
            }
            if (error)
                reject(error);
            else
                resolve(record);
        };

        const timer = setTimeout(
            () => finish(new Error(`${host} did not answer a direct mDNS query for ${service}`)),
            timeoutMs);

        const send = (questions: any[]) => {
            let query: Buffer;
            try {
                query = dnsPacket.encode({ type: 'query', id: 0, flags: 0, questions });
            }
            catch (e) {
                finish(e as Error);
                return;
            }
            socket.send(query, port, host, e => {
                if (e)
                    finish(e);
            });
        };

        // Asked only if the first answer named the instance without describing it. Responders
        // differ: some put the whole service in the additionals, others answer just the question.
        let askedForDetails: string;

        socket.on('error', e => finish(e as Error));

        socket.on('message', message => {
            let decoded: any;
            try {
                decoded = dnsPacket.decode(message);
            }
            catch (e) {
                // not every datagram arriving on this socket has to be for us.
                return;
            }

            const records = [...(decoded.answers || []), ...(decoded.additionals || [])];

            const pointer = records.find(record => record.type === 'PTR' && record.name === service);
            const instance: string = pointer?.data;

            // Match the instance when one was named, and otherwise take whatever SRV and TXT the
            // host offered: a responder answering a direct SRV query does not repeat the PTR.
            const srv = records.find(record => record.type === 'SRV' && (!instance || record.name === instance));
            const txtRecord = records.find(record => record.type === 'TXT' && (!instance || record.name === instance));

            if (!srv || !txtRecord) {
                if (instance && askedForDetails !== instance) {
                    askedForDetails = instance;
                    send([
                        { type: 'SRV', name: instance, class: 'IN' },
                        { type: 'TXT', name: instance, class: 'IN' },
                    ]);
                }
                return;
            }

            finish(undefined, {
                instance: instance || srv.name,
                port: srv.data?.port,
                addresses: records.filter(record => record.type === 'A').map(record => record.data as string),
                txt: decodeTxt(txtRecord.data),
            });
        });

        // an ephemeral source port is what makes this a one-shot query, answered unicast.
        socket.bind(0, () => send([{ type: 'PTR', name: service, class: 'IN' }]));
    });
}
