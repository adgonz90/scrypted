// A stand-in for @scrypted/sdk, so the pure parts of this plugin can be tested with plain node.
//
// The real SDK entry point needs generated sources that only exist after building sdk/types, and
// pulls in the plugin runtime besides. Nothing under test here needs either: discoverControls is
// pure logic over a HAP accessory graph, and the camera device only reaches the SDK for string
// enums, a device state bag, and the two managers.
//
// ScryptedDeviceType and ScryptedInterface are identity mapped string enums - ScryptedInterface
// .OnOff === 'OnOff', ScryptedDeviceType.Light === 'Light', and so on (verified against
// sdk/types/dist/index.d.ts) - so a proxy returning the key is exactly faithful, and assertions
// made against it are assertions against the strings Scrypted really compares.

const identity = new Proxy({}, {
    get: (_target, key) => typeof key === 'string' ? key : undefined,
    has: () => true,
});

// Device storage, kept outside the device so a test can seed it before construction. The real
// ScryptedDeviceBase reads storage during its constructor chain, and so does this plugin: a camera
// fetches its pairing the moment it is created.
const storages = new Map();

function storageFor(nativeId) {
    if (!storages.has(nativeId)) {
        const items = new Map();
        storages.set(nativeId, {
            getItem: key => items.has(key) ? items.get(key) : null,
            setItem: (key, value) => items.set(key, String(value)),
            removeItem: key => items.delete(key),
            clear: () => items.clear(),
            key: index => [...items.keys()][index],
            get length() { return items.size; },
        });
    }
    return storages.get(nativeId);
}

// Scrypted's device properties are setters that publish state. Here they are plain fields, which
// is what a test wants to assert against; onDeviceEvent is a no-op for the same reason.
class ScryptedDeviceBase {
    constructor(nativeId) {
        this.nativeId = nativeId;
    }

    get storage() {
        return storageFor(this.nativeId);
    }

    get console() {
        return console;
    }

    async onDeviceEvent() {
    }
}

// Records what the plugin published, so a test can assert on the device it announced.
const discovered = [];
const changed = [];

const deviceManager = {
    onDeviceDiscovered: async device => { discovered.push(device); },
    onDevicesChanged: async devices => { changed.push(devices); },
    onDeviceRemoved: async () => { },
    getDeviceState: () => ({}),
    getDeviceStorage: nativeId => storageFor(nativeId),
};

const mediaManager = {
    createMediaObject: async (data, mimeType) => ({ data, mimeType }),
    convertMediaObjectToBuffer: async mediaObject => mediaObject.data,
    getFFmpegPath: async () => 'ffmpeg',
};

module.exports = {
    __esModule: true,
    default: { deviceManager, mediaManager },
    __storage: storageFor,
    __discovered: discovered,
    __changed: changed,
    ScryptedDeviceBase,
    ScryptedDeviceType: identity,
    ScryptedInterface: identity,
    AirQuality: identity,
    // not identity mapped in the real SDK, so spelled out; the strings are what Scrypted stores.
    ChargeState: { Trickle: 'trickle', Charging: 'charging', NotCharging: 'not-charging' },
    TemperatureUnit: { C: 'C', F: 'F' },
    ScryptedMimeTypes: identity,
};
