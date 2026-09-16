// An accessory that moves, and a refresh that waits.
//
// A HAP accessory picks an arbitrary port each time its server starts, so a reboot, a factory
// reset, or a HomeKit reset generally lands it on a different one. bonjour-hap reports that as an
// 'update' rather than an 'up', because 'up' is emitted only for a service the browser has never
// seen - so a discovery that listens to 'up' alone keeps the address the accessory moved away
// from, and every later connection to it is refused while mDNS itself works perfectly.
//
// The browser here is wired up as in production but detached from the mDNS socket. What is under
// test is which events are wired up and how long a query is given to answer, and a live browser
// mixes in whatever accessories happen to be on the network running the test - which is both non
// deterministic and, since half of these assertions are about timing, actively misleading.

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

const quiet = { log() { }, warn() { }, error() { } };

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

/**
 * A discovery whose browser is wired up as in production but detached from the mDNS socket, so
 * the only announcements its handlers see are the ones a test emits. `Browser.stop` drops the
 * socket's response listener while leaving the browser an event emitter, which is exactly the
 * seam this needs - the alternative, a real browser, mixes in whatever happens to be on the
 * network running the test, and the timing assertions below are about nothing else.
 */
function isolated() {
    const discovery = new HapDiscovery(quiet);
    discovery.start();
    discovery.browser.stop();
    return discovery;
}

async function main() {
    const discovery = isolated();
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
        discovery.discovered.length === 1, `${discovery.discovered.length} entries`);

    // a moved address with the port unchanged is the other half of the same problem.
    discovery.browser.emit('update', announcement(MOVED_PORT, '192.168.3.99'));

    check('a readdressed accessory is followed too',
        discovery.discovered[0].host === '192.168.3.99',
        `host is ${discovery.discovered[0].host}`);

    // a goodbye still removes it.
    discovery.browser.emit('down', { txt: { id: ACCESSORY_ID } });
    check('a goodbye still removes the accessory',
        discovery.discovered.length === 0, `${discovery.discovered.length} entries`);

    discovery.stop();

    // Reading the cache the moment a query goes out describes the network as it was *before* the
    // query, so an answer arriving a moment later misses the list it was asked for. That is what
    // made pressing refresh show the result of the press before it.
    const late = isolated();
    setTimeout(() => late.browser.emit('up', announcement(40001)), 300);
    const lateAt = Date.now();
    await late.refreshAndSettle();
    const lateWaited = Date.now() - lateAt;

    check('a settled refresh waits for an answer that arrives after the query',
        late.discovered.length === 1 && late.discovered[0].port === 40001,
        `discovered ${JSON.stringify(late.discovered.map(a => a.port))} after ${lateWaited}ms`);

    check('a settled refresh returns once answers stop, well inside the cap',
        lateWaited >= 300 && lateWaited < 2500, `waited ${lateWaited}ms`);
    late.stop();

    // a network with nothing to say must not hold the caller for the full cap.
    const silent = isolated();
    const silentAt = Date.now();
    await silent.refreshAndSettle();
    const silentWaited = Date.now() - silentAt;

    check('a silent network settles on the quiet period, not the cap',
        silentWaited >= 700 && silentWaited < 1500, `waited ${silentWaited}ms`);
    silent.stop();

    // a steady stream of answers must not hold it open indefinitely either.
    const chatty = isolated();
    const chatter = setInterval(() => chatty.browser.emit('up', announcement(40002)), 200);
    const chattyAt = Date.now();
    await chatty.refreshAndSettle();
    const chattyWaited = Date.now() - chattyAt;
    clearInterval(chatter);

    check('a chatty network is cut off at the cap',
        chattyWaited >= 2900 && chattyWaited < 3600, `waited ${chattyWaited}ms`);
    chatty.stop();

    console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
}

main().catch(e => {
    console.error('test error', e);
    process.exit(1);
});
