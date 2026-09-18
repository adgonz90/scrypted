
import { getDebugModeH264EncoderArgs } from "@scrypted/common/src/ffmpeg-hardware-acceleration";
import { addVideoFilterArguments } from "@scrypted/common/src/ffmpeg-helpers";
import { FFmpegFragmentedMP4Session, parseFragmentedMP4, startFFMPegFragmentedMP4Session } from '@scrypted/common/src/ffmpeg-mp4-parser-session';
import { ffmpegLogInitialOutput, safeKillFFmpeg } from '@scrypted/common/src/media-helpers';
import { timeoutPromise } from "@scrypted/common/src/promise-utils";
import sdk, { AudioSensor, FFmpegInput, MotionSensor, ScryptedDevice, ScryptedInterface, ScryptedMimeTypes, VideoCamera } from '@scrypted/sdk';
import child_process from "child_process";
import fs from 'fs';
import { mkdirp } from 'mkdirp';
import net from 'net';
import path from 'path';
import { Duplex, Readable, Writable } from 'stream';
import { } from '../../common';
import { AudioRecordingCodecType, CameraRecordingConfiguration, RecordingPacket } from '../../hap';
import type { HomeKitPlugin } from "../../main";
import { getDebugMode } from "./camera-debug-mode-storage";
import { HksvVideoClip, VIDEO_CLIPS_NATIVE_ID, getCameraRecordingFiles } from './camera-recording-files';
import { getRecordingLimits } from './camera-recording-limits';
import { FORCE_OPUS, checkCompatibleCodec, transcodingDebugModeWarning } from './camera-utils';
import { NAL_TYPE_DELIMITER, NAL_TYPE_FU_A, NAL_TYPE_IDR, NAL_TYPE_PPS, NAL_TYPE_SEI, NAL_TYPE_SPS, NAL_TYPE_STAP_A } from "./h264-packetizer";

const { log, mediaManager, deviceManager } = sdk;

export const iframeIntervalSeconds = 4;

/**
 * Consecutive recordings ended by the ceiling, per camera.
 *
 * HomeKit ends a recording when it has what it wants, so a run of them ending any other way means
 * it has stopped managing this camera's recordings - and in the case that prompted this, stopped
 * saving them too, while still asking for more. Everything downstream of that is wasted: the
 * prebuffer, the mux, the upload. Nothing said so, because each recording looks fine on its own
 * and only the run is evidence.
 */
const consecutiveUnclosed = new Map<string, number>();

/** How many in a row before saying something. Two is within the range of ordinary long events. */
const UNCLOSED_WARN_AT = 3;

const allowedNaluTypes = [
    NAL_TYPE_STAP_A,
    NAL_TYPE_SPS,
    NAL_TYPE_PPS,
    NAL_TYPE_SEI,
    NAL_TYPE_DELIMITER,
];

const AudioRecordingSamplerateValues = {
    0: 8,
    1: 16,
    2: 24,
    3: 32,
    4: 44.1,
    5: 48,
};

