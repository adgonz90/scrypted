// HomeKit Controller: pairs HAP accessories directly into Scrypted.
//
// This is the opposite of the HomeKit plugin. That one publishes Scrypted devices to Apple Home;
// this one consumes a HomeKit accessory as a Scrypted device, so that the whole Scrypted pipeline
// - rebroadcast, detection, NVR, and the HomeKit plugin's own HKSV - can be applied to a camera
// that previously only spoke HAP.

import sdk, {
    AdoptDevice,
    Device,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceDiscovery,
    DeviceProvider,
    DiscoveredDevice,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
} from '@scrypted/sdk';
import { HomeKitCamera } from './camera-device';
import { HapClient } from './hap/client';
import { HapConnection } from './hap/connection';
import { DiscoveredAccessory, HapDiscovery } from './hap/discovery';
import { PairingData, pairSetup, pairVerify } from './hap/pairing';
import { describeDevice } from './describe-device';
import { HapAccessory } from './hap/types';
import { Category } from './hap/uuids';

const { deviceManager } = sdk;


export class HomeKitControllerProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceDiscovery, DeviceCreator, Settings {
    discovery = new HapDiscovery(this.console);
    private devices = new Map<string, HomeKitCamera>();
    // credentials for a camera that is being registered but whose storage does not exist yet.
    readonly pendingPairings = new Map<string, PairingData>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.discovery.start();
    }

    // ---------------------------------------------------------------------------------------
    // Discovery
    // ---------------------------------------------------------------------------------------

    async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
        if (scan)
            this.discovery.refresh();

        const paired = new Set(
            deviceManager.getNativeIds()
                .filter(nativeId => !!nativeId)
                .map(nativeId => deviceManager.getDeviceStorage(nativeId).getItem('accessoryId'))
                .filter(id => !!id),
        );

        return this.discovery.discovered
            .filter(accessory => isCamera(accessory))
            // ones this plugin already owns appear as real devices instead.
            .filter(accessory => !paired.has(accessory.id))
            .map(accessory => {
                const model = accessory.model || 'HomeKit camera';
                // The mDNS status flags say whether the accessory has been paired with anything.
                // An unavailable one will refuse pair setup, so say so before the attempt rather
                // than after it fails.
                const status = accessory.available
                    ? 'ready to pair'
                    : 'already paired to another controller - remove it from the Apple Home app, or factory reset it, before pairing here';

                return {
                    name: accessory.name,
                    nativeId: accessory.id,
                    type: accessory.category === Category.VIDEO_DOORBELL ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera,
                    description: `${model} at ${accessory.host} - ${status}`,
                    info: {
                        model,
                        ip: accessory.host,
                        serialNumber: accessory.id,
                        firmware: accessory.protocolVersion,
                    },
                    settings: [
                        {
                            key: 'setupCode',
                            title: 'Setup Code',
                            description: accessory.available
                                ? 'The eight digit HomeKit setup code from the accessory or its packaging, for example 031-45-154.'
                                : 'This camera reports that it is already paired and will refuse a new pairing until it is removed from the Apple Home app or factory reset.',
                        },
                    ],
                };
            });
    }

    async adoptDevice(adopt: AdoptDevice): Promise<string> {
        const accessory = this.discovery.find(adopt.nativeId);
        if (!accessory)
            throw new Error('that accessory is no longer visible on the network');

        return this.pairAndRegister(accessory.host, accessory.port, adopt.settings.setupCode?.toString(), accessory.name);
    }

    // ---------------------------------------------------------------------------------------
    // Manual creation
    // ---------------------------------------------------------------------------------------

    async getCreateDeviceSettings(): Promise<Setting[]> {
        const candidates = this.discovery.discovered.filter(accessory => isCamera(accessory));

        return [
            {
                key: 'accessory',
                title: 'Accessory',
                description: 'Choose a HomeKit camera found on the network, or pick Manual to enter an address.',
                choices: ['Manual', ...candidates.map(accessory => `${accessory.name} (${accessory.host})`)],
                value: candidates.length ? `${candidates[0].name} (${candidates[0].host})` : 'Manual',
            },
            {
                key: 'setupCode',
                title: 'Setup Code',
                description: 'The eight digit HomeKit setup code, for example 031-45-154. Found on the accessory, its packaging, or in its app.',
            },
            {
                key: 'host',
                title: 'Address',
                description: 'Only needed when adding manually: the accessory IP address.',
                placeholder: '192.168.1.50',
            },
            {
                key: 'port',
                title: 'Port',
                description: 'Only needed when adding manually, and only if the camera does not answer a direct query. '
                    + 'HomeKit accessories listen on an arbitrary port, so leave this empty and it will be looked up from the address above.',
                type: 'number',
                placeholder: 'found automatically',
            },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const selection = settings.accessory?.toString();
        const setupCode = settings.setupCode?.toString();

        if (selection && selection !== 'Manual') {
            const accessory = this.discovery.discovered.find(candidate => `${candidate.name} (${candidate.host})` === selection);
            if (!accessory)
                throw new Error('that accessory is no longer visible on the network');
            return this.pairAndRegister(accessory.host, accessory.port, setupCode, accessory.name);
        }

        const host = settings.host?.toString();
        if (!host)
            throw new Error('an address is required when adding an accessory manually');

        let port = parseInt(settings.port?.toString());
        let name = host;

        // A HAP accessory's port is arbitrary and published only over mDNS, so someone adding a
        // camera by address because multicast does not reach it cannot be expected to know the
        // port. Ask the host directly, which works over the unicast that does reach it.
        if (!port) {
            this.console.log(`asking ${host} directly for its HomeKit service`);
            try {
                const probed = await this.discovery.probe(host);
                port = probed.port;
                name = probed.name || host;
                this.console.log(`${host} published ${probed.name} on port ${port}`);
            }
            catch (e) {
                // Answering a direct query is optional, and some responders only ever answer to
                // the multicast group. Nothing else can discover the port, so ask for it.
                throw new Error(`${host} did not answer a direct query, so its HomeKit port could not be found: `
                    + `${(e as Error).message}. Enter the Port as well - it is shown by the accessory's own app, `
                    + 'or in a HomeKit setup QR code, and is rarely the default 51826.');
            }
        }

        return this.pairAndRegister(host, port, setupCode, name, true);
    }

    /**
     * Runs pair setup, then immediately opens a verified session to read the accessory's services
     * so the Scrypted device is registered with the right interfaces from the start.
     */
    private async pairAndRegister(host: string, port: number, setupCode: string, name: string, manual = false): Promise<string> {
        if (!setupCode)
            throw new Error('a HomeKit setup code is required');

        this.console.log(`pairing with ${host}:${port}`);

        let pairingData: PairingData;
        const setupConnection = new HapConnection(host, port, this.console);
        try {
            await setupConnection.connect();
            pairingData = await pairSetup(setupConnection, setupCode, this.console);
        }
        finally {
            setupConnection.destroy();
        }

        // read the service graph over a verified session to work out what this accessory is.
        const client = new HapClient(host, port, pairingData, this.console);
        let accessory: HapAccessory;
        try {
            await client.ensureConnected();
            const accessories = await client.getAccessories();
            accessory = accessories.accessories[0];
            if (!accessory)
                throw new Error('accessory returned an empty database after pairing');
        }
        finally {
            client.stop();
        }

        const discovered = this.discovery.find(pairingData.accessoryPairingId);
        const nativeId = pairingData.accessoryPairingId;

        const device = describeDevice(accessory, discovered?.category ?? Category.IP_CAMERA, name, nativeId);

        // Announcing the device makes Scrypted call getDevice straight away, which constructs the
        // camera and starts it connecting - before storage has been written, since storage is only
        // addressable once the device exists. Park the credentials here first so that first
        // construction finds them instead of reporting the camera as unpaired.
        this.pendingPairings.set(nativeId, pairingData);

        try {
            await deviceManager.onDeviceDiscovered(device);

            const storage = deviceManager.getDeviceStorage(nativeId);
            storage.setItem('pairingData', JSON.stringify(pairingData));
            storage.setItem('accessoryId', pairingData.accessoryPairingId);

            // Remember where it answered. Without this a camera has nothing to fall back on until
            // it has connected once, and the first startup after pairing waits out the whole mDNS
            // timeout before failing - which for an accessory multicast cannot reach is every
            // startup, not just the first.
            storage.setItem('lastKnownHost', host);
            storage.setItem('lastKnownPort', String(port));

            // Added by address, which is what someone does when discovery cannot see it. Pin the
            // address rather than making every start wait for an announcement that will not come;
            // it is editable afterwards as Address Override.
            if (manual) {
                storage.setItem('host', host);
                storage.setItem('port', String(port));
            }
        }
        finally {
            this.pendingPairings.delete(nativeId);
        }

        this.console.log(`paired ${name} as ${device.type} with interfaces: ${device.interfaces.join(', ')}`);

        // drop any cached instance so it reinitializes against the new pairing.
        this.devices.get(nativeId)?.release().catch(() => { });
        this.devices.delete(nativeId);

        return deviceManager.getDeviceState(nativeId)?.id;
    }

    // ---------------------------------------------------------------------------------------
    // DeviceProvider
    // ---------------------------------------------------------------------------------------

    async getDevice(nativeId: string) {
        if (!this.devices.has(nativeId))
            this.devices.set(nativeId, new HomeKitCamera(this, nativeId));
        return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        const device = this.devices.get(nativeId);
        this.devices.delete(nativeId);

        // Unpair from the accessory on the way out, so it returns to an unpaired state and can be
        // added again later. Skipping this would leave the camera holding a pairing for a
        // controller that no longer exists, and HAP refuses a new pair-setup until it is reset.
        if (device && !await device.unpair()) {
            this.log.a(`${nativeId} was removed, but could not be reached to clear its pairing. `
                + 'Factory reset the camera before pairing it again.');
        }
    }

    // ---------------------------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------------------------

    /** The cameras this plugin has paired, read from their persisted credentials. */
    private pairedCameras(): { nativeId: string, name: string, accessoryId: string, address: string }[] {
        return deviceManager.getNativeIds()
            .filter(nativeId => !!nativeId)
            .map(nativeId => {
                const storage = deviceManager.getDeviceStorage(nativeId);
                const accessoryId = storage.getItem('accessoryId');
                if (!accessoryId)
                    return undefined;

                // prefer where it is right now, then where it last answered.
                const live = this.discovery.find(accessoryId);
                const host = storage.getItem('host') || live?.host || storage.getItem('lastKnownHost');
                const port = storage.getItem('port') || live?.port || storage.getItem('lastKnownPort');

                return {
                    nativeId,
                    name: deviceManager.getDeviceState(nativeId)?.name || accessoryId,
                    accessoryId,
                    address: host ? `${host}:${port || 5051}` : 'unknown',
                };
            })
            .filter(camera => !!camera);
    }

    async getSettings(): Promise<Setting[]> {
        const settings: Setting[] = [];

        for (const camera of this.pairedCameras()) {
            const group = `Paired: ${camera.name}`;
            settings.push(
                {
                    group,
                    key: `accessoryId:${camera.nativeId}`,
                    title: 'Accessory ID',
                    value: camera.accessoryId,
                    readonly: true,
                },
                {
                    group,
                    key: `address:${camera.nativeId}`,
                    title: 'Address',
                    description: this.discovery.find(camera.accessoryId)
                        ? 'Currently visible on the network.'
                        : 'Not currently announcing itself; this is where it last answered.',
                    value: camera.address,
                    readonly: true,
                },
                {
                    group,
                    key: `unpair:${camera.nativeId}`,
                    title: 'Unpair',
                    description: 'Removes this controller from the camera and deletes it from Scrypted, leaving the camera free to pair again. '
                        + 'If the camera cannot be reached, it is still removed here, but the camera itself will need a factory reset before it will accept a new pairing.',
                    type: 'button',
                },
            );
        }

        if (!settings.length) {
            settings.push({
                key: 'noCameras',
                title: 'No Cameras Paired',
                description: 'Use Add Device to pair a HomeKit camera. A camera already in the Apple Home app must be removed there, or factory reset, before it will accept pairing here: HomeKit accessories accept exactly one pair setup.',
                value: '',
                readonly: true,
            });
        }

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [action, nativeId] = key.split(':');
        if (action === 'unpair' && nativeId) {
            await this.unpairCamera(nativeId);
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }

        this.storage.setItem(key, value?.toString());
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    /**
     * Removes a camera: the pairing from the accessory where possible, then the Scrypted device.
     * Deleting the device in the Scrypted UI does the same thing through releaseDevice.
     */
    private async unpairCamera(nativeId: string): Promise<void> {
        const name = deviceManager.getDeviceState(nativeId)?.name || nativeId;
        const device = this.devices.get(nativeId) || await this.getDevice(nativeId);

        const removed = await device?.unpair();
        if (removed)
            this.console.log(`unpaired ${name}; the camera is free to pair again`);
        else
            this.log.a(`${name} was removed from Scrypted, but could not be reached to clear its pairing. Factory reset the camera before pairing it again.`);

        this.devices.delete(nativeId);
        await deviceManager.onDeviceRemoved(nativeId);
    }
}

function isCamera(accessory: DiscoveredAccessory): boolean {
    return accessory.category === Category.IP_CAMERA || accessory.category === Category.VIDEO_DOORBELL;
}

export default HomeKitControllerProvider;
