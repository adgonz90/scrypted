// Receiver report arithmetic, RFC 3550 appendix A.
//
// This drives real behaviour rather than only a log line: a camera encoding to a bitrate ceiling
// decides whether to back off from what these reports say, so getting the fraction or the sequence
// wrapping wrong either hides congestion from it or invents congestion that is not there. Neither
// shows up as an error anywhere, which is why it is worth testing directly.

const path = require('path');

const OUT = path.resolve(__dirname, '../tsout');
const { ReceptionStats } = require(path.join(OUT, 'camera/reception-stats.js'));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok)
        failures++;
};

/** Feeds a run of sequence numbers, skipping the ones listed as lost. */
function feed(stats, from, count, lost = new Set()) {
    for (let i = 0; i < count; i++) {
        const sequence = (from + i) & 0xffff;
        if (lost.has(sequence))
            continue;
        // 90kHz video at 30fps: one frame every 3000 ticks, arriving in real time.
        stats.receive(sequence, i * 3000, i * 33);
    }
}

// ---- before a single packet has arrived ---------------------------------------------------------
{
    // The first receiver report goes out as soon as the session starts, deliberately, so the
    // accessory sees the controller before its own timeout - and that is before any video has had
    // time to arrive. Counting one packet expected and none received there tells the camera it is
    // losing everything at the moment the stream opens, which a camera that adapts to loss acts on.
    const stats = new ReceptionStats(90000);
    const report = stats.report();
    check('a report before the first packet claims no loss',
        report.fractionLost === 0 && report.packetsLost === 0, JSON.stringify(report));

    // and the stream that follows is still measured from where it really began.
    feed(stats, 5000, 50);
    const after = stats.report();
    check('and the stream that follows is still measured from its own first packet',
        after.fractionLost === 0 && after.packetsLost === 0 && after.highestSequence === 5049,
        JSON.stringify(after));
}

// ---- a clean stream reports nothing lost -------------------------------------------------------
{
    const stats = new ReceptionStats(90000);
    feed(stats, 1000, 100);
    const report = stats.report();
    check('a clean stream reports no loss', report.fractionLost === 0 && report.packetsLost === 0,
        JSON.stringify(report));
    check('and the highest sequence it actually saw', report.highestSequence === 1099, `${report.highestSequence}`);
}

// ---- loss is reported as a fraction of the interval, not of the stream --------------------------
{
    const stats = new ReceptionStats(90000);

    // a clean first interval.
    feed(stats, 0, 200);
    check('the first interval is clean', stats.report().fractionLost === 0);

    // then a quarter of the next hundred goes missing.
    const lost = new Set();
    for (let i = 0; i < 25; i++)
        lost.add(200 + i * 4);
    feed(stats, 200, 100, lost);

    const report = stats.report();
    // 25 of 100 is 25%, which in 1/256ths is 64.
    check('loss is reported as a fraction of the interval in 1/256ths',
        Math.abs(report.fractionLost - 64) <= 1, `${report.fractionLost}, expected ~64`);
    check('and cumulatively as a packet count', report.packetsLost === 25, `${report.packetsLost}`);

    // a clean interval afterwards must read as clean, even though the stream has lost packets.
    feed(stats, 300, 100);
    const after = stats.report();
    check('a clean interval after a lossy one reports no loss', after.fractionLost === 0, `${after.fractionLost}`);
    check('while the cumulative count still remembers', after.packetsLost === 25, `${after.packetsLost}`);
}

// ---- the sequence number wraps, and that is not a hundred thousand lost packets -----------------
{
    const stats = new ReceptionStats(90000);
    feed(stats, 65500, 100);

    const report = stats.report();
    // 65500..65535 then 0..63: 100 packets, no loss, and the extended sequence has one cycle.
    check('a sequence wrap is a wrap, not a gap', report.packetsLost === 0, `${report.packetsLost}`);
    check('and the extended highest sequence carries the cycle count',
        report.highestSequence === 0x10000 + 63, `${report.highestSequence}`);
}

// ---- a packet arriving late must not advance the sequence, nor count as loss --------------------
{
    const stats = new ReceptionStats(90000);
    feed(stats, 1000, 50);
    // 1049 has already been seen; 1020 turns up afterwards, reordered.
    stats.receive(1020, 20 * 3000, 1700);

    const report = stats.report();
    check('a reordered packet does not drag the highest sequence backwards',
        report.highestSequence === 1049, `${report.highestSequence}`);
    check('and is counted as received, not lost', report.packetsLost === -1,
        `${report.packetsLost} (one more received than expected, which is what RFC 3550 says a duplicate looks like)`);
}

// ---- jitter is zero on a perfectly paced stream and rises when it is not ------------------------
{
    const steady = new ReceptionStats(90000);
    for (let i = 0; i < 100; i++)
        steady.receive(i, i * 3000, i * 33.3333);
    check('a perfectly paced stream has almost no jitter', steady.report().jitter <= 2,
        `${steady.report().jitter}`);

    const bursty = new ReceptionStats(90000);
    for (let i = 0; i < 100; i++)
        // every third packet arrives 40ms late.
        bursty.receive(i, i * 3000, i * 33.3333 + (i % 3 === 0 ? 40 : 0));
    check('a bursty one does not', bursty.report().jitter > 100, `${bursty.report().jitter}`);
}

// ---- the cumulative field saturates rather than wrapping ----------------------------------------
{
    const stats = new ReceptionStats(90000);
    stats.receive(0, 0, 0);
    // a single packet twenty million sequence numbers later, which is more loss than the 24 bit
    // field can hold.
    for (let cycle = 0; cycle < 400; cycle++)
        stats.receive((cycle * 40000) & 0xffff, cycle * 3000, cycle * 33);
    const report = stats.report();
    check('the cumulative loss field saturates rather than wrapping',
        report.packetsLost <= 0x7fffff && report.packetsLost > 0, `${report.packetsLost}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
