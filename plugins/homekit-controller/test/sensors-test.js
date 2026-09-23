// Sensor and event wiring, end to end through the real device class.
//
// Everything else in this plugin is exercised against a hap-nodejs accessory, but the path that
// turns an accessory's characteristic push into a Scrypted property had no coverage at all: the
// client level event test proves a push arrives, and stops there. That gap is exactly where a
// motion sensor that is exposed but never fires would hide, so this drives the whole chain -
// subscribe, accessory pushes, HomeKitCamera routes it, the Scrypted property moves.

const path = require('path');
const os = require('os');
const fs = require('fs');

const SCRYPTED = path.resolve(__dirname, '../../..');
const HAP_ROOT = `${SCRYPTED}/plugins/homekit/node_modules/@homebridge/hap-nodejs`;
const SRC = `${SCRYPTED}/plugins/homekit-controller/src`;

// camera-device imports @scrypted/sdk for enums, the device base, and the two managers; swap in a
// faithful stub so this runs without the Scrypted plugin runtime. See sdk-stub.js.
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === '@scrypted/sdk')
        return require.resolve('./sdk-stub.js');
    return resolveFilename.call(this, request, ...args);
};

const hap = require(HAP_ROOT);
const { Accessory, Categories, Characteristic, Service, uuid, HAPStorage, SRTPCryptoSuites,
    H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate } = hap;

const sdkStub = require('./sdk-stub.js');
const { HapConnection } = require(path.join(SRC, 'hap/connection.ts'));
const { pairSetup } = require(path.join(SRC, 'hap/pairing.ts'));
const { HomeKitCamera } = require(path.join(SRC, 'camera-device.ts'));

const PORT = 51843;
const PINCODE = '031-45-154';
const USERNAME = 'CC:22:3D:E3:CE:FB';
const NATIVE_ID = 'CAM';

HAPStorage.setCustomStoragePath(fs.mkdtempSync(path.join(os.tmpdir(), 'hap-sensors-')));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

/** Waits for a device property to reach a value, since an event push is asynchronous. */
async function waitFor(describe, read, expected, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (read() === expected)
            return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    console.log(`       ${describe}: wanted ${JSON.stringify(expected)}, still ${JSON.stringify(read())}`);
    return false;
}

const streamingDelegate = {
    handleSnapshotRequest(request, callback) { callback(undefined, Buffer.alloc(8)); },
    prepareStream(request, callback) { callback(new Error('not needed for this test')); },
    handleStreamRequest(request, callback) { callback(); },
};

