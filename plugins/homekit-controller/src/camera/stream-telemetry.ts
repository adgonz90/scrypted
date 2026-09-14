// What a camera is actually sending, and the keyframe pacing that depends on it.
//
// These are one piece of state rather than two. How often a keyframe arrives decides whether to
// ask for another, and whether asking was worth it is answered by the framerate that arrived
// alongside - a camera at its own bitrate ceiling pays for every extra keyframe in frames.
//
// It lives apart from the device so that it can be driven by a test against cameras this plugin
// has never seen. Behaviour tuned against one accessory is the thing most likely to be wrong on
// the next one, and a camera's keyframe behaviour is not something a maintainer can try out.

import { containsKeyframe, describeRtpPacket, isPlausibleH264, naluTypes } from './h264';

/**
 * How recent a keyframe has to be for automatic requests to leave the camera alone.
 *
 * Rebroadcast stores ten seconds, but a consumer starting a stream searches only part of it for a
 * keyframe to begin at, and that search is `min(4000, detected IDR interval)` for a local
 * destination and `min(2000, ...)` for a remote one. Anything older is of no use: the search
 * fails and the viewer waits for the camera's next keyframe. So the target is the search window,
 * not the size of the buffer.
 *
 * Aiming just inside the local four seconds is the most a camera can be left alone while still
 * serving that search every time. Two seconds would also satisfy a remote viewer and costs far
 * more than it looks: a camera encodes to its own bitrate ceiling, which is not the one it was
 * asked for, and a keyframe is many times the size of the frames around it. Recording is
 * unaffected either way, since HomeKit Secure Video widens its own prebuffer request to
 * `max(4000, detected IDR interval)` rather than searching a fixed window.
 */
export const KEYFRAME_FRESHNESS_MS = 3500;

/** Checked often enough that the target is not routinely overshot by the granularity itself. */
export const KEYFRAME_CHECK_MS = 500;

/**
 * The least time between two automatic keyframe requests.
 *
 * A request is a hint, not a command: the camera answers when its encoder next can, which is not
 * within the check interval. Without this, a camera slow to respond is asked again twice a second
 * for as long as it takes, and a camera that answers every one of those spends its bitrate on
 * keyframes instead of frames.
 */
export const KEYFRAME_REQUEST_GAP_MS = 1000;

/**
 * The longest that gap grows to while a camera ignores the requests.
 *
 * Each unanswered request doubles the wait before the next one. A camera that honours requests
 * never reaches this, because the keyframe it sends resets the gap; one that does not honour them
 * at all is asked a handful of times and then largely left alone, rather than being sent RTCP
 * twice a second for the life of the stream.
 */
export const KEYFRAME_BACKOFF_MAX_MS = 8000;

/**
 * How soon after a request a keyframe has to arrive to count as an answer to it.
 *
 * The distinction matters for the backoff above. A camera with a slow group of pictures still
 * sends keyframes on its own schedule while ignoring every request, and treating those as answers
 * would reset the backoff each time and start the hammering over. An encoder that is honouring a
 * request acts on its next frame, so anything beyond a couple of seconds was coincidence.
 */
export const KEYFRAME_RESPONSE_MS = 2000;

/** How often the census is reported. */
export const CENSUS_INTERVAL_MS = 30000;

/**
 * Fallback window for deciding whether two keyframe packets are the same keyframe.
 *
 * Only used for a packet too short to carry a readable RTP timestamp, which is the exact answer.
 * A window has to guess, and guesses badly at both ends: a large IDR at a modest bitrate takes
 * longer to arrive than any window worth picking - a 1200x1600 keyframe was observed spread over
 * 300ms - and counting it twice halves the reported interval and suppresses requests that are
 * actually needed.
 */
const KEYFRAME_COALESCE_MS = 250;

/** The first few gaps are reported individually; after that the census carries the average. */
const REPORTED_GAPS = 5;

/** How many packets to describe at the start of a stream, for diagnosing one that will not play. */
const DESCRIBED_PACKETS = 6;

/** How many packets to look at before judging whether the video is H.264 at all. */
const PLAUSIBILITY_SAMPLE = 40;

export interface StreamTelemetryOptions {
    /** `auto`, `off`, or a fixed interval in whole seconds. */
    mode: string;
    /** Sends a picture loss indication and full intra request to the camera. */
    requestKeyframe: () => void;
    console?: Console;
    /** Called once, when the stream's first keyframe arrives and a picture can be drawn. */
    onFirstKeyframe?: (firstPacketAt: number, at: number) => void;
}

