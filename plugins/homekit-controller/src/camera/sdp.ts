// SDP describing the media a HAP camera sends us, used to drive the local RTSP server that
// Scrypted's pipeline consumes.

import { AudioCodecType, H264Level, H264Profile } from '../hap/types';
import { AudioCapability, samplerateToHz, VideoResolution } from './stream-config';
import { AUDIO_PAYLOAD_TYPE, VIDEO_PAYLOAD_TYPE } from './stream-session';

// H.264 profile_idc values for the three profiles HAP exposes.
const PROFILE_IDC: Record<number, number> = {
    [H264Profile.BASELINE]: 0x42,
    [H264Profile.MAIN]: 0x4d,
    [H264Profile.HIGH]: 0x64,
};

// level_idc values; HAP's three levels are 3.1, 3.2 and 4.0.
const LEVEL_IDC: Record<number, number> = {
    [H264Level.LEVEL3_1]: 0x1f,
    [H264Level.LEVEL3_2]: 0x20,
    [H264Level.LEVEL4_0]: 0x28,
};

function profileLevelId(profile: H264Profile, level: H264Level): string {
    const idc = PROFILE_IDC[profile] ?? 0x42;
    // constrained baseline sets the constraint_set1 flag; main and high carry no constraints.
    const constraints = profile === H264Profile.BASELINE ? 0xe0 : 0x00;
    const levelIdc = LEVEL_IDC[level] ?? 0x1f;
    return [idc, constraints, levelIdc]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

/**
 * Builds the AudioSpecificConfig for AAC-ELD at the negotiated sample rate.
 *
 * This mirrors the config Scrypted's HomeKit plugin uses for HomeKit's own AAC-ELD audio
 * (see plugins/homekit/src/types/camera/camera-return-audio.ts); the only variable part is the
 * frequency index, which is patched into the same fixed template.
 */
function aacEldConfig(sampleRate: number): string {
    const template = Buffer.from('F8F0212C00BC00', 'hex');
    const frequencyIndex = sampleRate === 8000 ? 11
        : sampleRate === 16000 ? 8
            : sampleRate === 24000 ? 6
                : 8;
    // byte 1 holds the last 3 bits of the object type, then 4 bits of frequency index.
    let b = template[1];
    b &= 0b11100001;
    b |= (frequencyIndex << 1);
    template[1] = b;
    return template.toString('hex').toUpperCase();
}

export interface SdpOptions {
    resolution: VideoResolution;
    profile: H264Profile;
    level: H264Level;
    audio?: AudioCapability;
    // ports the RTSP server will advertise; 0 is correct for interleaved TCP delivery.
    videoPort?: number;
    audioPort?: number;
    sessionName?: string;
}

export function createStreamSdp(options: SdpOptions): string {
    const { resolution, profile, level, audio } = options;
    const videoPort = options.videoPort ?? 0;
    const audioPort = options.audioPort ?? 0;

    const lines: string[] = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        `s=${options.sessionName || 'HomeKit Camera'}`,
        'c=IN IP4 127.0.0.1',
        't=0 0',

        `m=video ${videoPort} RTP/AVP ${VIDEO_PAYLOAD_TYPE}`,
        `a=rtpmap:${VIDEO_PAYLOAD_TYPE} H264/90000`,
        // HAP mandates non-interleaved mode, which is RFC 6184 packetization-mode 1.
        `a=fmtp:${VIDEO_PAYLOAD_TYPE} packetization-mode=1;profile-level-id=${profileLevelId(profile, level)}`,
        `a=framerate:${resolution.fps}`,
        'a=recvonly',
    ];

    if (audio) {
        const sampleRate = samplerateToHz(audio.samplerate);

        lines.push(`m=audio ${audioPort} RTP/AVP ${AUDIO_PAYLOAD_TYPE}`);

        if (audio.codec === AudioCodecType.OPUS) {
            // Opus is always declared with two channels in SDP even when the stream is mono;
            // the decoder takes the real channel count from the bitstream.
            lines.push(`a=rtpmap:${AUDIO_PAYLOAD_TYPE} opus/${sampleRate}/2`);
            lines.push(`a=fmtp:${AUDIO_PAYLOAD_TYPE} minptime=10;useinbandfec=1`);
        }
        else if (audio.codec === AudioCodecType.AAC_ELD) {
            lines.push(`a=rtpmap:${AUDIO_PAYLOAD_TYPE} MPEG4-GENERIC/${sampleRate}/${audio.channels}`);
            lines.push(`a=fmtp:${AUDIO_PAYLOAD_TYPE} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=${aacEldConfig(sampleRate)}`);
        }
        else if (audio.codec === AudioCodecType.PCMU) {
            lines.push(`a=rtpmap:${AUDIO_PAYLOAD_TYPE} PCMU/${sampleRate}`);
        }
        else if (audio.codec === AudioCodecType.PCMA) {
            lines.push(`a=rtpmap:${AUDIO_PAYLOAD_TYPE} PCMA/${sampleRate}`);
        }
        else {
            throw new Error(`no SDP mapping for HAP audio codec ${audio.codec}`);
        }

        lines.push('a=recvonly');
    }

    return lines.join('\r\n') + '\r\n';
}
