// HAP TLV8 encoding, per HomeKit Accessory Protocol Specification chapter 14.
//
// Every item is type(1) length(1) value(length). Two rules make decoding subtle:
//
//   - A value longer than 255 bytes is split across consecutive items sharing the same type. A
//     following item is a continuation *only* if the preceding one was exactly 255 bytes long,
//     which is what distinguishes a fragmented value from a repeated one.
//   - Entries of a list are separated by a zero length item of type 0x00.
//
// Both rules were verified against hap-nodejs's encoder output from a real camera accessory.

// An empty TLV of type 0 delimits entries in a list.
export const TLV_DELIMITER = 0x00;

const MAX_FRAGMENT = 255;

export interface TlvItem {
    type: number;
    value: Buffer;
}

export function encode(type: number, data: Buffer | number | string): Buffer {
    let buffer: Buffer;
    if (typeof data === 'number')
        buffer = Buffer.from([data]);
    else if (typeof data === 'string')
        buffer = Buffer.from(data, 'utf8');
    else
        buffer = data;

    // a zero length value is legal and must still emit a header.
    if (!buffer.length)
        return Buffer.from([type, 0]);

    const fragments: Buffer[] = [];
    for (let offset = 0; offset < buffer.length; offset += MAX_FRAGMENT) {
        const chunk = buffer.subarray(offset, offset + MAX_FRAGMENT);
        fragments.push(Buffer.from([type, chunk.length]), chunk);
    }
    return Buffer.concat(fragments);
}

/** Encodes [type, value, type, value, ...]. Order is preserved; some accessories depend on it. */
export function encodeAll(...args: (number | Buffer | string)[]): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i < args.length; i += 2)
        parts.push(encode(args[i] as number, args[i + 1] as Buffer));
    return Buffer.concat(parts);
}

/** Encodes one entry per value, separated by the list delimiter. */
export function encodeList(type: number, values: (Buffer | number | string)[]): Buffer {
    const parts: Buffer[] = [];
    values.forEach((value, index) => {
        if (index)
            parts.push(Buffer.from([TLV_DELIMITER, 0]));
        parts.push(encode(type, value));
    });
    return Buffer.concat(parts);
}

/**
 * The core parser. Returns items in wire order with fragmented values already reassembled, and
 * with the list delimiters preserved so callers that care about grouping can still see them.
 */
export function parseItems(buffer: Buffer): TlvItem[] {
    const items: TlvItem[] = [];
    let offset = 0;
    // length of the previous item, used to decide whether a repeat is a continuation.
    let previousType = -1;
    let previousLength = -1;

    while (offset + 2 <= buffer.length) {
        const type = buffer[offset];
        const length = buffer[offset + 1];
        const value = buffer.subarray(offset + 2, offset + 2 + length);
        offset += 2 + length;

        // a value is only continued if the item before it filled a whole fragment.
        if (type === previousType && previousLength === MAX_FRAGMENT && items.length) {
            const last = items[items.length - 1];
            last.value = Buffer.concat([last.value, value]);
        }
        else {
            items.push({ type, value });
        }

        previousType = type;
        previousLength = length;
    }

    return items;
}

/**
 * Flattens to one value per type, keeping the first occurrence. Use for TLV objects where each
 * type appears once, which is every pairing message and most camera sub-objects.
 */
export function decode(buffer: Buffer): Record<number, Buffer> {
    const result: Record<number, Buffer> = {};
    for (const item of parseItems(buffer)) {
        if (item.type === TLV_DELIMITER)
            continue;
        if (result[item.type] === undefined)
            result[item.type] = item.value;
    }
    return result;
}

/**
 * Collects every occurrence of each type. This is the right decoder for the camera configuration
 * characteristics, where a type such as the video attributes repeats once per supported
 * resolution, separated by delimiters.
 */
export function decodeWithLists(buffer: Buffer): Record<number, Buffer[]> {
    const result: Record<number, Buffer[]> = {};
    for (const item of parseItems(buffer)) {
        if (item.type === TLV_DELIMITER)
            continue;
        (result[item.type] ||= []).push(item.value);
    }
    return result;
}

// HAP integers on the wire are little endian and may be shorter than their nominal width.
export function readUIntLE(buffer: Buffer, defaultValue?: number): number {
    if (!buffer?.length)
        return defaultValue;
    const padded = Buffer.alloc(4);
    buffer.copy(padded, 0, 0, Math.min(4, buffer.length));
    return padded.readUInt32LE(0);
}

export function readUInt8(buffer: Buffer, defaultValue?: number): number {
    if (!buffer?.length)
        return defaultValue;
    return buffer.readUInt8(0);
}

export function writeUInt16LE(value: number): Buffer {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value, 0);
    return buffer;
}

export function writeUInt32LE(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    return buffer;
}
