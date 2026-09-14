// What a receiver report is supposed to contain.
//
// RTCP receiver reports are how a sender learns what is actually getting through. A camera that
// encodes to a bitrate ceiling uses them to decide whether to back off, and one told it is losing
// nothing has no reason to - so a controller that reports zeroes turns recoverable congestion into
// a stream that drops fragments forever. The symptom is video that freezes for a second or two at
// a time while the log fills with missing fragmentation units.
//
// The arithmetic is RFC 3550 appendix A.1, A.3 and A.8, which is fiddly enough in the sequence
// wrapping and the per interval fraction to be worth keeping apart from the session and testing on
// its own.

/** Half the sequence space; a jump larger than this is a wrap rather than a leap forward. */
const RTP_SEQ_MOD = 0x10000;

export interface ReceiverReportFields {
    /** The extended highest sequence number, cycles in the top 16 bits. */
    highestSequence: number;
    /** Loss over the interval since the last report, as a fraction in 1/256ths. */
    fractionLost: number;
    /** Cumulative packets lost since the stream began, which RFC 3550 caps at 24 signed bits. */
    packetsLost: number;
    /** Interarrival jitter, in the stream's own timestamp units. */
    jitter: number;
}

export class ReceptionStats {
    private started = false;
    private baseSequence = 0;
    private maxSequence = 0;
    private cycles = 0;
    private received = 0;

    // what the previous report saw, which is what makes the fraction per interval rather than
    // cumulative.
    private expectedPrior = 0;
    private receivedPrior = 0;

    // jitter needs the previous packet's transit time, in timestamp units.
    private jitterEstimate = 0;
    private lastTransit: number;

    /** @param clockRate the stream's RTP clock, 90000 for video and the sample rate for audio. */
    constructor(private clockRate: number) {
    }

    get packetsReceived(): number {
        return this.received;
    }

    /** Total packets lost since the stream began. */
    get packetsLost(): number {
        return this.expected - this.received;
    }

    private get extendedMax(): number {
        return this.cycles + this.maxSequence;
    }

    private get expected(): number {
        // Nothing is expected before the first packet establishes where the stream began. Without
        // this, the very first report - which is sent as soon as the session starts, deliberately,
        // so the accessory sees us before its own timeout - computes one expected packet and zero
        // received, and tells the camera it is losing everything. A camera that adapts to loss then
        // slashes its bitrate at the moment the stream opens.
        if (!this.started)
            return 0;
        return this.extendedMax - this.baseSequence + 1;
    }

    /**
     * Records one received packet.
     *
     * @param sequenceNumber the packet's 16 bit RTP sequence number
     * @param rtpTimestamp the packet's RTP timestamp
     * @param arrival when it arrived, in milliseconds
     */
    receive(sequenceNumber: number, rtpTimestamp: number, arrival = Date.now()): void {
        if (!this.started) {
            this.started = true;
            this.baseSequence = sequenceNumber;
            this.maxSequence = sequenceNumber;
        }
        else {
            const delta = (sequenceNumber - this.maxSequence) & 0xffff;
            // Forward, including across a wrap: the masked delta is small. A large masked delta is
            // a packet arriving out of order, which is not a wrap and must not advance the count.
            if (delta < RTP_SEQ_MOD / 2) {
                if (sequenceNumber < this.maxSequence)
                    this.cycles += RTP_SEQ_MOD;
                this.maxSequence = sequenceNumber;
            }
        }

        this.received++;

        // RFC 3550 A.8. Transit is arrival minus the sender's timestamp, both in RTP units; the
        // difference between successive transits is the jitter contribution.
        const arrivalTicks = Math.round(arrival * this.clockRate / 1000);
        const transit = arrivalTicks - rtpTimestamp;
        if (this.lastTransit !== undefined) {
            let d = transit - this.lastTransit;
            if (d < 0)
                d = -d;
            this.jitterEstimate += (d - this.jitterEstimate) / 16;
        }
        this.lastTransit = transit;
    }

    /**
     * The fields for one receiver report, and starts a new interval.
     *
     * Calling this is what makes the next fraction cover the time since this call, so it belongs
     * to sending a report rather than to inspecting the stream.
     */
    report(): ReceiverReportFields {
        const expected = this.expected;
        const expectedInterval = expected - this.expectedPrior;
        const receivedInterval = this.received - this.receivedPrior;
        this.expectedPrior = expected;
        this.receivedPrior = this.received;

        const lostInterval = expectedInterval - receivedInterval;
        const fractionLost = expectedInterval <= 0 || lostInterval <= 0
            ? 0
            : Math.min(255, Math.floor((lostInterval << 8) / expectedInterval));

        // the field is 24 bits signed, and saturates rather than wrapping.
        const cumulative = Math.max(-0x800000, Math.min(0x7fffff, this.packetsLost));

        return {
            highestSequence: this.extendedMax,
            fractionLost,
            packetsLost: cumulative,
            jitter: Math.floor(this.jitterEstimate),
        };
    }
}
