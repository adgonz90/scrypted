// Parsing of the camera capability characteristics, and construction of the selection TLV that
// tells the accessory which of those capabilities to actually use.

import * as tlv from '../hap/tlv';
import {
    AudioCodecConfigurationTLV,
    AudioCodecParametersTLV,
    AudioCodecType,
    AudioSamplerate,
    H264Level,
    H264Profile,
    SRTPCryptoSuite,
    SupportedAudioStreamConfigurationTLV,
    SupportedRTPConfigurationTLV,
    SupportedVideoStreamConfigurationTLV,
    VideoAttributesTLV,
    VideoCodecConfigurationTLV,
    VideoCodecParametersTLV,
    VideoCodecType,
} from '../hap/types';

export interface VideoResolution {
    width: number;
    height: number;
    fps: number;
}

export interface VideoCapabilities {
    codec: VideoCodecType;
    profiles: H264Profile[];
    levels: H264Level[];
    packetizationModes: number[];
    resolutions: VideoResolution[];
}

export interface AudioCapability {
    codec: AudioCodecType;
    channels: number;
    bitrateMode: number;
    samplerate: AudioSamplerate;
}

export interface AudioCapabilities {
    codecs: AudioCapability[];
    comfortNoise: boolean;
}

export interface StreamCapabilities {
    video: VideoCapabilities;
    audio: AudioCapabilities;
    cryptoSuites: SRTPCryptoSuite[];
}

export function samplerateToHz(samplerate: AudioSamplerate): number {
    switch (samplerate) {
        case AudioSamplerate.KHZ_8: return 8000;
        case AudioSamplerate.KHZ_16: return 16000;
        case AudioSamplerate.KHZ_24: return 24000;
        default: return 24000;
    }
}

export function audioCodecName(codec: AudioCodecType): string {
    return AudioCodecType[codec] || `unknown(${codec})`;
}

export function parseSupportedVideoStreamConfiguration(buffer: Buffer): VideoCapabilities {
    const root = tlv.decodeWithLists(buffer);
    const configurations = root[SupportedVideoStreamConfigurationTLV.VIDEO_CODEC_CONFIGURATION] || [];
    if (!configurations.length)
        throw new Error('accessory advertised no video codec configuration');

    // HAP only defines H.264, so there is at most one meaningful configuration.
    const configuration = tlv.decodeWithLists(configurations[0]);

    const codec = tlv.readUInt8(configuration[VideoCodecConfigurationTLV.CODEC_TYPE]?.[0], VideoCodecType.H264);
    const parameters = tlv.decodeWithLists(configuration[VideoCodecConfigurationTLV.CODEC_PARAMETERS]?.[0] || Buffer.alloc(0));

    const profiles = (parameters[VideoCodecParametersTLV.PROFILE_ID] || []).map(value => tlv.readUInt8(value));
    const levels = (parameters[VideoCodecParametersTLV.LEVEL] || []).map(value => tlv.readUInt8(value));
    const packetizationModes = (parameters[VideoCodecParametersTLV.PACKETIZATION_MODE] || []).map(value => tlv.readUInt8(value));

    // the attributes entry repeats once per supported resolution.
    const resolutions: VideoResolution[] = (configuration[VideoCodecConfigurationTLV.ATTRIBUTES] || []).map(value => {
        const attributes = tlv.decode(value);
        return {
            width: tlv.readUIntLE(attributes[VideoAttributesTLV.IMAGE_WIDTH], 0),
            height: tlv.readUIntLE(attributes[VideoAttributesTLV.IMAGE_HEIGHT], 0),
            fps: tlv.readUInt8(attributes[VideoAttributesTLV.FRAME_RATE], 30),
        };
    }).filter(resolution => resolution.width && resolution.height);

    if (!resolutions.length)
        throw new Error('accessory advertised no video resolutions');

    return {
        codec,
        profiles: profiles.length ? profiles : [H264Profile.BASELINE],
        levels: levels.length ? levels : [H264Level.LEVEL3_1],
        packetizationModes: packetizationModes.length ? packetizationModes : [0],
        resolutions,
    };
}

