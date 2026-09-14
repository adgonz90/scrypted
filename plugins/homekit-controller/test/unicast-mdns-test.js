// Adding a camera that discovery cannot see.
//
// The port a HAP accessory listens on is arbitrary and published only over mDNS, so someone adding
// a camera by address - which is what you do when multicast does not reach it - has no way to know
// the port. Asking the host directly is how that is resolved.
//
// The responder here is written out by hand rather than borrowed from hap-nodejs, because
// hap-nodejs cannot exercise this: `bonjour-hap` answers every query to the multicast group
// regardless of who asked, so it never sends the unicast reply this depends on. Real accessories'
// embedded responders do. So what is under test is the query, the two step PTR then SRV/TXT
// exchange, and the parsing - against both shapes of answer a responder may give.

const path = require('path');
const dgram = require('dgram');
const dnsPacket = require('dns-packet');

const OUT = path.resolve(__dirname, '../tsout');
const { HapDiscovery } = require(path.join(OUT, 'hap/discovery.js'));
const { probeService } = require(path.join(OUT, 'hap/unicast-mdns.js'));

const SERVICE = '_hap._tcp.local';
const INSTANCE = `Nursery Cam.${SERVICE}`;
const TARGET = 'nursery-cam.local';
const ACCESSORY_PORT = 5051;
const ACCESSORY_ID = 'AA:BB:CC:DD:EE:FF';

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

const ptrRecord = { type: 'PTR', name: SERVICE, ttl: 120, data: INSTANCE };
const srvRecord = { type: 'SRV', name: INSTANCE, ttl: 120, data: { port: ACCESSORY_PORT, target: TARGET, priority: 0, weight: 0 } };
const txtRecord = {
    type: 'TXT', name: INSTANCE, ttl: 120, data: [
        Buffer.from(`id=${ACCESSORY_ID}`),
        Buffer.from('c#=2'),
        // status flags bit 0 set: not yet paired.
        Buffer.from('sf=1'),
        // category 17 is an IP camera.
        Buffer.from('ci=17'),
        Buffer.from('md=Nursery Cam'),
        Buffer.from('pv=1.1'),
    ],
};
const aRecord = { type: 'A', name: TARGET, ttl: 120, data: '192.168.4.41' };

/**
 * A responder that answers direct queries, the way an accessory's embedded one does.
 *
 * `chatty` decides which of the two shapes it uses: everything volunteered in the additionals of
 * the first answer, or only what was literally asked, which forces the follow up query.
 */
function responder({ chatty }) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const queries = [];

    socket.on('message', (message, rinfo) => {
        const query = dnsPacket.decode(message);
        queries.push(query.questions.map(q => `${q.type} ${q.name}`).join('+'));

        const asked = type => query.questions.some(q => q.type === type);

        let answers = [];
        let additionals = [];

        if (asked('PTR') && query.questions.some(q => q.name === SERVICE)) {
            answers = [ptrRecord];
            if (chatty)
                additionals = [srvRecord, txtRecord, aRecord];
        }
        else if (asked('SRV') || asked('TXT')) {
            answers = [srvRecord, txtRecord];
            additionals = [aRecord];
        }

        if (!answers.length)
            return;

        // Answered straight back to the asker, which is what RFC 6762 section 5.4 requires of a
        // one shot query and is the whole reason this works across a subnet.
        socket.send(dnsPacket.encode({ type: 'response', id: query.id, flags: dnsPacket.AUTHORITATIVE_ANSWER, answers, additionals }),
            rinfo.port, rinfo.address);
    });

    return new Promise(resolve => socket.bind(0, '127.0.0.1',
        () => resolve({ socket, port: socket.address().port, queries })));
}

async function main() {
    // ---- a responder that volunteers everything, which is the common case ----------------------
    {
        const fake = await responder({ chatty: true });
        const record = await probeService('127.0.0.1', SERVICE, 3000, fake.port);

        check('a direct query resolves the service', !!record, JSON.stringify(record));
        check('and reports the port, which is the whole point of asking',
            record.port === ACCESSORY_PORT, `${record.port}, expected ${ACCESSORY_PORT}`);
        check('and the TXT record it carries',
            record.txt.id === ACCESSORY_ID && record.txt.ci === '17', JSON.stringify(record.txt));
        check('one exchange is enough when the responder volunteers the details',
            fake.queries.length === 1, fake.queries.join(' | '));

        fake.socket.close();
    }

    // ---- a responder that answers only what was asked ------------------------------------------
    {
        const fake = await responder({ chatty: false });
        const record = await probeService('127.0.0.1', SERVICE, 3000, fake.port);

        check('a terse responder is asked again for the details it withheld',
            record.port === ACCESSORY_PORT && fake.queries.length === 2, fake.queries.join(' | '));
        check('and the second question asks for exactly what was missing',
            fake.queries[1] === `SRV ${INSTANCE}+TXT ${INSTANCE}`, fake.queries[1]);

        fake.socket.close();
    }

    // ---- the HAP layer on top ------------------------------------------------------------------
    {
        const fake = await responder({ chatty: true });
        const discovery = new HapDiscovery(console);

        // Deliberately not started: this is the case where multicast discovery has found nothing
        // and the user supplies an address instead.
        check('discovery has seen nothing without being started', discovery.discovered.length === 0);

        const accessory = await discovery.probe('127.0.0.1', 3000, fake.port);

        check('the accessory id is read, which is how it is tracked afterwards',
            accessory.id === ACCESSORY_ID, accessory.id);
        check('the category is read, so it is known to be a camera',
            accessory.category === 17, `${accessory.category}`);
        check('it is reported as free to pair', accessory.available === true, `available=${accessory.available}`);
        check('the name is the instance without the service suffix',
            accessory.name === 'Nursery Cam', accessory.name);
        check('the address that answered is kept, not the one the responder published',
            accessory.host === '127.0.0.1', accessory.host);
        check('a probed accessory is remembered exactly like a discovered one',
            discovery.find(ACCESSORY_ID)?.port === ACCESSORY_PORT, JSON.stringify(discovery.find(ACCESSORY_ID)));

        discovery.stop();
        fake.socket.close();
    }

    // ---- a host that answers nothing ------------------------------------------------------------
    {
        const started = Date.now();
        let failed;
        try {
            // an ephemeral port nothing is bound to.
            await probeService('127.0.0.1', SERVICE, 1200, 59999);
        }
        catch (e) {
            failed = e;
        }
        check('a host that publishes nothing times out rather than hanging',
            !!failed && Date.now() - started < 3500, failed?.message);
    }
}

main()
    .then(() => {
        console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
        process.exit(failures ? 1 : 0);
    })
    .catch(e => {
        console.error('test error', e);
        process.exit(1);
    });
