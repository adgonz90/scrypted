// Stands up a hap-nodejs camera carrying the accessories a real baby monitor and doorbell have -
// a colour night light, a speaker, a microphone, a switch, and the camera operating mode toggles -
// then checks that the controller discovers each one as the right kind of child device, and that
// writing through the discovered characteristic really moves the accessory.

const path = require('path');
const os = require('os');
const fs = require('fs');

const SCRYPTED = path.resolve(__dirname, '../../..');
const HAP_ROOT = `${SCRYPTED}/plugins/homekit/node_modules/@homebridge/hap-nodejs`;
const OUT = `${SCRYPTED}/plugins/homekit-controller/tsout`;

// camera-controls imports @scrypted/sdk for two string enums; swap in a faithful stub so this
// runs without the Scrypted plugin runtime. See sdk-stub.js.
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === '@scrypted/sdk')
        return require.resolve('./sdk-stub.js');
    return resolveFilename.call(this, request, ...args);
};

const hap = require(HAP_ROOT);
const { Accessory, Categories, Characteristic, Service, uuid, HAPStorage, SRTPCryptoSuites,
    H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate,
    AudioRecordingCodecType, AudioRecordingSamplerate, MediaContainerType } = hap;

const { HapConnection } = require(path.join(OUT, 'hap/connection.js'));
const { pairSetup } = require(path.join(OUT, 'hap/pairing.js'));
const { HapClient } = require(path.join(OUT, 'hap/client.js'));
const { discoverControls, HomeKitCameraControl } = require(path.join(OUT, 'camera-controls.js'));

const PORT = 51839;
const PINCODE = '031-45-154';
const USERNAME = 'CC:22:3D:E3:CE:F9';

HAPStorage.setCustomStoragePath(fs.mkdtempSync(path.join(os.tmpdir(), 'hap-controls-')));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

const streamingDelegate = {
    handleSnapshotRequest(request, callback) { callback(undefined, Buffer.alloc(8)); },
    prepareStream(request, callback) { callback(new Error('not needed for this test')); },
    handleStreamRequest(request, callback) { callback(); },
};

const recordingDelegate = {
    updateRecordingActive() { },
    updateRecordingConfiguration() { },
    async *handleRecordingStreamRequest() { },
    closeRecordingStream() { },
};

