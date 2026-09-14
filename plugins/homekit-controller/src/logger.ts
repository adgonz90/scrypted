// A console whose verbose output can be switched off.
//
// A HAP controller is only debuggable from its logs: the interesting failures - a camera that
// never sends a keyframe, a stream configuration refused for no stated reason, return audio
// arriving at the wrong rate - leave no other trace. The detail that diagnoses those is far too
// noisy to leave on, so it is written through `debug` and printed only when the device's Debug
// Logging setting is turned on.
//
// The wrapper delegates everything else to the device's real console, so `log`, `warn` and
// `error` are unaffected and always print.

export interface DebugConsole extends Console {
    /** Verbose diagnostics. Printed only while debug logging is enabled. */
    debug(...args: any[]): void;
    /** Whether verbose diagnostics are currently being printed. */
    readonly debugEnabled: boolean;
}

/**
 * Wraps a console so that `debug` is gated on `enabled`.
 *
 * `enabled` is called per message rather than captured, so turning the setting on takes effect
 * immediately on a device that is already running.
 */
export function createDebugConsole(base: Console, enabled: () => boolean): DebugConsole {
    // Inherit rather than copy: node binds each console method to its own instance at
    // construction, so the inherited ones still write to the device's log, and any method this
    // wrapper does not know about keeps working.
    const wrapper: DebugConsole = Object.create(base);
    wrapper.debug = (...args: any[]) => {
        if (enabled())
            base.log(...args);
    };
    Object.defineProperty(wrapper, 'debugEnabled', { get: enabled });
    return wrapper;
}