async function checkMp4StartsWithKeyFrame(console: Console, mp4: Buffer) {
    const cp = child_process.spawn(await mediaManager.getFFmpegPath(), [
        '-hide_banner',
        '-f', 'mp4',
        '-i', 'pipe:3',
        '-vcodec', 'copy',
        '-f', 'h264',
        'pipe:4',
    ], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    ffmpegLogInitialOutput(console, cp);
    const input = cp.stdio[3] as Writable;
    input.write(mp4);
    input.end();

    const output = cp.stdio[4] as Readable;

    const buffers: Buffer[] = [];
    output.on('data', data => buffers.push(data));

    try {
        await timeoutPromise(1000, new Promise(resolve => cp.on('exit', resolve)));
        const h264 = Buffer.concat(buffers);
        let offset = 0;
        let countedZeroes = 0;
        while (offset < h264.length - 6) {
            const byte = h264[offset];
            if (byte === 0) {
                countedZeroes = Math.min(4, countedZeroes + 1);
                offset++;
                continue;
            }

            if (countedZeroes < 2) {
                countedZeroes = 0;
                offset++
                continue;
            }

            countedZeroes = 0;
            if (byte !== 1) {
                offset++;
                continue;
            }

            offset++;

            let naluType = h264.readUInt8(offset) & 0x1f;
            if (naluType === NAL_TYPE_FU_A) {
                offset++;
                naluType = h264.readUInt8(offset) & 0x1f;
            }

            if (naluType === NAL_TYPE_IDR)
                return true;

            if (allowedNaluTypes.includes(naluType)) {
                offset++;
                continue;
            }
            console.warn('skipping mp4 fragment: non idr frame', naluType);
            return false;
        }
        console.warn('skipping mp4 fragment: no idr frame found');
        return false;
    }
    catch (e) {
        console.warn('skipping mp4 fragment: error', e);
        return false;
    }
}

export async function* handleFragmentsRequests(streamId: number, device: ScryptedDevice & VideoCamera & MotionSensor & AudioSensor,
    configuration: CameraRecordingConfiguration, console: Console, homekitPlugin: HomeKitPlugin, isOpen: () => boolean): AsyncGenerator<RecordingPacket> {

    // homekitPlugin.storageSettings.values.lastKnownHomeHub = connection.remoteAddress;

    // console.log(device.name, 'recording session starting', connection.remoteAddress, configuration);

    const storage = deviceManager.getMixinStorage(device.id, undefined);
    const debugMode = getDebugMode(storage);
    const saveRecordings = debugMode.recording;

    // request more than needed, and determine what to do with the fragments after receiving them.
    const prebuffer = configuration.prebufferLength * 2.5;

    const media = await device.getVideoStream({
        destination: 'remote-recorder',
        video :{
            codec: 'h264',
            alternateCodecs: ['h264', 'h265'],
        },
        audio: {
            codec: 'aac',
        },
        prebuffer,
        container: 'mp4',
    });
    const ffmpegInput = JSON.parse((await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput)).toString()) as FFmpegInput;
    const noAudio = ffmpegInput.mediaStreamOptions && ffmpegInput.mediaStreamOptions.audio === null;
    const audioCodec = ffmpegInput.mediaStreamOptions?.audio?.codec;
    const videoCodec = ffmpegInput.mediaStreamOptions?.video?.codec;

    const isHevc = videoCodec?.toLowerCase() === 'h265' || videoCodec?.toLowerCase() === 'hevc';

    const isDefinitelyNotAAC = !audioCodec || audioCodec.toLowerCase().indexOf('aac') === -1;
    const needsFFmpeg = debugMode.video || debugMode.video
        || !ffmpegInput.url.startsWith('tcp://')
        || ffmpegInput.container !== 'mp4'
        || noAudio;

    if (debugMode.video || debugMode.video)
        transcodingDebugModeWarning();

    let session: FFmpegFragmentedMP4Session & { socket?: Duplex };

    if (!needsFFmpeg) {
        console.log('prebuffer is tcp/mp4/h264/aac compatible. using direct tcp.');
        const socketUrl = new URL(ffmpegInput.url);
        const socket = net.connect(parseInt(socketUrl.port), socketUrl.hostname);
        session = {
            socket,
            cp: undefined,
            generator: parseFragmentedMP4(socket, 30000),
        }
    }
    else {
        const inputArguments: string[] = [];
        const request: any = {
            video: {
                width: configuration.videoCodec.resolution[0],
                height: configuration.videoCodec.resolution[1],
                fps: configuration.videoCodec.resolution[2],
                max_bit_rate: configuration.videoCodec.parameters.bitRate,
            }
        }

        // ffmpeg's native opus decoder mis-parses SILK in-band FEC (LBRR) frames,
        // which Ring cameras send, and outputs loud bursts of noise. libopus decodes them correctly.
        if (audioCodec?.toLowerCase() === 'opus')
            inputArguments.push('-c:a', 'libopus');
        inputArguments.push(...ffmpegInput.inputArguments);

        if (noAudio) {
            console.log(device.name, 'adding dummy audio track');
            const silence = path.resolve(process.env.SCRYPTED_PLUGIN_VOLUME, 'zip/unzipped/fs/silence.mp4');
            inputArguments.push('-stream_loop', '-1', '-i', silence);
        }

        let audioArgs: string[];
        if (!noAudio && (isDefinitelyNotAAC || debugMode.audio)) {
            if (!debugMode.audio)
                console.warn('Recording audio is not explicitly AAC, forcing transcoding. Setting audio output to AAC is recommended.', audioCodec);

            let aacLowEncoder = 'aac';
            const forceOpus = FORCE_OPUS;
            if (!forceOpus) {
                aacLowEncoder = 'libfdk_aac';
            }

            audioArgs = [
                ...(configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC ?
                    ['-acodec', aacLowEncoder, '-profile:a', 'aac_low'] :
                    ['-acodec', 'libfdk_aac', '-profile:a', 'aac_eld']),
                '-ar', `${AudioRecordingSamplerateValues[configuration.audioCodec.samplerate]}k`,
                // technically, this should be used for VBR (which this plugin offers).
                // will see about changing it later.
                // '-q:a', '3',
                // this is used for CBR.
                '-b:a', `${configuration.audioCodec.bitrate}k`,
                '-ac', `${configuration.audioCodec.audioChannels}`
            ];
        }
        else {
            audioArgs = [
                '-acodec', 'copy',
                '-bsf:a', 'aac_adtstoasc',
            ];
        }

        const videoArgs: string[] = [];
        if (debugMode.video) {
            if (debugMode.video) {
                videoArgs.push(...getDebugModeH264EncoderArgs());
            }
            const videoRecordingFilter = `scale=w='min(${configuration.videoCodec.resolution[0]},iw)':h=-2`;
            addVideoFilterArguments(videoArgs, videoRecordingFilter);
            videoArgs.push(
                '-b:v', `${configuration.videoCodec.parameters.bitRate}k`,
                "-bufsize", (2 * request.video.max_bit_rate).toString() + "k",
                "-maxrate", request.video.max_bit_rate.toString() + "k",
                // used to use this but switched to group of picture (gop) instead.
                // '-force_key_frames', `expr:gte(t,n_forced*${iframeIntervalSeconds})`,
                '-g', `${iframeIntervalSeconds * request.video.fps}`,
                '-r', `${request.video.fps}`,
            );
        }
        else {
            if (!isHevc)
                checkCompatibleCodec(console, device, videoCodec);
            videoArgs.push(
                '-vcodec', 'copy',
            );
            if (isHevc)
                videoArgs.push('-tag:v', 'hvc1');
        }

        // The HSV3 HDS receiver expects producer reference time on media fragments.
        if (isHevc)
            videoArgs.push('-write_prft', 'wallclock');

        console.log(`motion recording starting`);
        session = await startFFMPegFragmentedMP4Session(inputArguments, audioArgs, videoArgs, console);
    }

    const start = Date.now();
    let recordingFile: Writable;
    const saveFragment = async (i: number, fragment: Buffer) => {
        if (!saveRecordings)
            return;

        try {
            const duration = Date.now() - start;
            const {
                clipId,
                savePath,
                metadataPath,
                mp4Path
            } = await getCameraRecordingFiles(device.id, start);
            await mkdirp(savePath);
            if (!recordingFile)
                recordingFile = fs.createWriteStream(mp4Path);
            recordingFile.write(fragment);
            const metadata: HksvVideoClip = {
                id: clipId,
                startTime: start,
                duration,
                fragments: i + 1,
            };
            await fs.promises.writeFile(metadataPath, Buffer.from(JSON.stringify(metadata)));
        }
        catch (e) {
            console.error('error saving hksv fragment', e);
        }
    };

    // this will cause the generator to close/throw.
    const cleanupPipes = () => {
        socket?.destroy();
        safeKillFFmpeg(cp);
    }

    let isLast = false;
    console.log(`motion recording started`);
    const { socket, cp, generator } = session;

    // HomeKit owns the length of a recording and normally closes the stream itself once motion
    // clears. Everything below is the backstop for when it does not, and each path says which it
    // was: a clip that ends on motion or on the ceiling is one HomeKit did not end on its own.
    const { motionGraceMs, maxDurationMs } = getRecordingLimits(storage);
    const graceSeconds = Math.round(motionGraceMs / 1000);
    let endReason: string;
    let motionResumes = 0;

    const endRecording = (reason: string) => {
        if (endReason)
            return;
        endReason = reason;
        // isLast only reaches HomeKit on the next fragment. If the source has stopped producing
        // them, nothing would carry it, so tear the pipes down regardless.
        isLast = true;
        setTimeout(cleanupPipes, 10000);
    };

    // Pending only while motion is clear, so it doubles as the "is the grace running" flag. A
    // sensor that re-sends the same value - which listening to an interface, rather than to
    // changes of it, does surface - must not restart the countdown, or a camera that repeats
    // `false` would hold the recording open until the ceiling and quietly defeat all of this.
    let graceTimeout: NodeJS.Timeout;
    const startGrace = (why: string) => {
        if (graceTimeout)
            return;
        // Narration, not an outcome: on a camera whose motion pulses this fires a couple of times
        // per recording and becomes the bulkiest thing in the log. What it is good for - how often
        // motion dropped and came back - is counted and reported when the recording finishes.
        if (debugMode.verbose)
            console.log(`${why}; this recording will end in ${graceSeconds}s unless motion resumes or HomeKit closes it first`);
        graceTimeout = setTimeout(() => {
            graceTimeout = undefined;
            console.warn(`motion has been clear for ${graceSeconds}s and HomeKit has not closed this recording; ending it`);
            endRecording(`motion clear for ${graceSeconds}s`);
        }, motionGraceMs);
    };

    const motionListener = device.listen(ScryptedInterface.MotionSensor, () => {
        if (endReason)
            return;

        if (!device.motionDetected) {
            startGrace('motion cleared');
            return;
        }

        if (!graceTimeout)
            return;

        // A camera that pulses motion rather than holding it lands here repeatedly during one
        // event. The count is reported at the end: a high one means this camera wants a grace
        // period longer than the gap between its pulses.
        clearTimeout(graceTimeout);
        graceTimeout = undefined;
        motionResumes++;
        if (debugMode.verbose)
            console.log('motion resumed before the grace period elapsed; this recording continues');
    });

    // the prebuffer means a recording can begin after the motion that triggered it has ended.
    if (!device.motionDetected)
        startGrace('motion was already clear when this recording started');

    const videoTimeout = setTimeout(() => {
        console.error(`homekit secure video max duration of ${Math.round(maxDurationMs / 1000)}s reached`
            + `${device.motionDetected ? ' while motion was still detected' : ''}; ending the recording`);
        endRecording('max duration');
    }, maxDurationMs);

    let pending: Buffer[] = [];
    let i = 0;
    let totalBytes = 0;
    try {
        // if ffmpeg is being used to parse a prebuffered stream that is NOT mp4 (despite our request),
        // it seems that ffmpeg may output a bad first fragment. it may be missing various codec informations or
        // it may start on a non keyframe. HAP requires every fragment start on a keyframe.

        // ffmpeg will also toss the first keyframe/segment when reading from rtsp (a live source).
        // seems it is due to needing to continue reading the input while readying decoders or muxers or something.
        // this may result in the prebuffer being lost.

        // lossy sources like rtp/udp may also exihibit missing keyframes with bad packet loss.

        // hap will also terminate the connection if too much prebuffer is sent too quickly.
        let checkMp4 = ffmpegInput.container !== 'mp4';
        let needSkip = true;
        let ftyp: Buffer[];
        let moov: Buffer[];

        for await (const box of generator) {
            if (!isOpen())
                return;
            
            const { header, type, data } = box;
            // console.log('motion fragment box', type);

            if (checkMp4 && !ftyp && type === 'ftyp')
                ftyp = [header, data];
            if (checkMp4 && !moov && type === 'moov')
                moov = [header, data];
            if (type === 'mdat' && checkMp4) {
                checkMp4 = false;
                // pending will contain the moof
                try {
                    if (false && !await checkMp4StartsWithKeyFrame(console, Buffer.concat([...ftyp, ...moov, ...pending, header, data]))) {
                        needSkip = false;
                        pending = [];
                        continue;
                    }
                }
                finally {
                    ftyp = undefined;
                    moov = undefined;
                }
            }

            // tvOS 27 requires zero prft flags for HSV3 recording; FFmpeg's 0x18 flags
            // cause fragment date extraction to fail and can crash homed.
            if (isHevc && type === 'prft' && data.length >= 4)
                data.writeUIntBE(0, 1, 3);

            // every moov/moof frame designates an iframe?
            pending.push(header, data);
            if (type === 'moov' || type === 'mdat') {
                if (type === 'mdat' && needSkip) {
                    pending = [];
                    needSkip = false;
                    continue;
                }
                if (!isOpen())
                    return;
                const fragment = Buffer.concat(pending);
                saveFragment(i, fragment);
                pending = [];
                ++i;
                totalBytes += fragment.length;
                // One line per fragment is one line every few seconds for as long as the recording
                // runs, which on a camera that records back to back is most of its log. What the
                // line is actually good for - how many fragments, how large - is summarised when
                // the recording finishes, so this is only worth having while chasing a specific
                // fragment.
                if (debugMode.verbose)
                    console.log(`motion fragment #${i} sent. size:`, fragment.length);
                const wasLast = isLast;
                const recordingPacket: RecordingPacket = {
                    data: fragment,
                    isLast,
                }
                yield recordingPacket;
                if (wasLast)
                    break;
            }
        }
    }
    catch (e) {
        console.log(`motion recording error ${e}`);
    }
    finally {
        // Which of the three ended it. HomeKit closing the stream itself is the expected path, so
        // anything else here is HomeKit not doing its job and is worth being able to count.
        console.log(`motion recording finished (${endReason || 'closed by HomeKit'}): `
            + `${i} fragments, ${(totalBytes / 1048576).toFixed(1)}MB, ${Math.round((Date.now() - start) / 1000)}s`
            + (motionResumes ? `, motion resumed ${motionResumes}x during it` : ''));

        if (!endReason) {
            consecutiveUnclosed.delete(device.id);
        }
        else {
            const run = (consecutiveUnclosed.get(device.id) || 0) + 1;
            consecutiveUnclosed.set(device.id, run);
            if (run >= UNCLOSED_WARN_AT) {
                console.warn(`HomeKit has not closed the last ${run} recordings from this camera, which usually means it is `
                    + 'no longer saving them - it analyses each clip and discards one with nothing in it worth keeping. '
                    + 'Everything spent producing them is wasted. Check what is triggering this camera\'s motion sensor: '
                    + 'something that moves continuously and is not a person, animal or vehicle - a ceiling fan, a blind, '
                    + 'sunlight across a room - will hold motion on and be rejected every time.');
            }
        }

        clearTimeout(videoTimeout);
        clearTimeout(graceTimeout);
        motionListener.removeListener();
        cleanupPipes();
        recordingFile?.end();
        recordingFile?.destroy();
        if (saveRecordings) {
            homekitPlugin.cameraMixins.get(device.id)?.onDeviceEvent(ScryptedInterface.VideoClips, undefined);
            deviceManager.onDeviceEvent(VIDEO_CLIPS_NATIVE_ID, ScryptedInterface.VideoClips, undefined);
        }
    }
}