async function main() {
    const accessory = new Accessory('Nursery Cam', uuid.generate('homekit-controller-controls'));
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Scrypted')
        .setCharacteristic(Characteristic.Model, 'Controls Test Camera');


    // a colour night light, as on a baby monitor.
    const light = accessory.addService(Service.Lightbulb, 'Night Light');
    light.addCharacteristic(Characteristic.Brightness);
    light.addCharacteristic(Characteristic.Hue);
    light.addCharacteristic(Characteristic.Saturation);

    // a plain switch, standing in for something like a lullaby or siren toggle.
    accessory.addService(Service.Switch, 'Lullaby');

    // environmental sensors, which should NOT become child devices - they belong on the camera.
    accessory.addService(Service.TemperatureSensor, 'Nursery Temperature');
    accessory.addService(Service.HumiditySensor, 'Nursery Humidity');

    // a doorbell button.
    accessory.addService(Service.Doorbell, 'Doorbell');

    // CameraController brings the Microphone and Speaker services, and with recording configured
    // it also brings the CameraOperatingMode service and its toggles.
    accessory.configureController(new hap.CameraController({
        cameraStreamCount: 2,
        delegate: streamingDelegate,
        streamingOptions: {
            supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
            video: {
                codec: { profiles: [H264Profile.HIGH], levels: [H264Level.LEVEL4_0] },
                resolutions: [[1920, 1080, 30], [640, 360, 30]],
            },
            audio: {
                codecs: [{ type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 }],
                twoWayAudio: true,
            },
        },
        recording: {
            options: {
                prebufferLength: 4000,
                mediaContainerConfiguration: { type: MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 },
                video: {
                    type: 0,
                    parameters: { profiles: [H264Profile.HIGH], levels: [H264Level.LEVEL4_0] },
                    resolutions: [[1920, 1080, 30]],
                },
                audio: {
                    codecs: [{ type: AudioRecordingCodecType.AAC_LC, samplerate: AudioRecordingSamplerate.KHZ_32 }],
                },
            },
            delegate: recordingDelegate,
        },
        sensors: { motion: true },
    }));

    // CameraOperatingModeIndicator (the status LED) and NightVision are optional characteristics
    // that hap-nodejs only materialises on request, so add them explicitly: real cameras that have
    // a status light or IR do expose them, and they are the two the HomeKit plugin binds to the
    // Home app's native camera settings toggles.
    const operatingMode = accessory.getService(Service.CameraOperatingMode);
    operatingMode.getCharacteristic(Characteristic.CameraOperatingModeIndicator);
    operatingMode.getCharacteristic(Characteristic.NightVision);

    await accessory.publish({ username: USERNAME, pincode: PINCODE, port: PORT, category: Categories.IP_CAMERA });

    const setupConnection = new HapConnection('127.0.0.1', PORT, console);
    await setupConnection.connect();
    const pairingData = await pairSetup(setupConnection, PINCODE);
    setupConnection.destroy();

    const client = new HapClient('127.0.0.1', PORT, pairingData, console);
    await client.ensureConnected();
    const accessories = await client.getAccessories();
    const acc = accessories.accessories[0];

    // ---- discovery -----------------------------------------------------------------------
    const controls = discoverControls(acc, 'CAM', 'Nursery Cam');
    console.log('\ndiscovered controls:');
    for (const c of controls)
        console.log(`  ${c.nativeId}  type=${c.type}  [${c.interfaces.join(', ')}]  "${c.name}"`);
    console.log();

    const bySuffix = suffix => controls.find(c => c.nativeId.endsWith(suffix));
    const light1 = controls.find(c => c.type === 'Light');

    check('night light discovered as a Light', !!light1, light1?.nativeId);
    check('night light has OnOff, Brightness and colour',
        light1 && ['OnOff', 'Brightness', 'ColorSettingHsv'].every(i => light1.interfaces.includes(i)),
        light1?.interfaces.join(', '));

    const lullaby = controls.find(c => c.type === 'Switch' && c.nativeId.includes(':switch-'));
    check('plain switch discovered', !!lullaby, lullaby?.nativeId);

    const speaker = bySuffix(':speaker');
    check('speaker discovered as an AudioVolumeControl',
        speaker && speaker.type === 'Speaker' && speaker.interfaces.includes('AudioVolumeControl'),
        speaker ? `${speaker.type} [${speaker.interfaces}]` : 'missing');

    const microphone = bySuffix(':microphone');
    check('microphone discovered as an inverted switch',
        microphone && microphone.on?.inverted === true,
        microphone ? `inverted=${microphone.on?.inverted}` : 'missing');

    // the two suffixes the HomeKit plugin binds to native Home app camera toggles.
    check('status light uses the :statuslight suffix the HomeKit plugin binds to', !!bySuffix(':statuslight'));
    check('night vision uses the :nightvision-auto suffix', !!bySuffix(':nightvision-auto'));
    const cameraActive = bySuffix(':camera-active');
    check('HomeKitCameraActive discovered', !!cameraActive, cameraActive?.nativeId);

    // sensors must stay on the camera itself, not become children.
    check('temperature did not become a child device', !controls.some(c => /temperature/i.test(c.name)));
    check('humidity did not become a child device', !controls.some(c => /humidity/i.test(c.name)));
    check('motion did not become a child device', !controls.some(c => /motion/i.test(c.name)));

    // read-only characteristics are status, not controls.
    check('no control points at a read-only characteristic', controls.every(c => {
        for (const ref of [c.on, c.brightness, c.hue, c.saturation, c.volume]) {
            if (!ref)
                continue;
            for (const service of acc.services) {
                const found = service.characteristics.find(ch => ch.iid === ref.iid);
                if (found?.perms && !found.perms.includes('pw'))
                    return false;
            }
        }
        return true;
    }));

    // ---- the real control objects drive the accessory ----------------------------------------
    // Exercised through HomeKitCameraControl rather than by writing characteristics directly, so
    // the mapping under test (which iid, and which direction) is the one that actually ships.
    const host = {
        console,
        writeCharacteristic: (aid, iid, value) => client.writeCharacteristic(aid, iid, value),
    };
    const makeControl = descriptor => new HomeKitCameraControl(host, descriptor.nativeId, descriptor);

    const lightService = accessory.getService('Night Light');
    const lightControl = makeControl(light1);

    await lightControl.turnOn();
    check('turning the night light on moves the accessory',
        lightService.getCharacteristic(Characteristic.On).value === true,
        String(lightService.getCharacteristic(Characteristic.On).value));

    await lightControl.setBrightness(42);
    check('setting brightness moves the accessory',
        lightService.getCharacteristic(Characteristic.Brightness).value === 42,
        String(lightService.getCharacteristic(Characteristic.Brightness).value));

    // Scrypted passes saturation and value as 0..1; HAP wants percentages.
    await lightControl.setHsv(210, 0.75, 0.5);
    check('setting colour converts Scrypted 0..1 to HAP percentages',
        lightService.getCharacteristic(Characteristic.Hue).value === 210
        && lightService.getCharacteristic(Characteristic.Saturation).value === 75
        && lightService.getCharacteristic(Characteristic.Brightness).value === 50,
        `hue=${lightService.getCharacteristic(Characteristic.Hue).value} sat=${lightService.getCharacteristic(Characteristic.Saturation).value} bri=${lightService.getCharacteristic(Characteristic.Brightness).value}`);

    // the microphone switch is inverted: switching it off must MUTE the accessory.
    const micService = accessory.getService(Service.Microphone);
    const micControl = makeControl(microphone);
    await micControl.turnOff();
    check('microphone off mutes the accessory (inverted mapping)',
        micService.getCharacteristic(Characteristic.Mute).value === true,
        `mute=${micService.getCharacteristic(Characteristic.Mute).value}`);

    await micControl.turnOn();
    check('microphone on unmutes the accessory',
        micService.getCharacteristic(Characteristic.Mute).value === false,
        `mute=${micService.getCharacteristic(Characteristic.Mute).value}`);

    // volume travels through AudioVolumeControl.
    const speakerService = accessory.getService(Service.Speaker);
    await makeControl(speaker).setAudioVolumes({ speaker: 33 });
    check('speaker volume moves the accessory',
        speakerService.getCharacteristic(Characteristic.Volume).value === 33,
        String(speakerService.getCharacteristic(Characteristic.Volume).value));

    // the status light is the control the HomeKit plugin binds to the native Home app toggle.
    const statusLight = bySuffix(':statuslight');
    await makeControl(statusLight).turnOn();
    check('status light control moves CameraOperatingModeIndicator',
        operatingMode.getCharacteristic(Characteristic.CameraOperatingModeIndicator).value === true,
        String(operatingMode.getCharacteristic(Characteristic.CameraOperatingModeIndicator).value));

    // ---- events flow back ---------------------------------------------------------------------
    const seen = new Promise(resolve => {
        client.on('characteristic', event => {
            if (event.iid === light1.on.iid)
                resolve(event);
        });
    });
    await client.subscribe([{ aid: acc.aid, iid: light1.on.iid }]);
    setTimeout(() => lightService.updateCharacteristic(Characteristic.On, false), 250);

    const event = await Promise.race([
        seen,
        new Promise((_, reject) => setTimeout(() => reject(new Error('no event')), 5000)),
    ]).catch(e => e);
    check('accessory side change pushes an event for the control',
        event && !(event instanceof Error) && !event.value,
        event instanceof Error ? event.message : JSON.stringify(event));

    client.stop();
    await accessory.unpublish();
    accessory.destroy();

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('controls test threw:', e);
    process.exit(1);
});