export function parseSupportedAudioStreamConfiguration(buffer: Buffer): AudioCapabilities {
    const root = tlv.decodeWithLists(buffer);
    const configurations = root[SupportedAudioStreamConfigurationTLV.AUDIO_CODEC_CONFIGURATION] || [];

    const codecs: AudioCapability[] = configurations.map(value => {
        const configuration = tlv.decode(value);
        const parameters = tlv.decode(configuration[AudioCodecConfigurationTLV.CODEC_PARAMETERS] || Buffer.alloc(0));
        return {
            codec: tlv.readUInt8(configuration[AudioCodecConfigurationTLV.CODEC_TYPE], AudioCodecType.AAC_ELD),
            channels: tlv.readUInt8(parameters[AudioCodecParametersTLV.CHANNEL], 1),
            bitrateMode: tlv.readUInt8(parameters[AudioCodecParametersTLV.BIT_RATE], 0),
            samplerate: tlv.readUInt8(parameters[AudioCodecParametersTLV.SAMPLE_RATE], AudioSamplerate.KHZ_24),
        };
    });

    return {
        codecs,
        comfortNoise: !!tlv.readUInt8(root[SupportedAudioStreamConfigurationTLV.COMFORT_NOISE_SUPPORT]?.[0], 0),
    };
}

export function parseSupportedRTPConfiguration(buffer: Buffer): SRTPCryptoSuite[] {
    const root = tlv.decodeWithLists(buffer);
    const suites = (root[SupportedRTPConfigurationTLV.SRTP_CRYPTO_SUITE] || []).map(value => tlv.readUInt8(value));
    return suites.length ? suites : [SRTPCryptoSuite.AES_CM_128_HMAC_SHA1_80];
}

/**
 * Snaps a requested size to the nearest the camera actually advertises.
 *
 * A camera rejects anything not drawn from its own list, so every requested size has to be mapped
 * onto that list rather than passed through. Matching is on pixel area, which behaves sensibly
 * when only one dimension was given.
 */
export function nearestResolution(capabilities: VideoCapabilities, width?: number, height?: number): VideoResolution {
    if (!width && !height)
        return largestResolution(capabilities);

    const target = Math.max(width || 0, 1) * Math.max(height || 0, 1);

    return [...capabilities.resolutions].sort((a, b) =>
        Math.abs(a.width * a.height - target) - Math.abs(b.width * b.height - target))[0];
}

/**
 * H.264 Annex A limits for the three levels HAP defines: the largest frame in macroblocks, and the
 * largest macroblock rate per second.
 */
const LEVEL_LIMITS: Record<number, { maxFrameMacroblocks: number, maxMacroblocksPerSecond: number }> = {
    [H264Level.LEVEL3_1]: { maxFrameMacroblocks: 3600, maxMacroblocksPerSecond: 108000 },
    [H264Level.LEVEL3_2]: { maxFrameMacroblocks: 5120, maxMacroblocksPerSecond: 216000 },
    [H264Level.LEVEL4_0]: { maxFrameMacroblocks: 8192, maxMacroblocksPerSecond: 245760 },
};

function frameMacroblocks(resolution: VideoResolution): number {
    return Math.ceil(resolution.width / 16) * Math.ceil(resolution.height / 16);
}

function levelFits(level: H264Level, resolution: VideoResolution): boolean {
    const limits = LEVEL_LIMITS[level];
    if (!limits)
        return false;
    const macroblocks = frameMacroblocks(resolution);
    return macroblocks <= limits.maxFrameMacroblocks
        && macroblocks * resolution.fps <= limits.maxMacroblocksPerSecond;
}

/**
 * The level to request, chosen from what the camera advertised.
 *
 * The lowest advertised level that can carry the frame, since asking for more than the frame needs
 * only constrains the encoder. If the camera advertises nothing that fits - which means its own
 * resolution and level lists contradict each other - its highest advertised level is used, because
 * the camera's own data is the better guide to what it will accept. See requiredLevel for the
 * corrective case.
 */
export function advertisedLevelFor(capabilities: VideoCapabilities, resolution: VideoResolution): H264Level {
    const advertised = [...capabilities.levels].sort((a, b) => a - b);
    return advertised.find(level => levelFits(level, resolution)) ?? bestLevel(capabilities);
}

