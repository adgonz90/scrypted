// Loopback test: stand up a real hap-nodejs camera accessory, then pair with it using this
// plugin's controller implementation. Validates TLV8, the pairing crypto, the encrypted framing
// and the accessory/characteristic client against a known good accessory implementation.

const path = require('path');
const os = require('os');
const fs = require('fs');

const SCRYPTED = path.resolve(__dirname, '../../..');
const HAP_ROOT = `${SCRYPTED}/plugins/homekit/node_modules/@homebridge/hap-nodejs`;
const OUT = `${SCRYPTED}/plugins/homekit-controller/tsout`;

const hap = require(HAP_ROOT);
const { Accessory, Categories, Characteristic, Service, uuid, HAPStorage, SRTPCryptoSuites,
    H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate } = hap;

const { HapConnection } = require(path.join(OUT, 'hap/connection.js'));
const { pairSetup, pairVerify } = require(path.join(OUT, 'hap/pairing.js'));
const { HapClient } = require(path.join(OUT, 'hap/client.js'));
const { Characteristic: CharUuid, Service: SvcUuid } = require(path.join(OUT, 'hap/uuids.js'));

const PORT = 51826;
const PINCODE = '031-45-154';
const USERNAME = 'CC:22:3D:E3:CE:F6';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hap-loopback-'));
HAPStorage.setCustomStoragePath(storagePath);

// a streaming delegate that never actually streams; we only exercise the control plane here.
const streamingDelegate = {
    handleSnapshotRequest(request, callback) {
        callback(undefined, Buffer.from('fake-jpeg-bytes'));
    },
    prepareStream(request, callback) {
        callback(new Error('not implemented in loopback test'));
    },
    handleStreamRequest(request, callback) {
        callback(new Error('not implemented in loopback test'));
    },
};

