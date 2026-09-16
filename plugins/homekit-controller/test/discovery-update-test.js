// An accessory that moves.
//
// A HAP accessory picks an arbitrary port each time its server starts, so a reboot, a factory
// reset, or a HomeKit reset generally lands it on a different one. bonjour-hap reports that as an
// 'update' rather than an 'up', because 'up' is only emitted for a service the browser has never
// seen - so a discovery that listens to 'up' alone keeps the address the accessory moved away
// from, and every later connection to it is refused.
//
// The browser is driven directly here rather than over a real network: what is under test is the
// event wiring, and the two events differ only in which one bonjour-hap chooses to emit.

const path = require('path');

const OUT = path.resolve(__dirname, '../tsout');
const { HapDiscovery } = require(path.join(OUT, 'hap/discovery.js'));

const ACCESSORY_ID = 'AA:BB:CC:DD:EE:FF';
const STALE_PORT = 42389;
const MOVED_PORT = 39461;

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

const announcement = (port, host = '192.168.3.23') => ({
    name: 'Living Room Cam',
    host: 'living-room-cam.local',
    port,
    addresses: [host],
    txt: {
        id: ACCESSORY_ID,
        'c#': '2',
        sf: '1',
        md: 'ecobee SmartCamera',
        ci: '17',
    },
});

async function main() {
    const quiet = { log() { }, warn() { }, error() { } };
    const discovery = new HapDiscovery(quiet);
    discovery.start();

    const seen = [];
    discovery.on('accessory', accessory => seen.push(accessory.port));

    // first announcement: the browser has not seen this service before.
    discovery.browser.emit('up', announcement(STALE_PORT));

    check('an announced accessory is discovered',
        discovery.discovered.length === 1 && discovery.discovered[0].port === STALE_PORT,
        `got ${JSON.stringify(discovery.discovered.map(a => a.port))}`);

    // the accessory restarts on a new port. bonjour-hap has the service cached, so this arrives
    // as an update; before the fix it was dropped and the stale port was kept forever.
    discovery.browser.emit('update', announcement(MOVED_PORT));

    check('a moved accessory is followed to its new port',
        discovery.discovered.length === 1 && discovery.discovered[0].port === MOVED_PORT,
        `got ${JSON.stringify(discovery.discovered.map(a => a.port))}`);

    check('the move is reported to listeners',
        seen.length === 2 && seen[1] === MOVED_PORT,
        `accessory events: ${JSON.stringify(seen)}`);

    check('the accessory is not duplicated by the move',
        discovery.discovered.length === 1,
        `${discovery.discovered.length} entries`);

    // a moved address, with the port unchanged, is the other half of the same problem.
    discovery.browser.emit('update', announcement(MOVED_PORT, '192.168.3.99'));

    check('a readdressed accessory is followed too',
        discovery.discovered[0].host === '192.168.3.99',
        `host is ${discovery.discovered[0].host}`);

    // a goodbye still removes it, and a later announcement brings it back as an 'up'.
    discovery.browser.emit('down', { txt: { id: ACCESSORY_ID } });
    check('a goodbye still removes the accessory', discovery.discovered.length === 0,
        `${discovery.discovered.length} entries`);

    discovery.stop();
    console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
}

main().catch(e => {
    console.error('test error', e);
    process.exit(1);
});
