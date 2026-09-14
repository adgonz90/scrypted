// Just enough H.264 RTP inspection to tell whether a packet can start a picture.

// RFC 6184 NAL types. A decoder needs the parameter sets and an IDR before it can draw anything,
// but only the IDR marks a point it can start from - see isKeyframeNalu.
const NAL_IDR = 5;
// Referenced by the diagnostics rather than by keyframe detection; see isKeyframeNalu.
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;
const NAL_FU_B = 29;

/**
 * Whether this NAL is one a decoder can actually start a picture from.
 *
 * Only an IDR is. Parameter sets are necessary alongside one and useless without it, and counting
 * them here is a mistake that hides the failure it causes: encoders commonly repeat SPS and PPS
 * every few frames, so a camera sending them four times a second and an IDR once a minute looks
 * like a camera with a keyframe every quarter second. Keyframe requests are then never made,
 * because nothing appears to be missing, while every consumer downstream searches for an IDR and
 * finds none. The symptom is a stream that negotiates perfectly and never shows a picture.
 */
function isKeyframeNalu(type: number): boolean {
    return type === NAL_IDR;
}

/** The offset of the payload within an RTP packet, past the header, CSRCs and any extension. */
function payloadOffset(rtp: Buffer): number {
    const csrcCount = rtp[0] & 0x0f;
    const hasExtension = !!(rtp[0] & 0x10);
    let offset = 12 + csrcCount * 4;
    if (hasExtension && rtp.length >= offset + 4)
        offset += 4 + rtp.readUInt16BE(offset + 2) * 4;
    return offset;
}

/**
 * Where the payload ends, which is not the end of the packet when RFC 3550 padding is present.
 *
 * The padding bit means the last byte counts the bytes to discard, itself included. Reading past
 * that point walks into bytes that are deliberately meaningless - which for an aggregation packet,
 * whose contents are a chain of explicit lengths, means following a length field into noise.
 */
function payloadEnd(rtp: Buffer): number {
    if (!(rtp[0] & 0x20))
        return rtp.length;
    const padding = rtp[rtp.length - 1];
    const end = rtp.length - padding;
    // a padding count that does not fit is a malformed packet; treat it as unpadded.
    return padding > 0 && end > payloadOffset(rtp) ? end : rtp.length;
}

/**
 * True if this RTP packet carries part of an H.264 keyframe.
 *
 * A decoder can draw nothing until one arrives, so this marks the real end of stream startup far
 * better than the first packet does. Aggregation and fragmentation packets are unwrapped, since
 * parameter sets and IDR slices are usually carried inside those rather than on their own.
 */
export function containsKeyframe(rtp: Buffer): boolean {
    const offset = payloadOffset(rtp);
    const end = payloadEnd(rtp);
    if (end <= offset)
        return false;

    const naluType = rtp[offset] & 0x1f;

    // STAP-A aggregates several NALs, each behind a two byte length.
    if (naluType === NAL_STAP_A) {
        let position = offset + 1;
        while (position + 2 <= end) {
            const size = rtp.readUInt16BE(position);
            position += 2;
            if (!size || position + size > end)
                break;
            if (isKeyframeNalu(rtp[position] & 0x1f))
                return true;
            position += size;
        }
        return false;
    }

    // a fragmentation unit carries the real type in its second byte.
    if (naluType === NAL_FU_A || naluType === NAL_FU_B)
        return end > offset + 1 && isKeyframeNalu(rtp[offset + 1] & 0x1f);

    return isKeyframeNalu(naluType);
}

// The NAL types worth naming in a diagnostic. Everything else is printed as a bare number.
const NALU_NAMES: Record<number, string> = {
    1: 'non-IDR slice',
    5: 'IDR',
    6: 'SEI',
    [NAL_SPS]: 'SPS',
    [NAL_PPS]: 'PPS',
    9: 'access unit delimiter',
    [NAL_STAP_A]: 'STAP-A',
    25: 'STAP-B',
    26: 'MTAP16',
    27: 'MTAP24',
    [NAL_FU_A]: 'FU-A',
    [NAL_FU_B]: 'FU-B',
};