export class StreamTelemetry {
    /** When video first arrived, which is not when a picture could first be drawn. */
    firstPacketAt: number;
    /** When the newest distinct keyframe arrived. */
    lastKeyframeAt: number;

    private fixedMs: number;
    private lastVideoTimestamp: number;
    private lastKeyframeTimestamp: number;
    private seenNaluTypes = new Set<number>();
    private describedPackets = 0;
    private checkedPackets = 0;
    private implausiblePackets = 0;
    private reportedGaps = 0;

    // the current census window.
    private windowStart: number;
    private windowBytes = 0;
    private windowFrames = 0;
    private windowGapTotal = 0;
    private windowGaps = 0;
    private windowRequested = 0;

    // request pacing.
    private lastRequestAt = 0;
    private requestGap = KEYFRAME_REQUEST_GAP_MS;
    private requestedSinceKeyframe = false;

    constructor(private options: StreamTelemetryOptions, now = Date.now()) {
        const fixed = parseInt(options.mode);
        this.fixedMs = isNaN(fixed) ? 0 : fixed * 1000;
        this.windowStart = now;
    }

    /**
     * Whether the video arriving looks like H.264 at all.
     *
     * Undefined until enough packets have been seen to judge. False means the bytes are not H.264,
     * which is a decryption problem rather than a packetization one - nothing about keyframes or
     * codecs will explain it.
     */
    get videoIsPlausible(): boolean {
        if (this.checkedPackets < PLAUSIBILITY_SAMPLE)
            return undefined;
        // an occasional odd packet is normal; a majority is not.
        return this.implausiblePackets * 2 < this.checkedPackets;
    }

    /** Every H.264 NAL type seen on this stream, for explaining one that will not decode. */
    get observedNaluTypes(): number[] {
        return [...this.seenNaluTypes];
    }

    /** Whether this camera is asked for keyframes at all. */
    get requestsKeyframes(): boolean {
        return this.options.mode !== 'off';
    }

    /** How often `checkKeyframe` should be called. */
    get checkIntervalMs(): number {
        return this.fixedMs || KEYFRAME_CHECK_MS;
    }

    /** Records one video RTP packet. */
    onVideoPacket(rtp: Buffer, now = Date.now()): void {
        // Not `||=`: a timestamp is a number, and zero is a legitimate one. Date.now never
        // returns it, but a test clock does, and the difference should not be what decides whether
        // this works.
        if (this.firstPacketAt === undefined)
            this.firstPacketAt = now;
        this.windowBytes += rtp.length;

        // One frame spans many packets, and what changes between frames is the RTP timestamp. It
        // sits at a fixed offset in every packet, so counting frames costs a read rather than a
        // parse - but a runt packet would make that read throw inside an event handler, which is
        // not worth risking for a statistic.
        // Every packet of one frame carries that frame's timestamp, so this both counts frames and
        // identifies which frame a keyframe packet belongs to.
        let timestamp: number;
        if (rtp.length >= 8) {
            timestamp = rtp.readUInt32BE(4);
            if (timestamp !== this.lastVideoTimestamp) {
                this.lastVideoTimestamp = timestamp;
                this.windowFrames++;
            }
        }

        if (this.checkedPackets < PLAUSIBILITY_SAMPLE) {
            this.checkedPackets++;
            if (!isPlausibleH264(rtp))
                this.implausiblePackets++;
        }

        if (this.describedPackets < DESCRIBED_PACKETS && this.options.console?.debug) {
            this.describedPackets++;
            this.options.console.debug(`video packet ${this.describedPackets}: ${describeRtpPacket(rtp)}`);
        }

        // Cheap enough at a handful of distinct values, and the only way to tell a camera that
        // sends no IDR from one whose IDRs are packetized in a form this does not unwrap.
        if (this.seenNaluTypes.size < 12) {
            for (const type of naluTypes(rtp))
                this.seenNaluTypes.add(type);
        }

        if (!containsKeyframe(rtp))
            return;

        // A keyframe spans many packets. Which frame each belongs to is written in the packet, so
        // use that rather than inferring it from arrival times.
        const sameKeyframe = timestamp === undefined
            ? this.lastKeyframeAt !== undefined && now - this.lastKeyframeAt <= KEYFRAME_COALESCE_MS
            : timestamp === this.lastKeyframeTimestamp;
        if (sameKeyframe)
            return;
        this.lastKeyframeTimestamp = timestamp;

        if (this.lastKeyframeAt === undefined) {
            this.options.onFirstKeyframe?.(this.firstPacketAt, now);
        }
        else {
            const gap = now - this.lastKeyframeAt;
            this.windowGapTotal += gap;
            this.windowGaps++;
            if (this.requestedSinceKeyframe)
                this.windowRequested++;

            // Report the first few individually rather than only an average, because the useful
            // answer may be that there is no second keyframe at all: a camera that sends parameter
            // sets once and then only predicted frames leaves every later viewer with nothing to
            // start from, and an average over an empty set says nothing.
            if (this.reportedGaps < REPORTED_GAPS) {
                this.reportedGaps++;
                this.options.console?.debug(`keyframe ${this.reportedGaps + 1} arrived`
                    + ` ${(gap / 1000).toFixed(1)}s after the previous one`);
            }
        }

        // Only a keyframe that arrived promptly after a request says the requests are working.
        // One that turned up on the camera's own schedule says nothing, and resetting on those is
        // how a camera that ignores requests entirely ends up being asked forever.
        if (this.requestedSinceKeyframe && now - this.lastRequestAt <= KEYFRAME_RESPONSE_MS)
            this.requestGap = KEYFRAME_REQUEST_GAP_MS;

        this.lastKeyframeAt = now;
        this.requestedSinceKeyframe = false;
    }

