// One live streaming session against a camera's CameraRTPStreamManagement service.
//
// The negotiation is a two characteristic dance:
//   1. Write SetupEndpoints with our address, ports and SRTP keys, then read it back to learn the
//      accessory's address, ports, keys and SSRCs.
//   2. Write SelectedRTPStreamConfiguration with START_SESSION plus the exact codec parameters,
//      which must be drawn from what the accessory advertised or it will refuse.
//
// Media then arrives as SRTP on the two UDP sockets, with RTCP multiplexed onto the same ports.
// The accessory expects receiver reports back and tears the stream down without them.

import { RtcpPacketConverter } from '@koush/werift-src/packages/rtp/src/rtcp/rtcp';
import { RtcpReceiverInfo, RtcpRrPacket } from '@koush/werift-src/packages/rtp/src/rtcp/rr';
import { RtcpPayloadSpecificFeedback } from '@koush/werift-src/packages/rtp/src/rtcp/psfb';
import { FullIntraRequest } from '@koush/werift-src/packages/rtp/src/rtcp/psfb/fullIntraRequest';
import { PictureLossIndication } from '@koush/werift-src/packages/rtp/src/rtcp/psfb/pictureLossIndication';
import { RtcpSrPacket } from '@koush/werift-src/packages/rtp/src/rtcp/sr';
import { RtpPacket } from '@koush/werift-src/packages/rtp/src/rtp/rtp';
import { ProtectionProfileAes128CmHmacSha1_80 } from '@koush/werift-src/packages/rtp/src/srtp/const';
import type { Config } from '@koush/werift-src/packages/rtp/src/srtp/session';
import { SrtcpSession } from '@koush/werift-src/packages/rtp/src/srtp/srtcp';
import { SrtpSession } from '@koush/werift-src/packages/rtp/src/srtp/srtp';
import crypto from 'crypto';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import { HapClient, findCharacteristic } from '../hap/client';
import * as tlv from '../hap/tlv';
import {
    AddressTLV,
    AudioCodecParametersTLV,
    AudioRTPParametersTLV,
    HapService,
    IPAddressVersion,
    SelectedAudioParametersTLV,
    SelectedRTPStreamConfigurationTLV,
    SelectedVideoParametersTLV,
    SessionControlCommand,
    SessionControlTLV,
    SetupEndpointsStatus,
    SetupEndpointsTLV,
    SRTPCryptoSuite,
    SRTPParametersTLV,
    StreamingStatus,
    StreamingStatusTLV,
    VideoAttributesTLV,
    VideoCodecParametersTLV,
    VideoCodecType,
    VideoRTPParametersTLV,
} from '../hap/types';
import { Characteristic } from '../hap/uuids';
import type { H264Level, H264Profile } from '../hap/types';
import { ReceptionStats } from './reception-stats';
import { advertisedLevelFor, AudioCapability, bestProfile, nearestResolution, requiredLevel, samplerateToHz, VideoCapabilities, VideoResolution } from './stream-config';

// AES_CM_128_HMAC_SHA1_80 key and salt sizes.
/**
 * How much video is allowed to queue in the kernel between event loop turns.
 *
 * Sized for a keyframe burst rather than for the average rate: a 1200x1600 IDR is a few hundred
 * kilobytes arriving back to back, and the average bitrate says nothing about whether that fits.
 */
const VIDEO_RECV_BUFFER_BYTES = 4 * 1024 * 1024;

/** Audio is a steady trickle by comparison, and never bursts. */
const AUDIO_RECV_BUFFER_BYTES = 256 * 1024;

const SRTP_MASTER_KEY_BYTES = 16;
const SRTP_MASTER_SALT_BYTES = 14;

// Payload types we ask the accessory to use. Chosen in the dynamic range and kept fixed so the
// generated SDP can hardcode them.
export const VIDEO_PAYLOAD_TYPE = 99;
export const AUDIO_PAYLOAD_TYPE = 110;
// HomeKit's fixed comfort noise payload type. Sent even when comfort noise is disabled.
const COMFORT_NOISE_PAYLOAD_TYPE = 13;
// Packet time in milliseconds. HomeKit itself only ever uses 20, and the return audio encoder has
// to be told the same number, so it is shared rather than written twice.
export const AUDIO_PACKET_TIME_MS = 20;
// kbps. The ceiling declared to the accessory, and the rate return audio is encoded at, which have
// to be the same number: an accessory sizing its buffers from what we advertised does not expect
// more. 24 is what HomeKit itself uses in both directions.
export const AUDIO_MAX_BITRATE_KBPS = 24;

// How often to send receiver reports. Accessories treat a silent controller as gone; scrypted's
// own accessory implementation gives up after 30 seconds, so a one second cadence is ample.
const RTCP_INTERVAL_MS = 1000;

// for log messages; HAP's level enum is an ordinal, not the H.264 level number.
const LEVEL_NAMES: Record<number, string> = { 0: '3.1', 1: '3.2', 2: '4.0' };

export interface StreamSessionOptions {
    client: HapClient;
    aid: number;
    service: HapService;
    video: VideoCapabilities;
    resolution: VideoResolution;
    audio?: AudioCapability;
    // kbps; the accessory treats this as a ceiling for its encoder.
    maxBitrate?: number;
    // label of the configuration this camera accepted previously, tried first.
    preferredVariant?: string;
    // reports back the configuration the camera accepted, so the next session can start there.
    onNegotiated?: (label: string) => void;
    console?: Console;
}

/** One candidate stream configuration, offered to the accessory in order. */
export interface SelectionVariant {
    label: string;
    profile: H264Profile;
    level: H264Level;
    audio?: AudioCapability;
}

