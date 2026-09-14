// Full pipeline test.
//
// Stands up a hap-nodejs camera accessory whose streaming delegate really encodes H.264 + Opus and
// sends it as SRTP, exactly as a physical HomeKit camera does. Then drives it with this plugin's
// controller: pair, negotiate SetupEndpoints and SelectedRTPStreamConfiguration, decrypt the SRTP,
// republish it as RTSP, and finally decode that RTSP with ffmpeg to prove the media survived.

const path = require('path');
const os = require('os');
const fs = require('fs');
const dgram = require('dgram');
const crypto = require('crypto');
const child_process = require('child_process');

const SCRYPTED = path.resolve(__dirname, '../../..');
const HAP_ROOT = `${SCRYPTED}/plugins/homekit/node_modules/@homebridge/hap-nodejs`;
const OUT = `${SCRYPTED}/plugins/homekit-controller/src`;
// the ffmpeg that ships with the scrypted server, used here to stand in for a camera's encoder.
const FFMPEG = `${SCRYPTED}/server/node_modules/@scrypted/ffmpeg-static/artifacts/`
    + `ffmpeg-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;

const hap = require(HAP_ROOT);
const { Accessory, Categories, Characteristic, Service, uuid, HAPStorage, SRTPCryptoSuites,
    H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate } = hap;

const { HapConnection } = require(path.join(OUT, 'hap/connection.ts'));
const { pairSetup } = require(path.join(OUT, 'hap/pairing.ts'));
const { HapClient, findServices } = require(path.join(OUT, 'hap/client.ts'));
const { Service: SvcUuid, Characteristic: CharUuid } = require(path.join(OUT, 'hap/uuids.ts'));
const streamConfig = require(path.join(OUT, 'camera/stream-config.ts'));
const { HapStreamSession } = require(path.join(OUT, 'camera/stream-session.ts'));
const { createStreamSdp } = require(path.join(OUT, 'camera/sdp.ts'));
const { containsKeyframe } = require(path.join(OUT, 'camera/h264.ts'));

// the accessory side of return audio: decrypt what the controller sends to the speaker.
const { SrtpSession } = require('@koush/werift-src/packages/rtp/src/srtp/srtp');
const { RtpPacket } = require('@koush/werift-src/packages/rtp/src/rtp/rtp');
const { ProtectionProfileAes128CmHmacSha1_80 } = require('@koush/werift-src/packages/rtp/src/srtp/const');

const { listenSingleRtspClient } = require(`${SCRYPTED}/common/dist/common/src/rtsp-server.js`);
const { addTrackControls, parseSdp } = require(`${SCRYPTED}/common/dist/common/src/sdp-utils.js`);

const PORT = 51833;
const PINCODE = '031-45-154';
const USERNAME = 'CC:22:3D:E3:CE:F7';

HAPStorage.setCustomStoragePath(fs.mkdtempSync(path.join(os.tmpdir(), 'hap-stream-')));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

// What the accessory saw the controller ask for. Asserted later to prove our TLV encoding of
// SelectedRTPStreamConfiguration round trips through a real HAP implementation.
let observedStartRequest;
const observedReconfigures = [];
let ffmpegSender;
// return audio the accessory decrypted, and any packet it could not.
const returnAudioReceived = [];
const returnAudioErrors = [];

const streamingDelegate = {
    handleSnapshotRequest(request, callback) {
        callback(undefined, Buffer.alloc(64, 0xff));
    },

    prepareStream(request, callback) {
        // The accessory's own keys, for the direction it encrypts.
        //
        // SRTP keys each direction separately: the controller's keys in the request are what the
        // controller encrypts return audio with, and these are what the accessory encrypts video
        // and audio with. hap-nodejs and Scrypted's own HomeKit plugin both take the shortcut of
        // echoing the controller's keys straight back, which makes the two identical and hides a
        // controller that has the direction the wrong way round. Real cameras do not all do that,
        // so this one does it properly.
        const accessoryVideo = { key: crypto.randomBytes(16), salt: crypto.randomBytes(14) };
        const accessoryAudio = { key: crypto.randomBytes(16), salt: crypto.randomBytes(14) };
        this.accessoryKeys = { video: accessoryVideo, audio: accessoryAudio };

        // sockets the controller will send RTCP receiver reports to.
        const videoReturn = dgram.createSocket('udp4');
        const audioReturn = dgram.createSocket('udp4');
        let bound = 0;
        const onBound = () => {
            if (++bound < 2)
                return;
            callback(undefined, {
                video: {
                    port: videoReturn.address().port,
                    ssrc: crypto.randomBytes(4).readUInt32BE(0),
                    srtp_key: accessoryVideo.key,
                    srtp_salt: accessoryVideo.salt,
                },
                audio: {
                    port: audioReturn.address().port,
                    ssrc: crypto.randomBytes(4).readUInt32BE(0),
                    srtp_key: accessoryAudio.key,
                    srtp_salt: accessoryAudio.salt,
                },
            });
        };
        videoReturn.bind(0, onBound);
        audioReturn.bind(0, onBound);

        let rtcpSeen = 0;
        videoReturn.on('message', () => {
            if (++rtcpSeen === 1)
                console.log('accessory: received the first RTCP receiver report from the controller');
        });

        // Return audio arrives on the same socket the accessory sends audio from, encrypted by the
        // controller with the keys the controller declared -- not with the accessory's own.
        const decrypter = new SrtpSession({
            profile: ProtectionProfileAes128CmHmacSha1_80,
            keys: {
                localMasterKey: accessoryAudio.key,
                localMasterSalt: accessoryAudio.salt,
                remoteMasterKey: request.audio.srtp_key,
                remoteMasterSalt: request.audio.srtp_salt,
            },
        });
        audioReturn.on('message', message => {
            // skip the muxed RTCP; only media counts as return audio.
            const pt = message.readUInt8(1) & 0x7f;
            if (pt >= 64 && pt <= 95)
                return;
            try {
                returnAudioReceived.push(RtpPacket.deSerialize(decrypter.decrypt(message)));
            }
            catch (e) {
                returnAudioErrors.push(e.message);
            }
        });

        this.prepared = { request, videoReturn, audioReturn };
    },

    handleStreamRequest(request, callback) {
        if (request.type === 'reconfigure') {
            observedReconfigures.push(request.video);
            callback();
            return;
        }

        if (request.type === 'start') {
            observedStartRequest = request;

            const prepared = this.prepared;
            const target = prepared.request.targetAddress;
            // the accessory encrypts with its own keys, which is the whole point of returning them.
            const videoKey = Buffer.concat([this.accessoryKeys.video.key, this.accessoryKeys.video.salt]).toString('base64');
            const audioKey = Buffer.concat([this.accessoryKeys.audio.key, this.accessoryKeys.audio.salt]).toString('base64');

            const args = [
                '-hide_banner', '-loglevel', 'error',
                '-re',
                '-f', 'lavfi', '-i', `testsrc2=size=${request.video.width}x${request.video.height}:rate=${request.video.fps}`,
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000',

                '-map', '0:v',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p', '-g', String(request.video.fps),
                // HAP has no SDP, so a real camera must repeat SPS/PPS in band before every IDR.
                // ffmpeg's rtp muxer would otherwise hoist them into the SDP and omit them from
                // the stream, which no HomeKit controller would tolerate.
                '-bsf:v', 'dump_extra',
                '-payload_type', String(request.video.pt),
                '-ssrc', String(request.video.ssrc),
                '-f', 'rtp',
                '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', videoKey,
                `srtp://${target}:${prepared.request.video.port}?rtcpport=${prepared.request.video.port}&pkt_size=1316`,

                '-map', '1:a',
                '-c:a', 'libopus', '-ar', '24000', '-ac', '1',
                '-application', 'voip', '-frame_duration', '20',
                '-payload_type', String(request.audio.pt),
                '-ssrc', String(request.audio.ssrc),
                '-f', 'rtp',
                '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', audioKey,
                `srtp://${target}:${prepared.request.audio.port}?rtcpport=${prepared.request.audio.port}&pkt_size=376`,
            ];

            console.log('accessory: starting encoder for', `${request.video.width}x${request.video.height}@${request.video.fps}`);
            ffmpegSender = child_process.spawn(FFMPEG, args);
            ffmpegSender.stderr.on('data', d => {
                const text = d.toString().trim();
                if (text)
                    console.log('accessory ffmpeg:', text);
            });
            callback();
            return;
        }

        if (request.type === 'stop') {
            ffmpegSender?.kill();
            ffmpegSender = undefined;
        }
        callback();
    },
};

