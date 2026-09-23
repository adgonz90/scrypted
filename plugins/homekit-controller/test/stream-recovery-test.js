// What happens to a camera that refuses every stream configuration.
//
// The ladder exists because the obvious responses are each wrong on their own: retrying blindly
// hammers a camera that is already in trouble, and backing off recovers nothing. And a camera that
// is simply switched off must come off the ladder entirely, or it is eventually diagnosed as wanting
// a power cycle. These pin down the order, the arithmetic, and that last exemption.

const path = require('path');

const OUT = path.resolve(__dirname, '../tsout');
const {
    StreamRecovery,
    describeStreamingDisabled,
    REJECTION_BACKOFF_MS,
    REJECTION_BACKOFF_MAX_MS,
    DISABLED_RETRY_MS,
} = require(path.join(OUT, 'camera/stream-recovery.js'));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

// --- the ladder ---
{
    const recovery = new StreamRecovery();
    const now = 1000000;
    const kinds = [];
    const waits = [];
    for (let i = 0; i < 9; i++) {
        const step = recovery.next(undefined, now);
        kinds.push(step.kind);
        if (step.kind === 'backoff')
            waits.push(step.ms);
    }

    check('the cheap fixes come first: reconnect, then rebuild, then backing off',
        kinds.slice(0, 3).join(',') === 'reconnect,rebuild,backoff', kinds.join(','));

    check('reconnect and rebuild are each tried once, not repeated',
        kinds.filter(k => k === 'reconnect').length === 1 && kinds.filter(k => k === 'rebuild').length === 1,
        kinds.join(','));

    check('the wait doubles from thirty seconds',
        waits[0] === REJECTION_BACKOFF_MS && waits[1] === REJECTION_BACKOFF_MS * 2 && waits[2] === REJECTION_BACKOFF_MS * 4,
        waits.map(w => w / 1000 + 's').join(', '));

    check('and stops at ten minutes',
        Math.max(...waits) === REJECTION_BACKOFF_MAX_MS && waits[waits.length - 1] === REJECTION_BACKOFF_MAX_MS,
        waits.map(w => w / 1000 + 's').join(', '));
}

// --- waiting, and the end of waiting ---
{
    const recovery = new StreamRecovery();
    const now = 1000000;
    recovery.next(undefined, now);
    check('a reconnect imposes no wait, so the retry after it is immediate', recovery.remaining(now) === 0);

    recovery.next(undefined, now);
    check('nor does a rebuild', recovery.remaining(now) === 0);

    recovery.next(undefined, now);
    check('backing off does', recovery.remaining(now) === REJECTION_BACKOFF_MS, `${recovery.remaining(now)}ms`);
    check('and the wait runs down', recovery.remaining(now + 20000) === 10000, `${recovery.remaining(now + 20000)}ms`);
    check('and ends', recovery.remaining(now + REJECTION_BACKOFF_MS) === 0);

    recovery.reset();
    check('a success sends the next failure back to the cheapest rung',
        recovery.next(undefined, now).kind === 'reconnect' && !recovery.remaining(now));
}

// --- a camera that is switched off ---
{
    const recovery = new StreamRecovery();
    const now = 1000000;
    const step = recovery.next('Camera Active is off', now);
    check('a switched off camera is reported as switched off',
        step.kind === 'disabled' && step.reason === 'Camera Active is off', JSON.stringify(step));
    check('and checked again on a short fixed wait',
        recovery.remaining(now) === DISABLED_RETRY_MS, `${recovery.remaining(now)}ms`);

    for (let i = 0; i < 5; i++)
        recovery.next('Camera Active is off', now);
    check('however long it stays off, the wait does not grow',
        recovery.remaining(now) === DISABLED_RETRY_MS, `${recovery.remaining(now)}ms`);

    check('and none of it counts towards the ladder: turned back on and refusing, it starts at the bottom',
        recovery.next(undefined, now).kind === 'reconnect');
}

// --- reading the switches ---
{
    check('nothing present says nothing', describeStreamingDisabled({}) === undefined);
    check('everything on says nothing',
        describeStreamingDisabled({ homeKitCameraActive: 1, manuallyDisabled: 0, streamActive: 1 }) === undefined);
    check('Camera Active off is reported',
        /Camera Active is off/.test(describeStreamingDisabled({ homeKitCameraActive: 0 }) || ''));
    check('Manually Disabled on is reported',
        /manually disabled/.test(describeStreamingDisabled({ manuallyDisabled: 1 }) || ''));
    check('the stream\'s own Active off is reported',
        /streaming is turned off/.test(describeStreamingDisabled({ streamActive: 0 }) || ''));
    check('booleans are read the same as HAP\'s 0 and 1',
        !!describeStreamingDisabled({ homeKitCameraActive: false }) && !describeStreamingDisabled({ homeKitCameraActive: true }));
    check('a value that could not be read is not mistaken for off',
        describeStreamingDisabled({ homeKitCameraActive: undefined, manuallyDisabled: null }) === undefined);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