interface SrtpEndpoint {
    key: Buffer;
    salt: Buffer;
    cryptoSuite: SRTPCryptoSuite;
}

/**
 * Generates an SSRC in the positive signed 32 bit range.
 *
 * RTP allows the full unsigned range, but many camera firmwares packetize with ffmpeg, whose
 * `ssrc` option is a signed int and errors out above 2^31. HomeKit itself zeroes the high byte for
 * this reason, so a controller that wants to interoperate has to do the same.
 */
function generateSsrc(): number {
    const ssrc = crypto.randomBytes(4);
    ssrc[0] = 0;
    return ssrc.readUInt32BE(0);
}

function generateSrtpEndpoint(): SrtpEndpoint {
    return {
        key: crypto.randomBytes(SRTP_MASTER_KEY_BYTES),
        salt: crypto.randomBytes(SRTP_MASTER_SALT_BYTES),
        cryptoSuite: SRTPCryptoSuite.AES_CM_128_HMAC_SHA1_80,
    };
}

function encodeSrtpParameters(endpoint: SrtpEndpoint): Buffer {
    return tlv.encodeAll(
        SRTPParametersTLV.CRYPTO_SUITE, Buffer.from([endpoint.cryptoSuite]),
        SRTPParametersTLV.MASTER_KEY, endpoint.key,
        SRTPParametersTLV.MASTER_SALT, endpoint.salt,
    );
}

function decodeSrtpParameters(buffer: Buffer): SrtpEndpoint {
    const decoded = tlv.decode(buffer || Buffer.alloc(0));
    return {
        cryptoSuite: tlv.readUInt8(decoded[SRTPParametersTLV.CRYPTO_SUITE], SRTPCryptoSuite.AES_CM_128_HMAC_SHA1_80),
        key: decoded[SRTPParametersTLV.MASTER_KEY] || Buffer.alloc(0),
        salt: decoded[SRTPParametersTLV.MASTER_SALT] || Buffer.alloc(0),
    };
}

// A muxed socket carries both media and control. RTCP packet types occupy 64..95 in the field
// that RTP uses for its payload type, which is what makes the mux unambiguous.
function isRtcp(packet: Buffer): boolean {
    if (packet.length < 2)
        return false;
    const payloadType = packet.readUInt8(1) & 0x7f;
    return payloadType >= 64 && payloadType <= 95;
}

function ntpTimestamp(): bigint {
    const now = Date.now();
    const seconds = BigInt(Math.floor(now / 1000) + 2208988800);
    const fraction = BigInt(Math.floor((now % 1000) / 1000 * 0x100000000));
    return (seconds << 32n) | fraction;
}

export interface StreamSessionStats {
    videoPackets: number;
    audioPackets: number;
    videoBytes: number;
    audioBytes: number;
}

/**
 * Emits 'video' and 'audio' with decrypted RTP packets, and 'error' if the accessory tears the
 * session down.
 */
export class HapStreamSession extends EventEmitter {
    readonly sessionId = crypto.randomBytes(16);

    private videoSocket: dgram.Socket;
    private audioSocket: dgram.Socket;

    // keys we generate: the accessory encrypts to us with these.
    private videoIn = generateSrtpEndpoint();
    private audioIn = generateSrtpEndpoint();
    // keys the accessory returns: we encrypt return audio and RTCP to it with these.
    private videoOut: SrtpEndpoint;
    private audioOut: SrtpEndpoint;

    private videoSrtp: SrtpSession;
    private audioSrtp: SrtpSession;
    private videoSrtcp: SrtcpSession;
    private audioSrtcp: SrtcpSession;
    private audioSender: SrtpSession;

    private accessoryAddress: string;
    private accessoryVideoPort: number;
    private accessoryAudioPort: number;
    private accessorySessionId: Buffer;
    private selectedVariant: SelectionVariant;
    accessoryVideoSsrc: number;
    accessoryAudioSsrc: number;

    // What actually arrived, which is what a receiver report is for. Video is always the 90kHz
    // clock; audio runs at whatever sample rate was negotiated.
    private videoReception = new ReceptionStats(90000);
    private audioReception: ReceptionStats;
    // return audio, counted so a silent talkback can be told from one that never sent anything.
    private returnAudioPackets = 0;
    private returnAudioBytes = 0;
    // one warning per session is enough to explain freezing video.
    private reportedLoss = false;

    // What the session is currently asking the camera for, which starts at what was negotiated and
    // moves when a consumer asks for something else.
    private activeResolution: VideoResolution;
    private activeMaxBitrate: number;
    private reconfiguring: Promise<void>;

    // our own SSRCs, sent in the selected configuration.
    readonly videoSsrc = generateSsrc();
    readonly audioSsrc = generateSsrc();

    private rtcpTimer: NodeJS.Timeout;
    private started = false;
    private stopped = false;

    // receiver report state
    private videoHighestSequence = 0;
    private audioHighestSequence = 0;
    private lastVideoSrTimestamp = 0;
    private lastVideoSrReceived = 0;
    private lastAudioSrTimestamp = 0;
    private lastAudioSrReceived = 0;

    readonly stats: StreamSessionStats = { videoPackets: 0, audioPackets: 0, videoBytes: 0, audioBytes: 0 };

    private firSequence = 0;
    private returnAudioFailed = false;
    private returnAudioBase: number;

    constructor(public options: StreamSessionOptions) {
        super();
        this.setMaxListeners(0);
    }

    private get console() {
        return this.options.console;
    }

    get audioEnabled() {
        return !!(this.selectedVariant ? this.selectedVariant.audio : this.options.audio);
    }