async function main() {
    const accessory = new Accessory('Stream Cam', uuid.generate('homekit-controller-stream'));
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Scrypted')
        .setCharacteristic(Characteristic.Model, 'Stream Test Camera');
    accessory.addService(Service.MotionSensor, 'Stream Motion');

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
                resolutions: [[1280, 720, 30], [640, 360, 30]],
            },
            audio: {
                codecs: [
                    { type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 },
                ],
                twoWayAudio: false,
            },
        },
    }));

    await accessory.publish({ username: USERNAME, pincode: PINCODE, port: PORT, category: Categories.IP_CAMERA });
    console.log(`accessory published on :${PORT}\n`);

    // ---- pair -------------------------------------------------------------------------------
    const setupConnection = new HapConnection('127.0.0.1', PORT, console);
    await setupConnection.connect();
    const pairingData = await pairSetup(setupConnection, PINCODE);
    setupConnection.destroy();

    const client = new HapClient('127.0.0.1', PORT, pairingData, console);
    await client.ensureConnected();
    const accessories = await client.getAccessories();
    const acc = accessories.accessories[0];

    // ---- capabilities ------------------------------------------------------------------------
    const streamServices = findServices(acc, SvcUuid.CameraRTPStreamManagement);
    check('two stream management services', streamServices.length === 2, String(streamServices.length));

    const readTlv = async (service, type) => {
        const c = service.characteristics.find(x => x.type === type);
        return Buffer.from(c.value, 'base64');
    };

    const capabilities = {
        video: streamConfig.parseSupportedVideoStreamConfiguration(await readTlv(streamServices[0], CharUuid.SupportedVideoStreamConfiguration)),
        audio: streamConfig.parseSupportedAudioStreamConfiguration(await readTlv(streamServices[0], CharUuid.SupportedAudioStreamConfiguration)),
        cryptoSuites: streamConfig.parseSupportedRTPConfiguration(await readTlv(streamServices[0], CharUuid.SupportedRTPConfiguration)),
    };
    console.log('capabilities:', streamConfig.describeCapabilities(capabilities), '\n');

    const resolution = streamConfig.largestResolution(capabilities.video);
    const audio = streamConfig.chooseAudioCodec(capabilities.audio);

    // ---- start the stream ---------------------------------------------------------------------
    const session = new HapStreamSession({
        client,
        aid: acc.aid,
        service: streamServices[0],
        video: capabilities.video,
        resolution,
        audio,
        maxBitrate: 2000,
        console,
    });

    let sdpText = createStreamSdp({
        resolution,
        profile: streamConfig.bestProfile(capabilities.video),
        level: streamConfig.bestLevel(capabilities.video),
        audio,
        sessionName: 'Stream Cam',
    });
    sdpText = addTrackControls(sdpText);
    console.log('generated SDP:\n' + sdpText.split('\r\n').map(l => '  ' + l).join('\n'));

    const parsed = parseSdp(sdpText);
    const videoTrack = parsed.msections.find(m => m.type === 'video');
    const audioTrack = parsed.msections.find(m => m.type === 'audio');
    check('SDP has a video track', !!videoTrack);
    check('SDP has an audio track', !!audioTrack);

    const rtspListener = await listenSingleRtspClient();
    console.log('rtsp url:', rtspListener.url, '\n');

    rtspListener.rtspServerPromise.then(async rtsp => {
        // rtsp.console = console;
        rtsp.client.on('error', e => console.log('rtsp client error:', e.message));
        rtsp.client.on('close', () => console.log('rtsp client closed'));
        rtsp.sdp = sdpText;
        await rtsp.handlePlayback();
        session.on('video', rtp => rtsp.sendTrack(videoTrack.control, rtp, false));
        session.on('audio', rtp => rtsp.sendTrack(audioTrack.control, rtp, false));
    }).catch(e => console.error('rtsp error', e));

    // Tally the H.264 NAL types we actually decrypt, so a missing parameter set can be blamed on
    // the sender rather than on this pipeline.
    const nalTally = new Map();
    let keyframePackets = 0;
    session.on('video', rtp => {
        if (containsKeyframe(rtp))
            keyframePackets++;
        const csrcCount = rtp[0] & 0x0f;
        const hasExtension = !!(rtp[0] & 0x10);
        let offset = 12 + csrcCount * 4;
        if (hasExtension && rtp.length >= offset + 4)
            offset += 4 + rtp.readUInt16BE(offset + 2) * 4;
        if (rtp.length <= offset)
            return;
        const tally = type => nalTally.set(type, (nalTally.get(type) || 0) + 1);
        const nalType = rtp[offset] & 0x1f;

        if (nalType === 24) {
            // STAP-A aggregates several NALs, each behind a 2 byte length. SPS and PPS are
            // normally carried together this way, so every element has to be walked.
            let p = offset + 1;
            while (p + 2 <= rtp.length) {
                const size = rtp.readUInt16BE(p);
                p += 2;
                if (!size || p + size > rtp.length)
                    break;
                tally(rtp[p] & 0x1f);
                p += size;
            }
        }
        else if (nalType === 28 || nalType === 29) {
            // fragmentation unit; only count the start fragment so slices are not double counted.
            if (rtp.length > offset + 1 && (rtp[offset + 1] & 0x80))
                tally(rtp[offset + 1] & 0x1f);
        }
        else {
            tally(nalType);
        }
    });

    await session.start();
    check('stream session started', true);

    // ---- what the accessory actually received --------------------------------------------------
    await new Promise(r => setTimeout(r, 1500));
    check('accessory received a start request', !!observedStartRequest);
    if (observedStartRequest) {
        const v = observedStartRequest.video;
        const a = observedStartRequest.audio;
        check('selected resolution round tripped', v.width === resolution.width && v.height === resolution.height,
            `${v.width}x${v.height} vs requested ${resolution.width}x${resolution.height}`);
        check('selected framerate round tripped', v.fps === resolution.fps, `${v.fps}`);
        check('selected video payload type round tripped', v.pt === 99, String(v.pt));
        check('selected video ssrc round tripped', v.ssrc === session.videoSsrc, `${v.ssrc} vs ${session.videoSsrc}`);
        check('selected max bitrate round tripped', v.max_bit_rate === 2000, String(v.max_bit_rate));
        check('selected H264 profile is HIGH', v.profile === H264Profile.HIGH, String(v.profile));
        // The lowest advertised level that can carry the frame, not simply the highest offered:
        // 1280x720@30 is 3600 macroblocks at 108000 per second, exactly level 3.1's ceiling, so
        // requesting 4.0 would be over-specifying a stream the camera has to encode.
        check('selected H264 level is the lowest that fits the frame (3.1 for 720p30)',
            v.level === H264Level.LEVEL3_1, String(v.level));
        check('selected audio codec is Opus', a.codec === AudioStreamingCodecType.OPUS, String(a.codec));
        check('selected audio payload type round tripped', a.pt === 110, String(a.pt));
        check('selected audio sample rate is 24kHz', a.sample_rate === 24, String(a.sample_rate));
        check('selected audio packet time is 20ms', a.packet_time === 20, String(a.packet_time));
    }

    // ---- decode the republished RTSP -------------------------------------------------------------
    console.log('\nreading the RTSP stream back with ffmpeg...');
    const probe = await new Promise(resolve => {
        const args = [
            '-hide_banner',
            '-rtsp_transport', 'tcp',
            '-i', rtspListener.url,
            '-t', '5',
            '-f', 'null', '-',
        ];
        const proc = child_process.spawn(FFMPEG, args);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        const timer = setTimeout(() => proc.kill(), 25000);
        proc.on('exit', () => {
            clearTimeout(timer);
            resolve(stderr);
        });
    });

    const NAL_NAMES = { 1: 'non-IDR slice', 5: 'IDR slice', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' };
    const tallyText = [...nalTally.entries()].sort((a, b) => a[0] - b[0])
        .map(([type, count]) => `${type}(${NAL_NAMES[type] || '?'})=${count}`).join(' ');
    console.log('NAL types received by the controller: ' + (tallyText || 'none'));
    check('SPS arrived in band from the accessory', nalTally.has(7), tallyText);
    check('PPS arrived in band from the accessory', nalTally.has(8), tallyText);

    // The stream start timing report keys off this, so it has to actually fire on real packets.
    check('keyframe detection fires on the real stream', keyframePackets > 0, `${keyframePackets} packets`);
    check('keyframe detection does not match every packet',
        keyframePackets < session.stats.videoPackets,
        `${keyframePackets} of ${session.stats.videoPackets}`);

    console.log('--- ffmpeg output ---');
    console.log(probe.split('\n').slice(0, 40).join('\n'));
    console.log('--- end ffmpeg output ---');
    const videoLine = probe.split('\n').find(l => l.includes('Stream #') && l.includes('Video:'));
    const audioLine = probe.split('\n').find(l => l.includes('Stream #') && l.includes('Audio:'));
    console.log('  ffmpeg video:', (videoLine || 'none').trim());
    console.log('  ffmpeg audio:', (audioLine || 'none').trim());

    check('ffmpeg decoded H.264 video from the republished stream', !!videoLine && videoLine.includes('h264'));
    check('video resolution survived the pipeline', !!videoLine && videoLine.includes(`${resolution.width}x${resolution.height}`),
        videoLine ? videoLine.trim() : 'no video stream');
    check('ffmpeg decoded Opus audio from the republished stream', !!audioLine && audioLine.includes('opus'));

    const frameMatch = [...probe.matchAll(/frame=\s*(\d+)/g)].pop();
    const frames = frameMatch ? parseInt(frameMatch[1]) : 0;
    check('a meaningful number of video frames decoded', frames > 30, `${frames} frames in 5s`);

    // Slice header errors before the first keyframe are expected and not a pipeline fault: the
    // reader joins mid GOP and has to wait up to one keyframe interval for the parameter sets.
    // Scrypted's rebroadcast caches those, so real consumers do not see this. Only genuinely fatal
    // conditions are treated as failures here.
    const fatalLines = probe.split('\n')
        .filter(l => /Invalid data found|could not find codec|Connection refused|Server returned|Immediate exit/i.test(l))
        .slice(0, 5);
    check('no fatal decode errors', fatalLines.length === 0, fatalLines.join(' | ') || 'clean');

    const sliceErrors = (probe.match(/decode_slice_header error/g) || []).length;
    console.log(`  (${sliceErrors} slice header errors while waiting for the first keyframe, expected)`);

    console.log(`\nsession stats: video ${session.stats.videoPackets} pkts / ${session.stats.videoBytes} bytes, `
        + `audio ${session.stats.audioPackets} pkts / ${session.stats.audioBytes} bytes`);
    check('SRTP video packets were decrypted', session.stats.videoPackets > 100, String(session.stats.videoPackets));
    check('SRTP audio packets were decrypted', session.stats.audioPackets > 50, String(session.stats.audioPackets));

    // ---- two way audio ------------------------------------------------------------------------
    // The talkback path is otherwise never exercised: it only runs when a user presses the button,
    // and a header built as a plain object silently fails on every packet once it is.
    const RETURN_FRAMES = 5;
    const sent = [];
    for (let i = 0; i < RETURN_FRAMES; i++) {
        // a whole RTP packet, as ffmpeg's rtp muxer emits it: 12 byte header, arbitrary payload
        // type and ssrc, timestamps paced by the encoder rather than by us.
        const header = Buffer.alloc(12);
        header.writeUInt8(0x80, 0);
        header.writeUInt8(96, 1);
        header.writeUInt16BE(4000 + i, 2);
        header.writeUInt32BE(i * 960, 4);
        header.writeUInt32BE(0x1234abcd, 8);
        const payload = crypto.randomBytes(80);
        sent.push(payload);
        // 48kHz, the clock ffmpeg stamps Opus with whatever sample rate it encoded at.
        session.sendReturnAudio(Buffer.concat([header, payload]), 48000);
    }
    await new Promise(resolve => setTimeout(resolve, 500));

    check('the accessory decrypted the return audio', returnAudioReceived.length === RETURN_FRAMES,
        `${returnAudioReceived.length}/${RETURN_FRAMES} packets${returnAudioErrors.length ? `, ${returnAudioErrors[0]}` : ''}`);
    check('return audio carries the negotiated payload type',
        returnAudioReceived.every(p => p.header.payloadType === 110));
    check('return audio carries the session ssrc the accessory was told to expect',
        returnAudioReceived.every(p => p.header.ssrc === session.audioSsrc), String(session.audioSsrc));
    // HAP excepts Opus from RFC 7587's mandatory 48kHz clock and wants RFC 3550 pacing at the
    // negotiated rate instead. This accessory negotiated 24kHz, so a 20ms frame is 480 ticks, not
    // the 960 ffmpeg stamped. Getting this wrong does not fail the stream, it just makes it crackle.
    check("return audio is repaced onto HAP's clock, not the encoder's",
        returnAudioReceived.every((p, i) => p.header.timestamp === i * 480),
        `${returnAudioReceived.map(p => p.header.timestamp).join(',')} (sent 0,960,1920,2880,3840 at ${session.audioSampleRate}Hz)`);
    check('return audio payloads arrived intact',
        returnAudioReceived.every((p, i) => p.payload.equals(sent[i])));

    // ---- reconfiguration, which is what HomeKit calls adaptive bitrate -------------------------
    // A phone moving onto cellular asks for a smaller, cheaper stream. HAP can change a running
    // session rather than restarting it, and answering that is the difference between the camera
    // encoding what was asked for and it pushing its full bitrate at a link that cannot carry it.
    await session.reconfigure({ bitrate: 300, width: 640, height: 360 });
    await new Promise(resolve => setTimeout(resolve, 500));

    const reconfigure = observedReconfigures[observedReconfigures.length - 1];
    check('the accessory received a reconfigure request', !!reconfigure,
        `${observedReconfigures.length} received`);
    if (reconfigure) {
        check('the reconfigure carries the new bitrate ceiling', reconfigure.max_bit_rate === 300,
            `${reconfigure.max_bit_rate}kbps`);
        // snapped onto a size the accessory advertised, since anything else is refused outright.
        check('and a resolution the accessory actually advertises',
            reconfigure.width === 640 && reconfigure.height === 360,
            `${reconfigure.width}x${reconfigure.height}`);
        check('and the session tracks what it asked for',
            session.currentMaxBitrate === 300 && session.currentResolution.width === 640,
            `${session.currentResolution.width}x${session.currentResolution.height} at ${session.currentMaxBitrate}kbps`);
    }

    // asking again for what it already has is not worth a round trip to the camera.
    const before = observedReconfigures.length;
    await session.reconfigure({ bitrate: 300, width: 640, height: 360 });
    await new Promise(resolve => setTimeout(resolve, 200));
    check('a reconfigure that changes nothing is not sent', observedReconfigures.length === before,
        `${observedReconfigures.length - before} extra`);

    // ---- teardown ----------------------------------------------------------------------------
    await session.stop();
    check('session stopped cleanly', true);

    ffmpegSender?.kill();
    client.stop();
    await accessory.unpublish();
    accessory.destroy();

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('streaming loopback threw:', e);
    ffmpegSender?.kill();
    process.exit(1);
});