async function main() {
    const accessory = new Accessory('Loopback Cam', uuid.generate('homekit-controller-loopback'));

    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Scrypted')
        .setCharacteristic(Characteristic.Model, 'Loopback Camera')
        .setCharacteristic(Characteristic.SerialNumber, 'LOOPBACK-1');

    // a motion sensor, which is what drives HKSV on the Scrypted side.
    const motion = accessory.addService(Service.MotionSensor, 'Loopback Motion');

    accessory.configureController(new hap.CameraController({
        cameraStreamCount: 2,
        delegate: streamingDelegate,
        streamingOptions: {
            supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
            video: {
                codec: {
                    profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
                    levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                },
                resolutions: [
                    [1920, 1080, 30],
                    [1280, 720, 30],
                    [640, 360, 30],
                    [320, 240, 15],
                ],
            },
            audio: {
                codecs: [
                    { type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 },
                    { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_16 },
                ],
                twoWayAudio: true,
            },
        },
    }));

    await accessory.publish({
        username: USERNAME,
        pincode: PINCODE,
        port: PORT,
        category: Categories.IP_CAMERA,
        addIdentifyingMaterial: true,
    });
    console.log(`accessory published on :${PORT}`);

    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
        if (!ok)
            failures++;
    };

    // ---- pair setup ----------------------------------------------------------------------
    const setupConnection = new HapConnection('127.0.0.1', PORT, console);
    await setupConnection.connect();
    const pairingData = await pairSetup(setupConnection, PINCODE, console);
    setupConnection.destroy();

    check('pair-setup completed', !!pairingData.accessoryPairingId, `accessory id ${pairingData.accessoryPairingId}`);
    check('accessory pairing id matches advertised username',
        pairingData.accessoryPairingId.toUpperCase() === USERNAME.toUpperCase(),
        pairingData.accessoryPairingId);
    check('controller long term keys produced',
        Buffer.from(pairingData.controllerLtsk, 'base64').length === 32
        && Buffer.from(pairingData.controllerLtpk, 'base64').length === 32);
    check('accessory long term public key produced',
        Buffer.from(pairingData.accessoryLtpk, 'base64').length === 32);

    // ---- pair verify + encrypted session -------------------------------------------------
    const client = new HapClient('127.0.0.1', PORT, pairingData, console);
    await client.ensureConnected();
    check('pair-verify established an encrypted session', client.connected);

    // ---- accessory database --------------------------------------------------------------
    const accessories = await client.getAccessories();
    check('GET /accessories returned an accessory', accessories.accessories.length === 1);

    const acc = accessories.accessories[0];
    const services = acc.services.map(s => s.type);
    check('camera RTP stream management services present',
        services.filter(t => t === SvcUuid.CameraRTPStreamManagement).length === 2,
        `${services.filter(t => t === SvcUuid.CameraRTPStreamManagement).length} found`);
    check('motion sensor service present', services.includes(SvcUuid.MotionSensor));

    // ---- read a plain characteristic ------------------------------------------------------
    const infoService = acc.services.find(s => s.type === SvcUuid.AccessoryInformation);
    const modelChar = infoService.characteristics.find(c => c.type === CharUuid.Model);
    const model = await client.readCharacteristic(acc.aid, modelChar.iid);
    check('read Model characteristic', model === 'Loopback Camera', String(model));

    // ---- read a TLV8 characteristic -------------------------------------------------------
    const rtpService = acc.services.find(s => s.type === SvcUuid.CameraRTPStreamManagement);
    const svcChar = rtpService.characteristics.find(c => c.type === CharUuid.SupportedVideoStreamConfiguration);
    const tlvValue = await client.readTlvCharacteristic(acc.aid, svcChar.iid);
    check('read SupportedVideoStreamConfiguration as TLV8', tlvValue.length > 20, `${tlvValue.length} bytes`);
    fs.writeFileSync(path.join(__dirname, 'supported-video.bin'), tlvValue);

    const audioChar = rtpService.characteristics.find(c => c.type === CharUuid.SupportedAudioStreamConfiguration);
    const audioTlv = await client.readTlvCharacteristic(acc.aid, audioChar.iid);
    fs.writeFileSync(path.join(__dirname, 'supported-audio.bin'), audioTlv);
    check('read SupportedAudioStreamConfiguration as TLV8', audioTlv.length > 10, `${audioTlv.length} bytes`);

    const rtpChar = rtpService.characteristics.find(c => c.type === CharUuid.SupportedRTPConfiguration);
    const rtpTlv = await client.readTlvCharacteristic(acc.aid, rtpChar.iid);
    fs.writeFileSync(path.join(__dirname, 'supported-rtp.bin'), rtpTlv);
    check('read SupportedRTPConfiguration as TLV8', rtpTlv.length >= 3, `${rtpTlv.length} bytes`);

    // ---- event subscription ----------------------------------------------------------------
    const motionService = acc.services.find(s => s.type === SvcUuid.MotionSensor);
    const motionChar = motionService.characteristics.find(c => c.type === CharUuid.MotionDetected);

    const eventReceived = new Promise(resolve => {
        client.on('characteristic', event => {
            if (event.iid === motionChar.iid)
                resolve(event);
        });
    });

    await client.subscribe([{ aid: acc.aid, iid: motionChar.iid }]);
    check('subscribed to MotionDetected', true);

    // flip the accessory side characteristic and expect a push on our connection.
    setTimeout(() => motion.updateCharacteristic(Characteristic.MotionDetected, true), 250);
    const event = await Promise.race([
        eventReceived,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for HAP event')), 5000)),
    ]);
    check('received MotionDetected event push', !!event.value, JSON.stringify(event) + ' (HAP sends booleans as 0/1)');

    // ---- a large response, to exercise multi frame reassembly -------------------------------
    // /accessories on this accessory is already >1024 bytes, so re-read it and confirm stability.
    const again = await client.getAccessories(true);
    const bodyBig = JSON.stringify(again).length;
    check('re-read /accessories across multiple frames', again.accessories[0].services.length === acc.services.length && bodyBig > 1024, bodyBig + ' byte body, spans ' + Math.ceil(bodyBig/1024) + ' frames');

    // ---- snapshot ---------------------------------------------------------------------------
    try {
        const jpeg = await client.snapshot({ width: 640, height: 360 });
        check('POST /resource snapshot', jpeg.toString() === 'fake-jpeg-bytes', `${jpeg.length} bytes`);
    }
    catch (e) {
        check('POST /resource snapshot', false, e.message);
    }

    client.stop();
    await accessory.unpublish();
    accessory.destroy();

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('loopback test threw:', e);
    process.exit(1);
});