    /** The iid of a characteristic on the stream management service this session drives. */
    private iid(type: string): number {
        const characteristic = findCharacteristic(this.options.service, type);
        if (!characteristic)
            throw new Error(`camera stream management service is missing characteristic ${type}`);
        return characteristic.iid;
    }

    // Availability is checked by the camera device before a session is built, since it has to
    // choose between the accessory's stream management services. See isServiceAvailable there.

    async start(): Promise<void> {
        if (this.started)
            throw new Error('stream session already started');
        this.started = true;

        const { client, aid } = this.options;

        await client.ensureConnected();
        const localAddress = client.localAddress;
        if (!localAddress)
            throw new Error('could not determine the local address the accessory sees us at');

        await this.bindSockets();
        await this.setupEndpoints(localAddress);
        await this.startSession();

        this.startRtcp();
    }

    private async bindSockets() {
        const bind = (socket: dgram.Socket) => new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(0, () => {
                socket.removeListener('error', reject);
                resolve();
            });
        });

        this.videoSocket = dgram.createSocket('udp4');
        this.audioSocket = dgram.createSocket('udp4');
        await bind(this.videoSocket);
        await bind(this.audioSocket);

        // A keyframe arrives as a burst of a hundred packets or more, at whatever rate the camera
        // can push them, and node reads the socket only when the event loop comes round. Anything
        // that does not fit in the kernel's buffer in between is dropped there - which looks
        // exactly like network loss, and is by far the more likely of the two on a local link.
        //
        // The request is not a guarantee: Linux silently clamps it to net.core.rmem_max, which
        // commonly leaves a 1MB ask holding 208KB. Reading it back is the only way to know.
        this.videoSocket.setRecvBufferSize(VIDEO_RECV_BUFFER_BYTES);
        this.audioSocket.setRecvBufferSize(AUDIO_RECV_BUFFER_BYTES);

        const granted = this.videoSocket.getRecvBufferSize();
        this.console?.debug(`socket receive buffers: video ${Math.round(granted / 1024)}KB`
            + ` of ${Math.round(VIDEO_RECV_BUFFER_BYTES / 1024)}KB requested,`
            + ` audio ${Math.round(this.audioSocket.getRecvBufferSize() / 1024)}KB`);

        if (granted < VIDEO_RECV_BUFFER_BYTES / 2) {
            this.console?.warn(`the operating system capped this stream's receive buffer at ${Math.round(granted / 1024)}KB`
                + ` of the ${Math.round(VIDEO_RECV_BUFFER_BYTES / 1024)}KB asked for, which a keyframe burst from a high`
                + ' resolution camera can overrun - dropped there, it is indistinguishable from network loss.'
                + ' Raise it with: sysctl -w net.core.rmem_max=8388608 (and add it to /etc/sysctl.conf to persist).');
        }

        this.videoSocket.on('error', e => this.fail(e));
        this.audioSocket.on('error', e => this.fail(e));
    }

    private async setupEndpoints(localAddress: string) {
        const { client, aid } = this.options;
        const setupEndpointsIid = this.iid(Characteristic.SetupEndpoints);

        const addressTlv = tlv.encodeAll(
            AddressTLV.ADDRESS_VERSION, Buffer.from([IPAddressVersion.IPV4]),
            AddressTLV.ADDRESS, Buffer.from(localAddress, 'utf8'),
            AddressTLV.VIDEO_RTP_PORT, tlv.writeUInt16LE(this.videoSocket.address().port),
            AddressTLV.AUDIO_RTP_PORT, tlv.writeUInt16LE(this.audioSocket.address().port),
        );

        const request = tlv.encodeAll(
            SetupEndpointsTLV.SESSION_ID, this.sessionId,
            SetupEndpointsTLV.ADDRESS, addressTlv,
            SetupEndpointsTLV.VIDEO_SRTP_PARAMETERS, encodeSrtpParameters(this.videoIn),
            SetupEndpointsTLV.AUDIO_SRTP_PARAMETERS, encodeSrtpParameters(this.audioIn),
        );

        await client.writeTlvCharacteristic(aid, setupEndpointsIid, request);

        // the accessory's answer is read back from the same characteristic.
        const responseValue = await client.readTlvCharacteristic(aid, setupEndpointsIid);
        const response = tlv.decode(responseValue);

        const status = tlv.readUInt8(response[SetupEndpointsTLV.STATUS], SetupEndpointsStatus.ERROR);
        if (status !== SetupEndpointsStatus.SUCCESS) {
            throw new Error(status === SetupEndpointsStatus.BUSY
                ? 'the camera has no free streaming sessions; another client is likely already watching'
                : 'the camera rejected the streaming endpoint setup');
        }

        const address = tlv.decode(response[SetupEndpointsTLV.ADDRESS] || Buffer.alloc(0));
        this.accessoryAddress = address[AddressTLV.ADDRESS]?.toString('utf8');
        this.accessoryVideoPort = tlv.readUIntLE(address[AddressTLV.VIDEO_RTP_PORT], 0);
        this.accessoryAudioPort = tlv.readUIntLE(address[AddressTLV.AUDIO_RTP_PORT], 0);

        this.videoOut = decodeSrtpParameters(response[SetupEndpointsTLV.VIDEO_SRTP_PARAMETERS]);
        this.audioOut = decodeSrtpParameters(response[SetupEndpointsTLV.AUDIO_SRTP_PARAMETERS]);

        // keep the accessory's own copy of the session id; it is the one it will match against.
        this.accessorySessionId = response[SetupEndpointsTLV.SESSION_ID]?.length === 16
            ? response[SetupEndpointsTLV.SESSION_ID]
            : undefined;

        this.accessoryVideoSsrc = tlv.readUIntLE(response[SetupEndpointsTLV.VIDEO_SSRC], 0);
        this.accessoryAudioSsrc = tlv.readUIntLE(response[SetupEndpointsTLV.AUDIO_SSRC], 0);

        if (!this.accessoryAddress)
            throw new Error('the camera did not return an RTP address');

        const describeEndpoint = (name: string, endpoint: SrtpEndpoint) =>
            `${name} ${SRTPCryptoSuite[endpoint.cryptoSuite] ?? endpoint.cryptoSuite}`
            + ` key:${endpoint.key.length}b salt:${endpoint.salt.length}b`;

        this.console?.debug(`HAP stream endpoints ready: camera ${this.accessoryAddress}`
            + ` video:${this.accessoryVideoPort} audio:${this.accessoryAudioPort};`
            + ` ${describeEndpoint('inbound video', this.videoIn)}, ${describeEndpoint('inbound audio', this.audioIn)},`
            + ` ${describeEndpoint('outbound video', this.videoOut)}, ${describeEndpoint('outbound audio', this.audioOut)}`);

        // Only one profile is implemented, and every HAP camera is required to support it, so a
        // camera that answers with a different one would be decrypted into noise with no error -
        // SRTP counter mode produces plausible looking bytes from the wrong key rather than
        // failing. Worth saying out loud rather than leaving as a silent wrong answer.
        for (const [name, endpoint] of [['video', this.videoOut], ['audio', this.audioOut]] as const) {
            if (endpoint.key.length && endpoint.cryptoSuite !== SRTPCryptoSuite.AES_CM_128_HMAC_SHA1_80) {
                this.console?.warn(`the camera selected ${SRTPCryptoSuite[endpoint.cryptoSuite] ?? endpoint.cryptoSuite}`
                    + ` for ${name}, but only AES_CM_128_HMAC_SHA1_80 is implemented; media will not decode`);
            }
        }

        this.startSrtp();
    }

    private startSrtp() {
        // SRTP keys each direction separately, and SetupEndpoints carries one for each.
        //
        // The key this controller sent is the one it encrypts with, so the accessory can decrypt
        // return audio. The key the accessory returned is the one *it* encrypts with, so this is
        // what incoming video and audio have to be decrypted with. Getting that the wrong way
        // round is invisible against most implementations, because hap-nodejs and everything built
        // on it - including Scrypted's own HomeKit plugin - simply echo the controller's key back,
        // making the two identical. A camera that generates its own, as the specification intends,
        // then decrypts into noise: counter mode produces plausible looking bytes from a wrong key
        // rather than failing, so the stream negotiates perfectly and carries nothing decodable.
        //
        // The fallback to our own key covers the echoing implementations, and an accessory that
        // returns nothing at all.
        const keysFor = (ours: SrtpEndpoint, theirs: SrtpEndpoint) => ({
            profile: ProtectionProfileAes128CmHmacSha1_80,
            keys: {
                // what this controller encrypts with.
                localMasterKey: ours.key,
                localMasterSalt: ours.salt,
                // what the accessory encrypts with, and so what its media decrypts with.
                remoteMasterKey: theirs.key.length ? theirs.key : ours.key,
                remoteMasterSalt: theirs.salt.length ? theirs.salt : ours.salt,
            },
        });

        const inboundVideo: Config = keysFor(this.videoIn, this.videoOut);
        const inboundAudio: Config = keysFor(this.audioIn, this.audioOut);

        this.videoSrtp = new SrtpSession(inboundVideo);
        this.audioSrtp = new SrtpSession(inboundAudio);
        this.videoSrtcp = new SrtcpSession(inboundVideo);
        this.audioSrtcp = new SrtcpSession(inboundAudio);
        // return audio is encrypted with the accessory's key, in the local direction.
        this.audioSender = new SrtpSession(inboundAudio);

        this.videoSocket.on('message', message => this.onVideoMessage(message));
        this.audioSocket.on('message', message => this.onAudioMessage(message));
    }

    private onVideoMessage(message: Buffer) {
        try {
            if (isRtcp(message)) {
                this.onSenderReport(this.videoSrtcp.decrypt(message), 'video');
                return;
            }
            const decrypted = this.videoSrtp.decrypt(message);
            this.stats.videoPackets++;
            this.stats.videoBytes += decrypted.length;
            this.videoHighestSequence = decrypted.readUInt16BE(2);
            this.videoReception.receive(decrypted.readUInt16BE(2), decrypted.readUInt32BE(4));
            this.emit('video', decrypted);
        }
        catch (e) {
            // a single undecryptable packet is not fatal; log sparsely and keep going.
            if (this.stats.videoPackets % 500 === 0)
                this.console?.warn('failed to decrypt a video packet', (e as Error).message);
        }
    }

    private onAudioMessage(message: Buffer) {
        try {
            if (isRtcp(message)) {
                this.onSenderReport(this.audioSrtcp.decrypt(message), 'audio');
                return;
            }
            const decrypted = this.audioSrtp.decrypt(message);
            this.stats.audioPackets++;
            this.stats.audioBytes += decrypted.length;
            this.audioHighestSequence = decrypted.readUInt16BE(2);
            this.audioReception ||= new ReceptionStats(this.audioSampleRate);
            this.audioReception.receive(decrypted.readUInt16BE(2), decrypted.readUInt32BE(4));
            this.emit('audio', decrypted);
        }
        catch (e) {
            if (this.stats.audioPackets % 500 === 0)
                this.console?.warn('failed to decrypt an audio packet', (e as Error).message);
        }
    }

    // Sender reports carry the timing a receiver report has to echo back.
    private onSenderReport(decrypted: Buffer, kind: 'video' | 'audio') {
        try {
            const packets = RtcpPacketConverter.deSerialize(decrypted);
            for (const packet of packets) {
                if (!(packet instanceof RtcpSrPacket))
                    continue;
                // the middle 32 bits of the NTP timestamp are what goes in the LSR field.
                const ntp = packet.senderInfo.ntpTimestamp;
                const middle = Number((BigInt(ntp) >> 16n) & 0xffffffffn);
                if (kind === 'video') {
                    this.lastVideoSrTimestamp = middle;
                    this.lastVideoSrReceived = Date.now();
                }
                else {
                    this.lastAudioSrTimestamp = middle;
                    this.lastAudioSrReceived = Date.now();
                }
            }
        }
        catch (e) {
        }
    }

    /**
     * Configurations to offer the accessory, best first.
     *
     * Cameras vary in what they will accept here, and a rejection is an opaque "invalid value"
     * with no indication of which field was at fault. Rather than insist on one encoding, offer a
     * short ladder: the richest configuration first, then the conservative codec settings, then
     * the same two without audio. The first that is accepted is remembered, so the ladder is
     * walked once rather than on every stream.
     */
    private buildVariants(): SelectionVariant[] {
        const { video, audio, resolution } = this.options;

        // Everything here is taken from what this stream service advertised. The resolution was
        // already settled by the camera device, which picks a service that offers it and snaps the
        // request onto that service's own list, so the first configuration is simply the camera's
        // own data. The fallbacks exist only for firmware that refuses part of what it advertised,
        // and each says plainly what it is giving up.
        const level = advertisedLevelFor(video, resolution);
        const profile = bestProfile(video);
        const baseline = Math.min(...video.profiles) as H264Profile;

        const label = (lvl: H264Level, suffix: string) =>
            `${resolution.width}x${resolution.height} level ${LEVEL_NAMES[lvl] || lvl} ${suffix}`;

        const variants: SelectionVariant[] = [
            { label: label(level, audio ? 'with audio' : 'without audio'), profile, level, audio },
        ];

        // some cameras advertise an audio codec they will not actually stream.
        if (audio)
            variants.push({ label: label(level, 'without audio'), profile, level, audio: undefined });

        // and some advertise a profile their encoder does not really produce.
        if (baseline !== profile)
            variants.push({ label: label(level, 'baseline profile'), profile: baseline, level, audio });

        // Last, the corrective reading for a camera whose resolution and level lists contradict
        // each other: ask for the level the frame genuinely requires, even though it was never
        // offered. Deliberately last, because the camera's own data deserves the first attempt.
        const required = requiredLevel(resolution);
        if (required !== level) {
            variants.push({
                label: label(required, '(unadvertised, required by the frame size) with audio'),
                profile, level: required, audio,
            });
        }

        return variants;
    }

    private async startSession() {
        const variants = this.buildVariants();
        // start from whatever worked last time for this camera.
        const preferred = this.options.preferredVariant;
        const ordered = preferred
            ? [...variants.filter(v => v.label === preferred), ...variants.filter(v => v.label !== preferred)]
            : variants;

        let lastError: Error;
        for (const variant of ordered) {
            const payload = this.buildSelectedConfiguration(SessionControlCommand.START_SESSION, variant);
            try {
                await this.options.client.writeTlvCharacteristic(
                    this.options.aid, this.iid(Characteristic.SelectedRTPStreamConfiguration), payload);

                this.selectedVariant = variant;
                this.options.onNegotiated?.(variant.label);

                if (variant.label === variants[0].label)
                    this.console?.debug(`stream configuration accepted: ${variant.label}`);
                else
                    this.console?.warn(`the camera rejected the preferred stream configuration; running as "${variant.label}" instead`);
                return;
            }
            catch (e) {
                lastError = e as Error;
                this.console?.warn(`stream configuration "${variant.label}" rejected: ${lastError.message}`);
                // the exact bytes are what a comparison against a working controller needs.
                this.console?.warn(`  rejected SelectedRTPStreamConfiguration: ${payload.toString('hex')}`);

                // A camera that has dropped the connection will not answer anything else, and
                // continuing to push writes at one that is refusing them is how it gets pushed into
                // dropping in the first place. Stop, and let the caller retry on a fresh session.
                if (!this.options.client.connected)
                    break;

                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }

        throw new Error(`the camera rejected every stream configuration offered. Last error: ${lastError?.message}`);
    }

    private async selectStreamConfiguration(command: SessionControlCommand) {
        await this.options.client.writeTlvCharacteristic(
            this.options.aid,
            this.iid(Characteristic.SelectedRTPStreamConfiguration),
            this.buildSelectedConfiguration(command, this.selectedVariant));
    }

    /**
     * Whether the camera ever accepted a configuration for this session.
     *
     * A session that was refused at setup stops the same way a working one does - with no packets -
     * so anything reasoning about silence has to tell the two apart. Blaming a firewall for a
     * stream the camera declined outright sends the reader somewhere there is nothing to find.
     */
    get negotiated(): boolean {
        return !!this.selectedVariant;
    }

    /** What this session is currently asking the camera to send. */
    get currentResolution(): VideoResolution {
        return this.activeResolution ?? this.options.resolution;
    }

    get currentMaxBitrate(): number {
        return this.activeMaxBitrate ?? this.options.maxBitrate ?? 2000;
    }

    /**
     * Asks the camera to change what it is sending, without restarting the session.
     *
     * This is what HomeKit is asking for when it requests a reconfiguration: a phone that has moved
     * onto cellular wants a smaller, cheaper stream. Answering it is the difference between the
     * camera encoding what was asked for and the camera continuing to push its full bitrate at a
     * link that cannot carry it - which arrives as packet loss rather than as a smaller picture.
     *
     * The size has to be one the camera advertised; anything else is rejected as an invalid value.
     */
    async reconfigure(request: { bitrate?: number, width?: number, height?: number }): Promise<void> {
        if (this.stopped || !this.started)
            return;

        const resolution = request.width || request.height
            ? nearestResolution(this.options.video, request.width, request.height)
            : this.currentResolution;
        // HAP carries the ceiling in kbps; a consumer asks in bits per second when it is large.
        const bitrate = request.bitrate
            ? Math.max(64, Math.round(request.bitrate > 100000 ? request.bitrate / 1000 : request.bitrate))
            : this.currentMaxBitrate;

        if (resolution.width === this.currentResolution.width
            && resolution.height === this.currentResolution.height
            && bitrate === this.currentMaxBitrate) {
            return;
        }

        // One at a time. A consumer reacting to its own congestion can ask repeatedly, and two
        // overlapping writes to SelectedRTPStreamConfiguration is how a camera ends up in a state
        // neither side agrees on.
        if (this.reconfiguring)
            return this.reconfiguring;

        const previousResolution = this.currentResolution;
        const previousBitrate = this.currentMaxBitrate;
        this.activeResolution = resolution;
        this.activeMaxBitrate = bitrate;

        this.reconfiguring = this.selectStreamConfiguration(SessionControlCommand.RECONFIGURE_SESSION)
            .then(() => {
                this.console?.log(`stream reconfigured to ${resolution.width}x${resolution.height} at ${bitrate}kbps`);
            })
            .catch(e => {
                // the camera kept what it had, so this session's idea of it has to as well.
                this.activeResolution = previousResolution;
                this.activeMaxBitrate = previousBitrate;
                this.console?.warn('the camera refused to reconfigure the stream', (e as Error).message);
            })
            .finally(() => this.reconfiguring = undefined);

        return this.reconfiguring;
    }

    private buildSelectedConfiguration(command: SessionControlCommand, variant?: SelectionVariant): Buffer {
        const { video } = this.options;
        const resolution = this.currentResolution;
        const maxBitrate = this.currentMaxBitrate;
        const audio = variant?.audio;

        const sessionControl = tlv.encodeAll(
            // Prefer the identifier the accessory echoed back. It is normally the one we sent, but
            // honouring the accessory's copy avoids a mismatch on firmware that rewrites it, and a
            // mismatch here is rejected as an invalid value with no further explanation.
            SessionControlTLV.SESSION_IDENTIFIER, this.accessorySessionId || this.sessionId,
            SessionControlTLV.COMMAND, Buffer.from([command]),
        );

        const parts: Buffer[] = [
            tlv.encode(SelectedRTPStreamConfigurationTLV.SESSION_CONTROL, sessionControl),
        ];

        if (command === SessionControlCommand.START_SESSION || command === SessionControlCommand.RECONFIGURE_SESSION) {
            const codecParameters = tlv.encodeAll(
                VideoCodecParametersTLV.PROFILE_ID, Buffer.from([variant?.profile ?? bestProfile(video)]),
                VideoCodecParametersTLV.LEVEL, Buffer.from([variant?.level ?? advertisedLevelFor(video, resolution)]),
                VideoCodecParametersTLV.PACKETIZATION_MODE, Buffer.from([video.packetizationModes[0] ?? 0]),
            );

            const attributes = tlv.encodeAll(
                VideoAttributesTLV.IMAGE_WIDTH, tlv.writeUInt16LE(resolution.width),
                VideoAttributesTLV.IMAGE_HEIGHT, tlv.writeUInt16LE(resolution.height),
                VideoAttributesTLV.FRAME_RATE, Buffer.from([resolution.fps]),
            );

            const videoRtpParameters = tlv.encodeAll(
                VideoRTPParametersTLV.PAYLOAD_TYPE, Buffer.from([VIDEO_PAYLOAD_TYPE]),
                VideoRTPParametersTLV.SYNCHRONIZATION_SOURCE, tlv.writeUInt32LE(this.videoSsrc),
                VideoRTPParametersTLV.MAX_BIT_RATE, tlv.writeUInt16LE(maxBitrate || 2000),
                // minimum seconds between the accessory's sender reports.
                VideoRTPParametersTLV.MIN_RTCP_INTERVAL, Buffer.from(new Float32Array([0.5]).buffer),
            );

            parts.push(tlv.encode(SelectedRTPStreamConfigurationTLV.SELECTED_VIDEO_PARAMETERS, tlv.encodeAll(
                SelectedVideoParametersTLV.CODEC_TYPE, Buffer.from([VideoCodecType.H264]),
                SelectedVideoParametersTLV.CODEC_PARAMETERS, codecParameters,
                SelectedVideoParametersTLV.ATTRIBUTES, attributes,
                SelectedVideoParametersTLV.RTP_PARAMETERS, videoRtpParameters,
            )));

            if (audio) {
                const audioCodecParameters = tlv.encodeAll(
                    AudioCodecParametersTLV.CHANNEL, Buffer.from([audio.channels]),
                    AudioCodecParametersTLV.BIT_RATE, Buffer.from([audio.bitrateMode]),
                    AudioCodecParametersTLV.SAMPLE_RATE, Buffer.from([audio.samplerate]),
                    AudioCodecParametersTLV.PACKET_TIME, Buffer.from([AUDIO_PACKET_TIME_MS]),
                );

                const audioRtpParameters = tlv.encodeAll(
                    AudioRTPParametersTLV.PAYLOAD_TYPE, Buffer.from([AUDIO_PAYLOAD_TYPE]),
                    AudioRTPParametersTLV.SYNCHRONIZATION_SOURCE, tlv.writeUInt32LE(this.audioSsrc),
                    AudioRTPParametersTLV.MAX_BIT_RATE, tlv.writeUInt16LE(AUDIO_MAX_BITRATE_KBPS),
                    AudioRTPParametersTLV.MIN_RTCP_INTERVAL, Buffer.from(new Float32Array([0.5]).buffer),
                    // Accessories read the comfort noise payload type unconditionally, so it has to
                    // be present even though comfort noise itself is switched off below. HomeKit
                    // always sends 13 here.
                    AudioRTPParametersTLV.COMFORT_NOISE_PAYLOAD_TYPE, Buffer.from([COMFORT_NOISE_PAYLOAD_TYPE]),
                );

                parts.push(tlv.encode(SelectedRTPStreamConfigurationTLV.SELECTED_AUDIO_PARAMETERS, tlv.encodeAll(
                    SelectedAudioParametersTLV.CODEC_TYPE, Buffer.from([audio.codec]),
                    SelectedAudioParametersTLV.CODEC_PARAMETERS, audioCodecParameters,
                    SelectedAudioParametersTLV.RTP_PARAMETERS, audioRtpParameters,
                    SelectedAudioParametersTLV.COMFORT_NOISE, Buffer.from([0]),
                )));
            }
        }

        return Buffer.concat(parts);
    }

    private startRtcp() {
        const send = () => {
            if (this.stopped)
                return;
            this.sendReceiverReport('video');
            if (this.audioEnabled)
                this.sendReceiverReport('audio');
        };
        this.rtcpTimer = setInterval(send, RTCP_INTERVAL_MS);
        // send one immediately so the accessory sees us before its own first timeout.
        send();
    }

    /**
     * Builds the receiver report for one of the two streams.
     *
     * Separate from sending it because RFC 3550 requires every compound RTCP packet to begin with
     * a report, so the keyframe request has to carry one too.
     */
    private buildReceiverReport(kind: 'video' | 'audio'): RtcpRrPacket {
        const isVideo = kind === 'video';
        const remoteSsrc = isVideo ? this.accessoryVideoSsrc : this.accessoryAudioSsrc;
        const lastSr = isVideo ? this.lastVideoSrTimestamp : this.lastAudioSrTimestamp;
        const lastSrReceived = isVideo ? this.lastVideoSrReceived : this.lastAudioSrReceived;

        // delay since last sender report, in units of 1/65536 seconds.
        const dlsr = lastSrReceived ? Math.floor((Date.now() - lastSrReceived) / 1000 * 65536) : 0;

        const reception = isVideo ? this.videoReception : this.audioReception;
        const report = reception?.report() ?? {
            highestSequence: isVideo ? this.videoHighestSequence : this.audioHighestSequence,
            fractionLost: 0,
            packetsLost: 0,
            jitter: 0,
        };

        // A camera encoding to a bitrate ceiling uses this to decide whether to back off. Reporting
        // zero loss regardless, which is what an unfilled report does, leaves it no reason to - so
        // congestion that would have been absorbed in a second or two instead drops fragments for
        // the life of the stream.
        if (isVideo && report.fractionLost > 8 && !this.reportedLoss) {
            this.reportedLoss = true;
            this.console?.warn(`losing ${Math.round(report.fractionLost * 100 / 256)}% of this camera's video packets;`
                + ' video will freeze in bursts. The camera is being told, and may reduce its bitrate in response.'
                + ' A sustained loss usually means the network between here and the camera, not the camera itself.');
        }

        return new RtcpRrPacket({
            ssrc: isVideo ? this.videoSsrc : this.audioSsrc,
            reports: [
                new RtcpReceiverInfo({
                    ssrc: remoteSsrc,
                    fractionLost: report.fractionLost,
                    packetsLost: report.packetsLost,
                    highestSequence: report.highestSequence,
                    jitter: report.jitter,
                    lsr: lastSr,
                    dlsr,
                }),
            ],
        });
    }

    private sendReceiverReport(kind: 'video' | 'audio') {
        try {
            const isVideo = kind === 'video';
            const socket = isVideo ? this.videoSocket : this.audioSocket;
            const port = isVideo ? this.accessoryVideoPort : this.accessoryAudioPort;
            const srtcp = isVideo ? this.videoSrtcp : this.audioSrtcp;

            if (!port || !socket)
                return;

            socket.send(srtcp.encrypt(this.buildReceiverReport(kind).serialize()), port, this.accessoryAddress);
        }
        catch (e) {
            this.console?.warn(`failed to send a ${kind} receiver report`, (e as Error).message);
        }
    }

    /**
     * Asks the camera to emit a keyframe now.
     *
     * A decoder can draw nothing until a keyframe arrives, so a viewer joining between them waits
     * out the camera's whole keyframe interval - which on some cameras is many seconds, far longer
     * than any buffer downstream. Both standard requests are sent together: a Picture Loss
     * Indication, and a Full Intra Request, since cameras differ in which they honour and an
     * unrecognised one is simply ignored.
     */
    requestKeyframe(): void {
        if (this.stopped || !this.videoSrtcp || !this.accessoryVideoPort)
            return;

        try {
            const pli = new RtcpPayloadSpecificFeedback({
                feedback: new PictureLossIndication({
                    senderSsrc: this.videoSsrc,
                    mediaSsrc: this.accessoryVideoSsrc,
                }),
            });

            const fir = new RtcpPayloadSpecificFeedback({
                feedback: new FullIntraRequest({
                    senderSsrc: this.videoSsrc,
                    mediaSsrc: this.accessoryVideoSsrc,
                    // the sequence number must advance or a camera may treat it as a repeat.
                    fir: [{ ssrc: this.accessoryVideoSsrc, sequenceNumber: this.firSequence++ & 0xff }],
                }),
            });

            // RFC 3550 section 6.1, and RFC 4585 section 3.1 again for the feedback packets: a
            // compound RTCP packet must begin with a sender or receiver report. Sending feedback
            // on its own is a compound packet that starts with neither. Most stacks accept it
            // anyway, which is exactly why getting it wrong survives testing against one camera -
            // a stricter parser is entitled to discard the whole datagram, and embedded firmware
            // that does not expect it may do worse.
            const packet = Buffer.concat([
                this.buildReceiverReport('video').serialize(),
                pli.serialize(),
                fir.serialize(),
            ]);
            this.videoSocket.send(this.videoSrtcp.encrypt(packet), this.accessoryVideoPort, this.accessoryAddress);
        }
        catch (e) {
            this.console?.warn('failed to request a keyframe', (e as Error).message);
        }
    }

    /**
     * What this session has sent the camera's speaker, and where.
     *
     * Talkback fails silently in both directions: nothing reports back whether the accessory played
     * anything, and until this was counted there was no way to tell a controller that sent nothing
     * from a camera that ignored what it was sent.
     */
    get returnAudioStats(): { packets: number, bytes: number, target: string } {
        return {
            packets: this.returnAudioPackets,
            bytes: this.returnAudioBytes,
            target: `${this.accessoryAddress}:${this.accessoryAudioPort}`,
        };
    }

    /** The sample rate the accessory accepted for this session, in Hz. */
    get audioSampleRate(): number {
        return samplerateToHz(this.selectedVariant?.audio?.samplerate ?? this.options.audio?.samplerate);
    }

    /**
     * Sends one packet of return audio to the camera's speaker.
     *
     * The input is a whole RTP packet as the encoder produced it, and `sourceClockHz` is the clock
     * that encoder stamped it with. Only the fields that identify the stream to the accessory are
     * replaced; the timestamp is rescaled rather than recounted, so a gap in the encoder's output
     * stays a gap.
     *
     * The rescale is the point. HAP takes RFC 7587 for Opus but explicitly excepts its timestamp
     * rule, requiring RFC 3550 pacing instead: the clock is the sample rate that was negotiated,
     * not Opus's mandatory 48kHz. ffmpeg follows RFC 7587 and stamps 48kHz whatever `-ar` says, so
     * passing its timestamps through unaltered tells a 16kHz accessory that audio is arriving three
     * times faster than it is, and its jitter buffer turns the difference into static.
     */
    sendReturnAudio(rtp: Buffer, sourceClockHz: number) {
        if (this.stopped || !this.audioSender || !this.accessoryAudioPort)
            return;

        try {
            // a real RtpPacket, not an object shaped like one: the SRTP encrypter serializes the
            // header itself, so a plain literal is silently useless until that call is made. This
            // also strips any CSRC list or extension, which a fixed 12 byte offset does not.
            const packet = RtpPacket.deSerialize(rtp);
            packet.header.payloadType = AUDIO_PAYLOAD_TYPE;
            packet.header.ssrc = this.audioSsrc;

            const hapClockHz = this.audioSampleRate;
            if (sourceClockHz !== hapClockHz) {
                if (this.returnAudioBase === undefined)
                    this.returnAudioBase = packet.header.timestamp;
                // unsigned subtraction, so an encoder whose timestamp wraps mid sentence is fine.
                const elapsed = (packet.header.timestamp - this.returnAudioBase) >>> 0;
                packet.header.timestamp = Math.round(elapsed * hapClockHz / sourceClockHz) % 0x100000000;
            }

            const encrypted = this.audioSender.encrypt(packet.payload, packet.header);
            this.returnAudioPackets++;
            this.returnAudioBytes += encrypted.length;
            this.audioSocket.send(encrypted, this.accessoryAudioPort, this.accessoryAddress);
        }
        catch (e) {
            // one warning is enough; a broken return audio path fails on every packet.
            if (!this.returnAudioFailed) {
                this.returnAudioFailed = true;
                this.console?.warn('failed to send return audio', (e as Error).message);
            }
        }
    }

    private fail(error: Error) {
        if (this.stopped)
            return;
        this.console?.error('HAP stream session failed', error);
        this.emit('error', error);
        this.stop().catch(() => { });
    }

    async stop(): Promise<void> {
        if (this.stopped)
            return;
        this.stopped = true;

        clearInterval(this.rtcpTimer);
        this.rtcpTimer = undefined;

        // tell the accessory to stop sending before dropping the sockets, so it frees the slot.
        if (this.started) {
            try {
                await this.selectStreamConfiguration(SessionControlCommand.END_SESSION);
            }
            catch (e) {
                // An accessory that has already torn the session down answers "not allowed in the
                // current state", which is agreement rather than a failure. Anything else is worth
                // seeing, because a session the accessory still believes is open holds a slot.
                const message = (e as Error).message;
                if (message?.includes('not allowed in the current state'))
                    this.console?.debug('the accessory had already ended the stream session');
                else
                    this.console?.warn('failed to cleanly end the HAP stream session', message);
            }
        }

        for (const socket of [this.videoSocket, this.audioSocket]) {
            try {
                socket?.close();
            }
            catch (e) {
            }
        }
        this.videoSocket = undefined;
        this.audioSocket = undefined;

        this.emit('stopped');
    }
}
