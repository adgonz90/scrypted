// What to do about a camera that refuses every stream configuration offered.
//
// Kept apart from the camera device so the policy can be tested on its own: the device does the
// reconnecting and rebuilding, this decides which of them is due and how long to wait after.

/** First wait once reconnecting and rebuilding have both failed to help. */
export const REJECTION_BACKOFF_MS = 30000;

/** And the longest, so a camera that recovers on its own is never left for long. */
export const REJECTION_BACKOFF_MAX_MS = 10 * 60 * 1000;

/**
 * How long to wait before asking again when the camera says it is switched off.
 *
 * Fixed rather than doubling. Nothing is wrong with a camera someone has turned off, so there is
 * nothing to back away from; the only question is how soon turning it back on is noticed.
 */
export const DISABLED_RETRY_MS = 30000;

export type RecoveryStep =
    /** Drop the connection, which makes the accessory release every session tied to it. */
    | { kind: 'reconnect' }
    /** Re-read the accessory database, in case the iids being written to have moved. */
    | { kind: 'rebuild' }
    /** Stop asking for a while; the camera almost certainly wants a power cycle. */
    | { kind: 'backoff', ms: number }
    /** The camera refused because it is switched off. Say so and check again shortly. */
    | { kind: 'disabled', reason: string, ms: number };

/**
 * The recovery ladder.
 *
 * Each rung addresses a different cause and is tried only when the one before it did not help:
 * reconnect for stranded sessions, rebuild for a moved accessory database, then back off. A camera
 * that is switched off is taken off the ladder entirely - none of the rungs can help it, and the
 * last one ends by telling someone to power cycle a camera whose only problem is a switch.
 */
export class StreamRecovery {
    private stage = 0;
    private backoffMs = 0;
    private until = 0;

    /** Decides the next step after a refusal. `disabledReason` is set when the camera reports being off. */
    next(disabledReason?: string, now = Date.now()): RecoveryStep {
        if (disabledReason) {
            this.until = now + DISABLED_RETRY_MS;
            return { kind: 'disabled', reason: disabledReason, ms: DISABLED_RETRY_MS };
        }

        if (this.stage === 0) {
            this.stage = 1;
            return { kind: 'reconnect' };
        }
        if (this.stage === 1) {
            this.stage = 2;
            return { kind: 'rebuild' };
        }

        this.backoffMs = this.backoffMs
            ? Math.min(this.backoffMs * 2, REJECTION_BACKOFF_MAX_MS)
            : REJECTION_BACKOFF_MS;
        this.until = now + this.backoffMs;
        return { kind: 'backoff', ms: this.backoffMs };
    }

    /** Milliseconds until the camera may be asked again; 0 when it may be asked now. */
    remaining(now = Date.now()): number {
        return Math.max(0, this.until - now);
    }

    /** Whether any recovery is in progress, so a success is worth remarking on. */
    get active(): boolean {
        return this.stage > 0 || this.until > 0;
    }

    /** Back to the bottom rung: the camera streamed, or someone asked to try again now. */
    reset() {
        this.stage = 0;
        this.backoffMs = 0;
        this.until = 0;
    }
}

export interface OperatingModeReading {
    /** HomeKit Camera Active on the Camera Operating Mode service; 1 is on. */
    homeKitCameraActive?: unknown;
    /** Manually Disabled on the Camera Operating Mode service; 1 is disabled. */
    manuallyDisabled?: unknown;
    /** Active on the stream's own RTP Stream Management service; 1 is on. */
    streamActive?: unknown;
}

/**
 * Why a camera would refuse to stream because of how it is configured, if it would.
 *
 * An accessory must refuse to start a stream while it is switched off, and the conditions are
 * spelled out in Apple's camera specification: the stream's own service inactive, HomeKit Camera
 * Active off, or Manually Disabled set. Absent characteristics say nothing, since most cameras
 * implement only some of them.
 */
export function describeStreamingDisabled(reading: OperatingModeReading): string | undefined {
    const on = (value: unknown) => value === true || value === 1 || value === '1';
    const off = (value: unknown) => value === false || value === 0 || value === '0';

    if (on(reading.manuallyDisabled))
        return 'the camera is manually disabled, from the camera itself or its own app';
    if (off(reading.homeKitCameraActive))
        return 'Camera Active is off, in the Home app or on this camera\'s Camera Active control';
    if (off(reading.streamActive))
        return 'streaming is turned off on the camera for this stream';
    return undefined;
}
