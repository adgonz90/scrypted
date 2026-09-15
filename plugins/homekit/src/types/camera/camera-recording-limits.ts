/**
 * When a HomeKit Secure Video recording ends.
 *
 * HomeKit decides that, and normally closes the stream itself once motion clears. These bound the
 * case where it does not, which does happen. Following motion rather than a wall clock ends a
 * stream HomeKit has abandoned sooner, and stops truncating an event that is genuinely still
 * happening - but a motion sensor stuck on would then record without end, so the ceiling stays.
 *
 * The grace period has to outlast the gap between a camera's motion pulses. Cameras that report
 * motion as a short pulse rather than a level will drop and re-raise it several times during one
 * event, and a grace shorter than that gap splits the event into several clips.
 */
export const defaultMotionGraceSeconds = 30;
export const defaultMaxDurationSeconds = 10 * 60;

export function getRecordingLimits(storage: Storage) {
    const seconds = (key: string, fallback: number) => {
        const value = parseFloat(storage.getItem(key));
        // a zero or negative grace would end the recording the moment motion cleared, and a zero
        // ceiling would end it immediately; neither is a useful thing to have configured.
        return !isFinite(value) || value <= 0 ? fallback : value;
    };

    return {
        motionGraceMs: seconds('hksvMotionGrace', defaultMotionGraceSeconds) * 1000,
        maxDurationMs: seconds('hksvMaxDuration', defaultMaxDurationSeconds) * 1000,
    };
}