    /** Asks for a keyframe if one is due. Call every `checkIntervalMs`. */
    checkKeyframe(now = Date.now()): void {
        if (!this.requestsKeyframes)
            return;

        // A fixed interval asks regardless of what the camera is doing, which is the whole point
        // of choosing one.
        if (this.fixedMs) {
            this.send(now);
            return;
        }

        if (now - this.lastRequestAt < this.requestGap)
            return;

        const age = this.lastKeyframeAt === undefined ? Infinity : now - this.lastKeyframeAt;
        if (age <= KEYFRAME_FRESHNESS_MS)
            return;

        // nothing arrived since the last request, so wait longer before the next.
        if (this.requestedSinceKeyframe)
            this.requestGap = Math.min(this.requestGap * 2, KEYFRAME_BACKOFF_MAX_MS);

        this.send(now);
    }

    private send(now: number) {
        this.lastRequestAt = now;
        this.requestedSinceKeyframe = true;
        this.options.requestKeyframe();
    }

    /**
     * The line describing the window just ended, and starts a new one.
     *
     * Per window rather than cumulative, so that a change shows up instead of being averaged into
     * everything that came before it.
     */
    census(now = Date.now()): string {
        if (this.firstPacketAt === undefined)
            return 'no video has arrived from the camera yet';

        const seconds = (now - this.windowStart) / 1000;
        const fps = this.windowFrames / seconds;
        // The mean gap, rather than keyframes divided by the window: at a five second interval a
        // thirty second window holds five or six of them, and dividing by that quantises the
        // answer to the nearest second - the wrong granularity for a number being compared against
        // a four second budget.
        const gap = this.windowGaps ? this.windowGapTotal / this.windowGaps / 1000 : 0;

        const line = `video: ${fps.toFixed(1)}fps, ${Math.round(this.windowBytes * 8 / seconds / 1000)}kbps,`
            + (gap
                // Also in frames, because that is the unit an encoder's group of pictures is
                // configured in. A camera holding it fixed there changes its interval in seconds
                // whenever its framerate moves, which reads as changed keyframe behaviour when
                // nothing about the keyframes has changed at all.
                ? ` a keyframe every ${gap.toFixed(1)}s (${Math.round(gap * fps)} frames, ${this.describeRequested()})`
                : ` no keyframe in the last ${Math.round(seconds)}s`)
            + (this.lastKeyframeAt === undefined ? '' : `, newest ${Math.round((now - this.lastKeyframeAt) / 1000)}s old`);

        this.windowStart = now;
        this.windowBytes = 0;
        this.windowFrames = 0;
        this.windowGapTotal = 0;
        this.windowGaps = 0;
        this.windowRequested = 0;

        return line;
    }

    /**
     * How much of the cadence is this plugin's doing.
     *
     * This is the number that says whether the Keyframe Requests setting is worth touching: a
     * camera sending them on its own is unaffected by it, and one where every keyframe was asked
     * for is being driven entirely by it and would slow to its own rate if it were turned off.
     */
    private describeRequested(): string {
        if (!this.windowRequested)
            return 'none requested';
        if (this.windowRequested >= this.windowGaps)
            return 'all requested';
        return `${this.windowRequested} of ${this.windowGaps} requested`;
    }
}