async function main() {
    const accessory = new Accessory('Nursery Cam', uuid.generate('homekit-controller-sensors'));
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Scrypted')
        .setCharacteristic(Characteristic.Model, 'Sensors Test Camera');

    // the sensors a baby monitor carries, each of which becomes a property of the camera itself.
    const motion = accessory.addService(Service.MotionSensor, 'Nursery Motion');
    const temperature = accessory.addService(Service.TemperatureSensor, 'Nursery Temperature');
    const humidity = accessory.addService(Service.HumiditySensor, 'Nursery Humidity');
    const occupancy = accessory.addService(Service.OccupancySensor, 'Crib Occupancy');
    const light = accessory.addService(Service.LightSensor, 'Nursery Light');
    const doorbell = accessory.addService(Service.Doorbell, 'Doorbell');

    const battery = accessory.addService(Service.Battery, 'Battery');
    battery.setCharacteristic(Characteristic.BatteryLevel, 62);
    battery.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.CHARGING);

    // a camera stream service is mandatory: the device refuses to initialize without one.
    accessory.configureController(new hap.CameraController({
        cameraStreamCount: 1,
        delegate: streamingDelegate,
        streamingOptions: {
            supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
            video: {
                codec: { profiles: [H264Profile.HIGH], levels: [H264Level.LEVEL4_0] },
                resolutions: [[1280, 720, 30]],
            },
            audio: {
                codecs: [{ type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 }],
            },
        },
    }));

    // seeded before the device connects, so the values it starts with are not the HAP defaults;
    // this is what separates the seeding path from the event path below.
    temperature.setCharacteristic(Characteristic.CurrentTemperature, 21.5);
    humidity.setCharacteristic(Characteristic.CurrentRelativeHumidity, 48);
    light.setCharacteristic(Characteristic.CurrentAmbientLightLevel, 300);

    await accessory.publish({ username: USERNAME, pincode: PINCODE, port: PORT, category: Categories.IP_CAMERA });

    const setupConnection = new HapConnection('127.0.0.1', PORT, console);
    await setupConnection.connect();
    const pairingData = await pairSetup(setupConnection, PINCODE);
    setupConnection.destroy();

    // The device reads its pairing and address during construction, so storage is seeded first.
    // The address override keeps mDNS out of it entirely.
    const storage = sdkStub.__storage(NATIVE_ID);
    storage.setItem('pairingData', JSON.stringify(pairingData));
    storage.setItem('accessoryId', pairingData.accessoryPairingId);
    storage.setItem('host', '127.0.0.1');
    storage.setItem('port', String(PORT));

    const provider = {
        // no mDNS in this test: the address is configured, so discovery is only listened to.
        discovery: {
            on: () => { },
            find: () => undefined,
            resolve: async () => { throw new Error('mDNS is not used in this test'); },
        },
        pendingPairings: new Map(),
    };

    const camera = new HomeKitCamera(provider, NATIVE_ID);
    await camera.initialize();

    // ---- what the plugin announced ------------------------------------------------------------
    const device = sdkStub.__discovered[sdkStub.__discovered.length - 1];
    const interfaces = device?.interfaces || [];
    check('announced the MotionSensor interface', interfaces.includes('MotionSensor'), interfaces.join(', '));
    check('announced the sensor interfaces the accessory carries',
        ['Thermometer', 'HumiditySensor', 'AmbientLightSensor', 'OccupancySensor', 'BinarySensor', 'Battery', 'Charger']
            .every(i => interfaces.includes(i)),
        interfaces.join(', '));

    // ---- values seeded from the accessory database, before any event ---------------------------
    check('temperature seeded from the accessory', camera.temperature === 21.5, `${camera.temperature}`);
    check('humidity seeded from the accessory', camera.humidity === 48, `${camera.humidity}`);
    check('battery level seeded from the accessory', camera.batteryLevel === 62, `${camera.batteryLevel}`);
    // Rebroadcast refuses to prebuffer a battery device that is not charging, and no prebuffer
    // means no HomeKit Secure Video, so this one is load bearing rather than cosmetic.
    check('charge state seeded from the accessory', camera.chargeState === 'charging', `${camera.chargeState}`);
    check('motion starts clear', camera.motionDetected === false, `${camera.motionDetected}`);

    // ---- the event path, which is the whole point ----------------------------------------------
    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    check('an accessory motion push reaches MotionSensor.motionDetected',
        await waitFor('motionDetected', () => camera.motionDetected, true));

    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    check('motion clears again when the accessory says so',
        await waitFor('motionDetected', () => camera.motionDetected, false));

    // a second round, because a subscription that only survives one push is its own failure.
    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    check('motion fires a second time on the same subscription',
        await waitFor('motionDetected', () => camera.motionDetected, true));
    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    await waitFor('motionDetected', () => camera.motionDetected, false);

    // ---- Motion Timeout: pulses become one event ------------------------------------------------
    // A camera that detects in its vendor's cloud reports motion as pulses with gaps between them,
    // and every gap reaches HomeKit as a fresh event - one Arlo here produced two notifications per
    // recording. The hold bridges the gaps, and must still let go once motion has really stopped.
    await camera.putSetting('motionTimeout', 1.5);

    // sample continuously, since the failure is a brief drop that a single read would miss.
    let droppedDuringHold = false;
    let sampling = false;
    const sampler = setInterval(() => {
        if (sampling && camera.motionDetected === false)
            droppedDuringHold = true;
    }, 10);

    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    await waitFor('motionDetected', () => camera.motionDetected, true);
    const onSince = camera.motionOnSince;
    const stuckTimer = camera.stuckMotionTimer;
    sampling = true;
    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    await new Promise(resolve => setTimeout(resolve, 500));
    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    sampling = false;
    check('with a motion timeout, a short gap between pulses never reaches Scrypted', !droppedDuringHold);

    // the stuck-motion warning measures from when motion began, and a bridged gap is not an end:
    // treating the camera's false as one restarted that clock on every pulse.
    check('a bridged gap does not restart the measure of how long motion has been on',
        onSince !== undefined && camera.motionOnSince === onSince, `${onSince} -> ${camera.motionOnSince}`);
    check('nor re-arm the stuck-motion warning', stuckTimer !== undefined && camera.stuckMotionTimer === stuckTimer);

    // and a camera that repeats true while motion is already on must not push the warning back.
    camera.applyMotion(true);
    camera.applyMotion(true);
    check('repeated motion pushes do not restart the stuck-motion warning', camera.stuckMotionTimer === stuckTimer);

    const clearedAt = Date.now();
    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    await new Promise(resolve => setTimeout(resolve, 700));
    check('motion is still held a moment after the camera clears it', camera.motionDetected === true);
    const released = await waitFor('motionDetected', () => camera.motionDetected, false, 4000);
    const heldFor = Date.now() - clearedAt;
    check('and released once the timeout passes with no more motion',
        released && heldFor >= 1400 && heldFor < 3000, `held ${heldFor}ms for a 1500ms timeout`);

    // turning the hold off mid hold should take effect then, not when the hold would have ended.
    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    await waitFor('motionDetected', () => camera.motionDetected, true);
    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    await new Promise(resolve => setTimeout(resolve, 200));
    await camera.putSetting('motionTimeout', 0);
    check('setting the timeout to 0 during a hold clears motion immediately', camera.motionDetected === false);

    // and off, the camera's own report goes straight through.
    motion.updateCharacteristic(Characteristic.MotionDetected, true);
    await waitFor('motionDetected', () => camera.motionDetected, true);
    motion.updateCharacteristic(Characteristic.MotionDetected, false);
    check('with no timeout, motion clears as soon as the camera says so',
        await waitFor('motionDetected', () => camera.motionDetected, false, 1000));
    clearInterval(sampler);

    occupancy.updateCharacteristic(Characteristic.OccupancyDetected, 1);
    check('occupancy events arrive', await waitFor('occupied', () => camera.occupied, true));

    temperature.updateCharacteristic(Characteristic.CurrentTemperature, 23);
    check('temperature events arrive', await waitFor('temperature', () => camera.temperature, 23));

    light.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 12);
    check('ambient light events arrive', await waitFor('ambientLight', () => camera.ambientLight, 12));

    // a doorbell press is a stateless event, not a level, and is held briefly on the Scrypted side.
    doorbell.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, 0);
    check('a doorbell press sets BinarySensor.binaryState',
        await waitFor('binaryState', () => camera.binaryState, true));
    check('the doorbell press clears itself',
        await waitFor('binaryState', () => camera.binaryState, false, 6000));

    // ---- the poll that covers an accessory which accepts a subscription and then ignores it ----
    // Written straight onto the characteristic rather than through updateCharacteristic, so the
    // value a read returns changes while nothing is pushed - which is exactly how firmware that
    // does not honour its subscriptions behaves, and is indistinguishable from a quiet sensor.
    battery.getCharacteristic(Characteristic.BatteryLevel).value = 41;
    check('a characteristic the accessory never pushes is picked up by the poll',
        await waitFor('batteryLevel', () => camera.batteryLevel, 41, 25000));

    // ---- the debug gate -----------------------------------------------------------------------
    // The verbose diagnostics are only worth having if they are genuinely off by default: this
    // plugin logs per keyframe and per RTSP message, which would otherwise bury everything else.
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => captured.push(args.join(' '));
    try {
        camera.console.debug('probe while off');
        storage.setItem('debugLogging', 'true');
        camera.console.debug('probe while on');
        camera.console.log('always printed');
    }
    finally {
        console.log = realLog;
        storage.setItem('debugLogging', 'false');
    }

    check('debug output is suppressed by default', !captured.includes('probe while off'), captured.join(' | '));
    check('debug output appears once the setting is on', captured.includes('probe while on'));
    check('ordinary logging is unaffected', captured.includes('always printed'));

    await camera.release();
    accessory.unpublish();
    accessory.destroy();
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