/**
 * The level H.264 actually requires for this frame, ignoring what was advertised.
 *
 * Only for the corrective fallback: when a camera advertises a resolution none of its advertised
 * levels can carry, one of the two lists is wrong, and this offers the reading where the level
 * list is the mistaken one.
 */
export function requiredLevel(resolution: VideoResolution): H264Level {
    const all = [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0];
    return all.find(level => levelFits(level, resolution)) ?? H264Level.LEVEL4_0;
}

/** True when no advertised level can carry this resolution, which means the camera is inconsistent. */
export function exceedsAdvertisedLevel(capabilities: VideoCapabilities, resolution: VideoResolution): boolean {
    return !capabilities.levels.some(level => levelFits(level, resolution));
}

export function largestResolution(capabilities: VideoCapabilities): VideoResolution {
    return [...capabilities.resolutions].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
}


/** Highest profile and level the accessory offers, which is what a recording client wants. */
export function bestProfile(capabilities: VideoCapabilities): H264Profile {
    return Math.max(...capabilities.profiles) as H264Profile;
}

export function bestLevel(capabilities: VideoCapabilities): H264Level {
    return Math.max(...capabilities.levels) as H264Level;
}

/**
 * Chooses the audio codec to request. Opus is preferred over AAC-ELD: ffmpeg and WebRTC both
 * handle it natively, whereas AAC-ELD needs a specific decoder path and is the weaker option
 * everywhere downstream. AAC-ELD is mandatory in HAP, Opus is not, so the fallback matters.
 */
export function chooseAudioCodec(capabilities: AudioCapabilities, preferred?: AudioCodecType): AudioCapability {
    if (!capabilities.codecs.length)
        return undefined;

    const order = preferred !== undefined
        ? [preferred, AudioCodecType.OPUS, AudioCodecType.AAC_ELD]
        : [AudioCodecType.OPUS, AudioCodecType.AAC_ELD];

    for (const codec of order) {
        const match = capabilities.codecs.find(candidate => candidate.codec === codec);
        if (match)
            return match;
    }
    return capabilities.codecs[0];
}

/**
 * Combines the capabilities of several stream management services into what the camera can do
 * overall. Used for what is advertised upstream; an individual session still runs against one
 * service's own capabilities.
 */
export function unionCapabilities(all: StreamCapabilities[]): StreamCapabilities {
    if (all.length === 1)
        return all[0];

    const resolutions: VideoResolution[] = [];
    const seen = new Set<string>();
    for (const capabilities of all) {
        for (const resolution of capabilities.video.resolutions) {
            const key = `${resolution.width}x${resolution.height}@${resolution.fps}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            resolutions.push(resolution);
        }
    }

    const unique = <T>(values: T[]) => [...new Set(values)];

    return {
        video: {
            codec: all[0].video.codec,
            profiles: unique(all.flatMap(c => c.video.profiles)),
            levels: unique(all.flatMap(c => c.video.levels)),
            packetizationModes: unique(all.flatMap(c => c.video.packetizationModes)),
            resolutions,
        },
        audio: {
            // dedupe on the codec identity, keeping the first service's parameters for it.
            codecs: all.flatMap(c => c.audio.codecs)
                .filter((codec, index, list) => list.findIndex(other => other.codec === codec.codec) === index),
            comfortNoise: all.some(c => c.audio.comfortNoise),
        },
        cryptoSuites: unique(all.flatMap(c => c.cryptoSuites)),
    };
}

/** True when this service advertises exactly this resolution. */
export function supportsResolution(capabilities: StreamCapabilities, resolution: VideoResolution): boolean {
    return capabilities.video.resolutions.some(candidate =>
        candidate.width === resolution.width
        && candidate.height === resolution.height
        && candidate.fps === resolution.fps);
}

export function describeCapabilities(capabilities: StreamCapabilities): string {
    const resolutions = capabilities.video.resolutions
        .map(resolution => `${resolution.width}x${resolution.height}@${resolution.fps}`)
        .join(', ');
    const codecs = capabilities.audio.codecs
        .map(codec => `${audioCodecName(codec.codec)}/${samplerateToHz(codec.samplerate)}/${codec.channels}ch`)
        .join(', ');
    return `video: ${resolutions}; audio: ${codecs || 'none'}`;
}