/**
 * The NAL types an RTP packet delivers, unwrapping aggregation and fragmentation.
 *
 * Diagnostic only. When a camera sends video that nothing downstream can start decoding, the
 * question is always whether it is not sending parameter sets and IDRs at all, or sending them
 * packetized in a way this code does not recognise - and from the outside those are identical.
 * An aggregation type appearing here as itself, rather than as the types inside it, is the second
 * case: modes HAP does not permit, such as STAP-B and the MTAPs, are not unwrapped.
 */
export function naluTypes(rtp: Buffer): number[] {
    const offset = payloadOffset(rtp);
    const end = payloadEnd(rtp);
    if (end <= offset)
        return [];

    const naluType = rtp[offset] & 0x1f;

    if (naluType === NAL_STAP_A) {
        const types: number[] = [];
        let position = offset + 1;
        while (position + 2 <= end) {
            const size = rtp.readUInt16BE(position);
            position += 2;
            if (!size || position + size > end)
                break;
            types.push(rtp[position] & 0x1f);
            position += size;
        }
        return types.length ? types : [naluType];
    }

    if (naluType === NAL_FU_A || naluType === NAL_FU_B)
        return end > offset + 1 ? [rtp[offset + 1] & 0x1f] : [naluType];

    return [naluType];
}

/** Renders NAL types for a log line, naming the ones worth naming. */
export function describeNaluTypes(types: number[]): string {
    return types
        .sort((a, b) => a - b)
        .map(type => NALU_NAMES[type] ? `${type} (${NALU_NAMES[type]})` : `${type}`)
        .join(', ');
}

/**
 * One line describing an RTP packet's shape, for when a stream will not decode anywhere.
 *
 * Every consumer downstream parses these bytes with its own assumptions - about padding, header
 * extensions, and how aggregation packets tile their contents - and when a camera trips one of
 * those, nothing in the resulting error says which assumption was wrong. This prints what the
 * packet actually is.
 */
export function describeRtpPacket(rtp: Buffer): string {
    const offset = payloadOffset(rtp);
    const end = payloadEnd(rtp);
    const flags = [
        `v${rtp[0] >> 6}`,
        rtp[0] & 0x20 ? `pad=${rtp[rtp.length - 1]}` : 'pad=0',
        rtp[0] & 0x10 ? 'ext' : 'no-ext',
        `cc=${rtp[0] & 0x0f}`,
        rtp[1] & 0x80 ? 'marker' : '-',
        `pt=${rtp[1] & 0x7f}`,
    ].join(' ');

    // Whether an aggregation packet's lengths tile its payload exactly. They must: a consumer
    // walks them in a chain, so one wrong length sends it into the rest of the packet as if it
    // were a length field.
    let tiling = '';
    if (end > offset && (rtp[offset] & 0x1f) === NAL_STAP_A) {
        const parts: number[] = [];
        let position = offset + 1;
        let ok = true;
        while (position + 2 <= end) {
            const size = rtp.readUInt16BE(position);
            position += 2;
            if (!size || position + size > end) {
                ok = false;
                break;
            }
            parts.push(size);
            position += size;
        }
        tiling = `, stap-a [${parts.join(',')}] ${ok && position === end ? 'tiles exactly' : `STOPS AT ${position} of ${end}`}`;
    }

    return `${rtp.length}b ${flags}, payload ${offset}..${end} = `
        + `${rtp.subarray(offset, Math.min(offset + 8, end)).toString('hex').replace(/(..)/g, '$1 ').trim()}`
        + `${tiling}`;
}

/**
 * Whether a packet's payload can be H.264 at all.
 *
 * Every NAL header has its top bit, forbidden_zero_bit, clear. A payload that sets it is not H.264
 * - which in practice means it was decrypted with the wrong key, since SRTP counter mode produces
 * plausible looking bytes from a wrong key rather than failing. That is worth distinguishing from
 * a camera sending video this code merely does not understand.
 */
export function isPlausibleH264(rtp: Buffer): boolean {
    const offset = payloadOffset(rtp);
    if (payloadEnd(rtp) <= offset)
        return false;
    return !(rtp[offset] & 0x80);
}
