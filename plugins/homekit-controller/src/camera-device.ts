// A paired HAP camera, presented to Scrypted as an ordinary camera device.
//
// The important integration detail is MotionSensor: Scrypted's HomeKit plugin enables HomeKit
// Secure Video for a camera purely on the presence of that interface, so subscribing to the
// accessory's own motion characteristic is what makes HKSV work end to end.

import { addTrackControls, parseSdp } from '@scrypted/common/src/sdp-utils';
import { listenSingleRtspClient } from '@scrypted/common/src/rtsp-server';
import sdk, {
    AirQuality,
    AirQualitySensor,
    AmbientLightSensor,
    Battery,
    BinarySensor,
    Camera,
    ChargeState,
    Charger,
    HumiditySensor,
    OccupancySensor,
    Thermometer,
    TemperatureUnit,
    DeviceInformation,
    DeviceProvider,
    FFmpegInput,
    Intercom,
    MediaObject,
    MediaStreamFeedback,
    MotionSensor,
    Online,
    PictureOptions,
    RequestMediaStreamOptions,
    ResponseMediaStreamOptions,
    ScryptedDeviceBase,
    ScryptedInterface,
    ScryptedMimeTypes,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
} from '@scrypted/sdk';
import child_process from 'child_process';
import dgram from 'dgram';
import { findCharacteristic, findService, findServices, getCharacteristicValue, HapClient } from './hap/client';
import { HapAccessory, HapCharacteristic, HapService, AudioCodecType, StreamingStatus, StreamingStatusTLV } from './hap/types';
import * as tlv from './hap/tlv';
import { Category, Characteristic, characteristicName, Service, serviceName } from './hap/uuids';
import { createDebugConsole, DebugConsole } from './logger';
import { describeNaluTypes } from './camera/h264';
import { createStreamSdp } from './camera/sdp';
import { CENSUS_INTERVAL_MS, StreamTelemetry } from './camera/stream-telemetry';
import {
    audioCodecName,
    bestProfile,
    chooseAudioCodec,
    describeCapabilities,
    exceedsAdvertisedLevel,
    largestResolution,
    advertisedLevelFor,
    nearestResolution,
    parseSupportedAudioStreamConfiguration,
    parseSupportedRTPConfiguration,
    parseSupportedVideoStreamConfiguration,
    samplerateToHz,
    StreamCapabilities,
    unionCapabilities,
    VideoResolution,
} from './camera/stream-config';
import { AUDIO_MAX_BITRATE_KBPS, AUDIO_PACKET_TIME_MS, AUDIO_PAYLOAD_TYPE, HapStreamSession } from './camera/stream-session';
import { describeStreamingDisabled, StreamRecovery } from './camera/stream-recovery';
import { ControlDescriptor, discoverControls, HomeKitCameraControl, seedControl } from './camera-controls';
import { describeDevice } from './describe-device';
import type { HomeKitControllerProvider } from './main';

const { deviceManager, mediaManager } = sdk;

/** A stream running now, and what it actually negotiated. */
interface ActiveStream {
    // the advertised stream this session is serving; at most one session per stream.
    optionId: string;
    serviceIndex: number;
    serviceIid: number;
    resolution: VideoResolution;
    audio?: string;
    since: number;
}

interface StreamServiceState {
    service: HapService;
    // this service's own advertised codecs and sizes, which need not match its siblings'.
    capabilities: StreamCapabilities;
    // held by a session of ours.
    inUse: boolean;
    // what the camera last said about this service, for reporting only. Availability is always
    // re-read when a stream starts, since a service the camera was holding may since be free.
    observedAvailable?: boolean;
}

// HAP's ChargingState: 0 not charging, 1 charging, 2 not chargeable.
const HAP_CHARGE_STATE: Record<number, ChargeState> = {
    0: ChargeState.NotCharging,
    1: ChargeState.Charging,
    2: ChargeState.NotCharging,
};

/** A sensor reading rounded to `decimals` places; anything that is not a finite number passes through. */
export function roundReading(value: any, decimals: number): any {
    if (typeof value !== 'number' || !isFinite(value))
        return value;
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

// HAP's AirQuality characteristic is an ordinal 0-5 that lines up with Scrypted's enum.
const HAP_AIR_QUALITY: Record<number, AirQuality> = {
    0: AirQuality.Unknown,
    1: AirQuality.Excellent,
    2: AirQuality.Good,
    3: AirQuality.Fair,
    4: AirQuality.Inferior,
    5: AirQuality.Poor,
};

/**
 * How often a characteristic that has never pushed an event is re-read.
 *
 * HAP gives a controller no way to confirm a subscription: the accessory returns success and then
 * either sends events or does not, and camera firmware that quietly does not is common enough to
 * be worth covering. Silence is the only symptom, and it is indistinguishable from a sensor that
 * simply has nothing to report, so the cover has to be a poll.
 *
 * It stops per characteristic the moment that characteristic pushes anything, so an accessory
 * that behaves pays for one round of reads and nothing afterwards.
 */
const SENSOR_POLL_MS = 10000;

/**
 * How long to let an accessory settle between tearing a stream session down and building another.
 *
 * Rebroadcast restarts its prebuffer whenever a stream stops producing, and each restart replaces
 * the session under it, so a camera that is failing to stream gets a teardown and a setup every
 * few seconds. Embedded HAP firmware does not all survive that: one doorbell answered three cycles
 * and then rebooted. The pause costs nothing on a camera that is working, because a working stream
 * is not being replaced.
 */
const SESSION_SETTLE_MS = 750;

/** How long motion may stay on before it stops being plausible as something alive. */
const STUCK_MOTION_MINUTES = 30;

/**
 * A start-up that was abandoned because something replaced the camera underneath it.
 *
 * Distinct from a failure: reinitialize does exactly this on purpose whenever the camera announces
 * a new address, so reporting it as an error would make a working reconnection look broken.
 */
class SupersededError extends Error { }

export class HomeKitCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, BinarySensor, DeviceProvider,
    Battery, Charger, Online, Settings, Intercom, Thermometer, HumiditySensor, AirQualitySensor, AmbientLightSensor, OccupancySensor {
    client: HapClient;
    accessory: HapAccessory;
    capabilities: StreamCapabilities;

    private streamServices: StreamServiceState[] = [];
    // active streams, with what each actually negotiated, for the settings page.
    private sessions = new Map<HapStreamSession, ActiveStream>();
    private characteristicHandlers = new Map<number, (value: any) => void>();
    // everything worth re-reading when the accessory does not push, and what it last said.
    private pollableCharacteristics: { aid: number, iid: number }[] = [];
    private pushedCharacteristics = new Set<number>();
    private polledValues = new Map<number, any>();
    private sensorPollTimer: NodeJS.Timeout;
    private motionClearTimer: NodeJS.Timeout;
    private stuckMotionTimer: NodeJS.Timeout;
    private motionOnSince: number;
    /**
     * What to do about a camera refusing every stream configuration, and when it may be asked again.
     *
     * A consumer that wants a stream retries until it gets one - Rebroadcast restarts its prebuffer
     * every five seconds - and each attempt is a full SetupEndpoints plus a write per configuration.
     * Against a camera that is refusing, that is a few hundred pointless exchanges an hour with the
     * accessory least able to absorb them.
     */
    private streamRecovery = new StreamRecovery();
    private polling = false;
    private controlDescriptors = new Map<string, ControlDescriptor>();
    private controls = new Map<string, HomeKitCameraControl>();
    // the stream configuration this camera last accepted, so renegotiation is not repeated.
    private negotiatedVariant: string;
    // where the current client is pointed, so an mDNS announcement of a move can be spotted.
    private currentAddress: { host: string, port: number };
    private initializing: Promise<void>;
    private initialized = false;
    private intercomProcess: child_process.ChildProcess;
    private intercomSocket: dgram.Socket;
    private intercomSession: HapStreamSession;
    private gatedConsole: DebugConsole;

    /**
     * The device console, with `debug` gated on the Debug Logging setting.
     *
     * Overriding the base getter rather than adding a second logger means every call site writes
     * to the same place, and choosing a level is the only decision: `log` for the handful of lines
     * that describe what the camera is doing, `debug` for the per stream and per packet detail
     * that is only wanted while something is being diagnosed.
     */
    get console(): DebugConsole {
        return this.gatedConsole ||= createDebugConsole(super.console, () => this.debugLogging);
    }

    /** Whether the verbose diagnostics are switched on for this camera. */
    get debugLogging(): boolean {
        return this.storage.getItem('debugLogging') === 'true';
    }

    constructor(public provider: HomeKitControllerProvider, nativeId: string) {
        super(nativeId);
        this.online = false;

        // A camera reached at a remembered address keeps working until its DHCP lease moves, at
        // which point only mDNS can say where it went. Following the announcement covers that, and
        // is also how a camera recovers when it was unreachable at startup.
        this.provider.discovery.on('accessory', accessory => {
            if (accessory.id !== this.accessoryId || !this.currentAddress)
                return;
            if (accessory.host === this.currentAddress.host && accessory.port === this.currentAddress.port)
                return;
            this.console.log(`camera announced a new address, ${accessory.host}:${accessory.port}; reconnecting`);
            this.reinitialize();
        });

        this.initialize()
            .catch(e => this.reportStartupError('failed to initialize HomeKit camera', e));
    }

    /** Tears the connection down and builds a new one, re-resolving the address. */
    private reinitialize() {
        this.release()
            .then(() => this.initialize())
            .catch(e => this.reportStartupError('failed to reconnect', e));
    }

    /** A start-up abandoned for a newer one is routine; anything else is a fault. */
    private reportStartupError(what: string, e: Error) {
        if (e instanceof SupersededError)
            this.console.log(e.message);
        else
            this.console.error(what, e);
    }

    get pairingData() {
        const raw = this.storage.getItem('pairingData');
        if (raw)
            return JSON.parse(raw);
        // during the first moments after pairing the device exists but its storage does not yet.
        return this.provider.pendingPairings.get(this.nativeId);
    }

    get accessoryId() {
        return this.storage.getItem('accessoryId') || this.pairingData?.accessoryPairingId;
    }

    /** The HAP accessory id (aid). Always 1 for a standalone camera. */
    private get aid() {
        return this.accessory?.aid ?? 1;
    }

    /**
     * Connects and reads the accessory graph exactly once. Every entry point calls this, so it has
     * to be idempotent and safe to call concurrently; a failed attempt is not cached, so a camera
     * that was offline at startup recovers on the next request.
     */
    async initialize(): Promise<void> {
        if (this.initialized)
            return;
        if (this.initializing)
            return this.initializing;

        this.initializing = this.doInitialize()
            .then(() => {
                this.initialized = true;
            })
            .finally(() => this.initializing = undefined);
        return this.initializing;
    }

    /**
     * Works out where to reach the camera.
     *
     * mDNS is preferred, because it is the only thing that tracks a camera whose DHCP address has
     * moved. It is not required, though: multicast does not reliably cross a VLAN boundary, and an
     * accessory only announces itself periodically, so a plugin restart can easily fall between
     * announcements. Since unicast to the address still works perfectly in that situation, the
     * address that last answered is remembered and used as a fallback rather than treating a
     * missed announcement as the camera being gone.
     */
    private async resolveAddress(): Promise<{ host: string, port: number, source: string }> {
        const configuredHost = this.storage.getItem('host');
        const configuredPort = parseInt(this.storage.getItem('port'));
        if (configuredHost) {
            return { host: configuredHost, port: configuredPort || 5051, source: 'the configured address' };
        }

        // already heard on this run: no waiting required.
        const known = this.provider.discovery.find(this.accessoryId);
        if (known)
            return { host: known.host, port: known.port, source: 'mDNS' };

        const lastHost = this.storage.getItem('lastKnownHost');
        const lastPort = parseInt(this.storage.getItem('lastKnownPort'));

        try {
            // a short wait, because a usable fallback usually exists.
            const discovered = await this.provider.discovery.resolve(this.accessoryId, lastHost ? 5000 : 15000);
            return { host: discovered.host, port: discovered.port, source: 'mDNS' };
        }
        catch (e) {
            if (!lastHost)
                throw e;
            this.console.warn(`mDNS did not answer for ${this.accessoryId}; using the address that last worked, ${lastHost}:${lastPort}`);
            return { host: lastHost, port: lastPort || 5051, source: 'the last known address' };
        }
    }

    private async doInitialize() {
        const pairingData = this.pairingData;
        if (!pairingData)
            throw new Error('this camera has no HomeKit pairing; remove and re-add it');

        const address = await this.resolveAddress();
        this.currentAddress = { host: address.host, port: address.port };

        this.client?.stop();
        const client = new HapClient(address.host, address.port, pairingData, this.console);
        this.client = client;

        client.on('connected', () => {
            this.online = true;
            // remember where it answered, so a later start does not depend on mDNS being heard.
            this.storage.setItem('lastKnownHost', address.host);
            this.storage.setItem('lastKnownPort', String(address.port));
            this.console.log(`connected to ${address.host}:${address.port} (via ${address.source})`);
        });
        client.on('disconnected', (e: Error) => {
            this.online = false;
            this.console.warn('disconnected from accessory', e?.message);
        });
        client.on('characteristic', event => this.onCharacteristicEvent(event));

        /**
         * Everything below runs across awaits, and release() can happen during any of them - a
         * device removed, the plugin unloading, or simply being re-added. It clears `this.client`,
         * so carrying on would either dereference nothing (which is how this surfaced: a
         * `getAccessories` of undefined) or, worse, finish setting up a camera that has been torn
         * down. Whoever replaced this client has already stopped it, so there is nothing to undo
         * here beyond stopping.
         */
        const superseded = () => this.client !== client;

        await client.ensureConnected();
        if (superseded())
            throw new SupersededError('this camera was released while it was connecting');

        const accessories = await client.getAccessories();
        if (superseded())
            throw new SupersededError('this camera was released while it was starting up');
        // a standalone camera publishes exactly one accessory.
        this.accessory = accessories.accessories[0];
        if (!this.accessory)
            throw new Error('accessory returned an empty database');

        this.dumpAccessory();

        await this.loadStreamCapabilities();
        await this.publishDeviceInfo();
        if (superseded())
            throw new SupersededError('this camera was released while it was being described');

        // Re-announce the device from the live service graph. Interfaces are otherwise frozen at
        // whatever the plugin understood on the day it was paired, so this is what lets a camera
        // pick up sensors and controls added by a later plugin version or a firmware update,
        // without having to unpair and pair it again.
        // the category is only known when mDNS has been heard; a doorbell is otherwise inferred
        // from the accessory's own services, which describeDevice already does.
        const category = this.provider.discovery.find(this.accessoryId)?.category ?? Category.IP_CAMERA;
        await deviceManager.onDeviceDiscovered(
            describeDevice(this.accessory, category, this.name || 'Camera', this.nativeId));

        await this.loadControls();
        if (superseded())
            throw new SupersededError('this camera was released while its controls were being published');

        await this.subscribeSensors();
    }

    /**
     * Publishes the accessory's non-streaming services as child devices.
     *
     * These are registered in their own onDevicesChanged call scoped by providerNativeId. That is
     * load bearing: the server only honours providerNativeId at the manifest level, so batching
     * children in with anything else silently reparents them onto the plugin instead of the
     * camera, and the HomeKit plugin's child merging (which walks getChildDevices) then cannot
     * find them.
     */
    private async loadControls() {
        const descriptors = discoverControls(this.accessory, this.nativeId, this.name || 'Camera');

        this.controlDescriptors = new Map(descriptors.map(descriptor => [descriptor.nativeId, descriptor]));

        await deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices: descriptors.map(descriptor => ({
                nativeId: descriptor.nativeId,
                name: descriptor.name,
                type: descriptor.type,
                interfaces: descriptor.interfaces,
            })),
        });

        // instantiate eagerly so the characteristic event routing below has somewhere to deliver.
        for (const descriptor of descriptors)
            await this.getDevice(descriptor.nativeId);

        if (descriptors.length)
            this.console.log(`exposed ${descriptors.length} accessory control(s): ${descriptors.map(d => d.name).join(', ')}`);
    }

    /**
     * Reads the advertised capabilities of every stream management service.
     *
     * Each service carries its own SupportedVideoStreamConfiguration, and HAP does not require
     * them to agree: a camera is free to offer full resolution on one and only a substream on
     * another. Reading one service's capabilities and then streaming on a different service is
     * how a perfectly formed request gets rejected as an invalid value, so each is read and
     * tracked separately, and a session always uses the capabilities of the service it runs on.
     */
    private async loadStreamCapabilities() {
        const services = findServices(this.accessory, Service.CameraRTPStreamManagement);
        if (!services.length)
            throw new Error('this accessory does not expose a camera stream');

        const readCapabilities = async (service: HapService): Promise<StreamCapabilities> => {
            const read = async (type: string) => {
                const characteristic = findCharacteristic(service, type);
                if (!characteristic)
                    throw new Error(`camera stream service is missing characteristic ${type}`);
                // the accessory database already carries the value; fall back to a read if absent.
                const value = typeof characteristic.value === 'string'
                    ? Buffer.from(characteristic.value, 'base64')
                    : await this.client.readTlvCharacteristic(this.aid, characteristic.iid);
                // raw bytes, so a camera that advertises something unexpected can be decoded by hand.
                this.console.debug(`service ${service.iid} ${type} = ${value.toString('hex')}`);
                return value;
            };

            return {
                video: parseSupportedVideoStreamConfiguration(await read(Characteristic.SupportedVideoStreamConfiguration)),
                audio: parseSupportedAudioStreamConfiguration(await read(Characteristic.SupportedAudioStreamConfiguration)),
                cryptoSuites: parseSupportedRTPConfiguration(await read(Characteristic.SupportedRTPConfiguration)),
            };
        };

        this.streamServices = [];
        for (const service of services) {
            const capabilities = await readCapabilities(service);
            this.streamServices.push({ service, capabilities, inUse: false });

            const index = this.streamServices.length - 1;
            this.console.log(`stream service #${index} (iid ${service.iid}): ${describeCapabilities(capabilities)}`);
            this.console.debug(`  H264 profiles: [${capabilities.video.profiles.join(', ')}], levels: [${capabilities.video.levels.join(', ')}], `
                + `packetization modes: [${capabilities.video.packetizationModes.join(', ')}], comfort noise: ${capabilities.audio.comfortNoise}`);
        }

        // What the camera can do overall, which is what Scrypted is offered. Any individual stream
        // is then served by a service that actually advertises the requested size.
        this.capabilities = unionCapabilities(this.streamServices.map(state => state.capabilities));

        const differ = this.streamServices.some(state =>
            state.capabilities.video.resolutions.length !== this.capabilities.video.resolutions.length);
        this.console.log(`camera supports ${this.streamServices.length} concurrent stream(s)`
            + (differ ? '; the stream services advertise DIFFERENT capabilities' : '; all stream services advertise the same capabilities'));
    }

    private async publishDeviceInfo() {
        const information = findService(this.accessory, Service.AccessoryInformation);
        if (!information)
            return;

        const info: DeviceInformation = {
            manufacturer: getCharacteristicValue(information, Characteristic.Manufacturer),
            model: getCharacteristicValue(information, Characteristic.Model),
            serialNumber: getCharacteristicValue(information, Characteristic.SerialNumber),
            firmware: getCharacteristicValue(information, Characteristic.FirmwareRevision),
            version: getCharacteristicValue(information, Characteristic.HardwareRevision),
        };
        this.info = info;
    }

    /**
     * Subscribes to every characteristic this device surfaces as a Scrypted property, and seeds
     * the current values so the device is correct before the first event arrives.
     */
    private async subscribeSensors() {
        const subscriptions: { aid: number, iid: number }[] = [];

        // what was actually subscribed, and what could not be, for the log.
        const subscribed: string[] = [];
        const cannotNotify: string[] = [];

        const bind = (service: HapService, type: string, apply: (value: any) => void) => {
            const characteristic = findCharacteristic(service, type);
            if (!characteristic)
                return;
            this.characteristicHandlers.set(characteristic.iid, apply);
            if (characteristic.value !== undefined && characteristic.value !== null)
                apply(characteristic.value);

            const name = `${characteristicName(type)} (iid ${characteristic.iid})`;
            this.pollableCharacteristics.push({ aid: this.aid, iid: characteristic.iid });
            this.polledValues.set(characteristic.iid, characteristic.value);

            // An accessory that does not advertise the notify permission accepts the subscription
            // and then simply never pushes anything, so the characteristic looks subscribed while
            // its value never moves. Saying so is the difference between a sensor that is broken
            // and one that was never going to work this way.
            if (characteristic.perms && !characteristic.perms.includes('ev')) {
                cannotNotify.push(name);
                return;
            }

            subscribed.push(name);
            subscriptions.push({ aid: this.aid, iid: characteristic.iid });
        };

        this.characteristicHandlers.clear();
        this.pollableCharacteristics = [];
        this.polledValues.clear();
        // Re-proved on every connection rather than remembered. A reconnect restores subscriptions
        // by rewriting them, and if that quietly failed, a characteristic still marked as one that
        // pushes would never be polled and would simply go silent.
        this.pushedCharacteristics.clear();

        const motion = findService(this.accessory, Service.MotionSensor);
        if (motion) {
            // HAP booleans arrive as 0 and 1 rather than false and true.
            bind(motion, Characteristic.MotionDetected, value => this.applyMotion(!!value));
        }

        const doorbell = findService(this.accessory, Service.Doorbell)
            || findService(this.accessory, Service.StatelessProgrammableSwitch);
        if (doorbell) {
            bind(doorbell, Characteristic.ProgrammableSwitchEvent, value => {
                // a stateless switch reports an event rather than a level; null means no event.
                if (value === null || value === undefined)
                    return;
                this.binaryState = true;
                setTimeout(() => this.binaryState = false, 3000);
            });
        }

        const battery = findService(this.accessory, Service.Battery);
        if (battery) {
            bind(battery, Characteristic.BatteryLevel, value => this.batteryLevel = value);
            // Charge state is not cosmetic here: Rebroadcast refuses to prebuffer a device that
            // reports a battery unless it also reports a charger and says it is charging, and no
            // prebuffer means no HomeKit Secure Video. Mains powered cameras with a backup battery
            // depend on this being reported accurately.
            bind(battery, Characteristic.ChargingState, value => this.chargeState = HAP_CHARGE_STATE[value]);
        }

        // Environmental sensors. Baby monitors in particular carry these, and Scrypted's HomeKit
        // plugin surfaces temperature and humidity as linked services on the camera accessory, so
        // they survive the round trip back into the Home app.
        //
        // Rounded before they are published. HAP carries these as 32-bit floats, so 41.4 arrives as
        // 41.400002, and a camera that reports in 0.1 steps changes on almost every reading. Each
        // change is an event to HomeKit, Home Assistant and every other listener, and a line in the
        // server log; Scrypted drops a property assignment that does not change the value, so
        // rounding is what stops the flood. Whole percent for humidity, which is what the Home
        // app shows and more precision than these sensors have. Tenths for temperature, because a
        // whole degree Celsius is nearly two Fahrenheit and too coarse for a nursery.
        const temperature = findService(this.accessory, Service.TemperatureSensor);
        if (temperature) {
            // HAP always reports Celsius, which is what Scrypted expects.
            bind(temperature, Characteristic.CurrentTemperature, value => this.temperature = roundReading(value, 1));
        }

        const humidity = findService(this.accessory, Service.HumiditySensor);
        if (humidity) {
            bind(humidity, Characteristic.CurrentRelativeHumidity, value => this.humidity = roundReading(value, 0));
        }

        const airQuality = findService(this.accessory, Service.AirQualitySensor);
        if (airQuality) {
            bind(airQuality, Characteristic.AirQuality, value => this.airQuality = HAP_AIR_QUALITY[value] || AirQuality.Unknown);
        }

        const light = findService(this.accessory, Service.LightSensor);
        if (light) {
            bind(light, Characteristic.CurrentAmbientLightLevel, value => this.ambientLight = value);
        }

        const occupancy = findService(this.accessory, Service.OccupancySensor);
        if (occupancy) {
            bind(occupancy, Characteristic.OccupancyDetected, value => this.occupied = !!value);
        }

        // child controls track their own characteristics through the same event channel.
        for (const control of this.controls.values()) {
            const { descriptor } = control;
            for (const ref of [descriptor.on, descriptor.brightness, descriptor.hue, descriptor.saturation, descriptor.volume]) {
                if (!ref)
                    continue;
                this.characteristicHandlers.set(ref.iid, value => control.apply(ref.iid, value));
                this.pollableCharacteristics.push({ aid: descriptor.aid, iid: ref.iid });
                this.polledValues.set(ref.iid, this.findCharacteristicByIid(ref.iid)?.value);
                subscribed.push(`${descriptor.name} ${characteristicName(this.findCharacteristicByIid(ref.iid)?.type)} (iid ${ref.iid})`);
                subscriptions.push({ aid: descriptor.aid, iid: ref.iid });
            }
        }

        // A sensor that cannot notify is worth a warning rather than a debug line: it is the
        // whole reason the corresponding Scrypted interface would sit there never firing.
        if (cannotNotify.length) {
            this.console.warn('the accessory does not offer event notifications for '
                + `${cannotNotify.join(', ')}; these will be polled instead`);
        }

        if (subscriptions.length) {
            try {
                await this.client.subscribe(subscriptions);
                this.console.log(`subscribed to ${subscriptions.length} characteristic event(s)`);
                this.console.debug(`subscribed: ${subscribed.join(', ')}`);
            }
            catch (e) {
                this.console.warn('failed to subscribe to characteristic events', e);
            }
        }

        this.startSensorPoll();
    }

    private startSensorPoll() {
        this.stopSensorPoll();
        if (!this.pollableCharacteristics.length)
            return;
        this.sensorPollTimer = setInterval(() => this.pollSensors().catch(e =>
            this.console.debug('sensor poll failed', (e as Error).message)), SENSOR_POLL_MS);
    }

    private stopSensorPoll() {
        clearInterval(this.sensorPollTimer);
        this.sensorPollTimer = undefined;
    }

    /** Re-reads the characteristics that have never pushed, and stops once none are left. */
    private async pollSensors() {
        // A camera slower to answer than the interval would otherwise queue a second read behind
        // the first and never catch up.
        if (this.polling)
            return;

        const pending = this.pollableCharacteristics.filter(item => !this.pushedCharacteristics.has(item.iid));
        if (!pending.length) {
            // every characteristic has pushed at least once, so the accessory is honouring its
            // subscriptions and there is nothing left to cover for.
            this.console.debug('every subscribed characteristic has pushed an event; polling stopped');
            this.stopSensorPoll();
            return;
        }

        if (!this.client)
            return;

        this.polling = true;
        let results: HapCharacteristic[];
        try {
            results = await this.client.readCharacteristics(pending);
        }
        finally {
            this.polling = false;
        }

        for (const result of results) {
            if (result.status || result.value === undefined || result.value === null)
                continue;
            // Only a change is worth acting on. This poll runs indefinitely against anything the
            // accessory never pushes, so treating every read as news would both spam the log and
            // re-fire a doorbell press once every interval. The baseline was seeded when the
            // characteristic was bound, from the same database the device itself was seeded from.
            if (this.polledValues.get(result.iid) === result.value)
                continue;
            this.polledValues.set(result.iid, result.value);

            this.console.debug(`polled ${this.describeCharacteristic(result.iid)} = ${JSON.stringify(result.value)}`
                + ' (the accessory did not push this)');
            this.applyCharacteristic(result.iid, result.value);
        }
    }

    /** Names a characteristic by its instance id, so logs read as something other than numbers. */
    private describeCharacteristic(iid: number): string {
        for (const service of this.accessory?.services || []) {
            const characteristic = service.characteristics.find(candidate => candidate.iid === iid);
            if (characteristic)
                return `${serviceName(service.type)}.${characteristicName(characteristic.type)}`;
        }
        return `unknown iid ${iid}`;
    }

    private findCharacteristicByIid(iid: number): HapCharacteristic {
        for (const service of this.accessory?.services || []) {
            const characteristic = service.characteristics.find(candidate => candidate.iid === iid);
            if (characteristic)
                return characteristic;
        }
        return undefined;
    }

    /**
     * Writes the accessory's whole service graph to the log.
     *
     * Almost every question about a camera that behaves oddly - why a sensor never fires, why a
     * control is missing, why an interface was not claimed - is answered by what the accessory
     * actually published, and there is otherwise no way to see it.
     */
    private dumpAccessory() {
        if (!this.console.debugEnabled)
            return;

        this.console.debug(`accessory ${this.accessory.aid} publishes ${this.accessory.services.length} service(s):`);
        for (const service of this.accessory.services) {
            this.console.debug(`  ${serviceName(service.type)} (iid ${service.iid})`);
            for (const characteristic of service.characteristics) {
                const value = characteristic.value === undefined ? '' : ` = ${JSON.stringify(characteristic.value)?.substring(0, 64)}`;
                this.console.debug(`    ${characteristicName(characteristic.type)} (iid ${characteristic.iid})`
                    + ` [${(characteristic.perms || []).join(',')}]${value}`);
            }
        }
    }

    // -------------------------------------------------------------------------------------------
    // DeviceProvider: the accessory's controls
    // -------------------------------------------------------------------------------------------

    async getDevice(nativeId: string) {
        if (this.controls.has(nativeId))
            return this.controls.get(nativeId);

        const descriptor = this.controlDescriptors.get(nativeId);
        if (!descriptor)
            return undefined;

        const control = new HomeKitCameraControl(this, nativeId, descriptor);
        // seed from the cached accessory database so the control is correct before any event.
        seedControl(control, this.accessory);
        this.controls.set(nativeId, control);
        return control;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        this.controls.delete(nativeId);
    }

    /** ControlHost: lets a child control write its characteristic through the camera's session. */
    async writeCharacteristic(aid: number, iid: number, value: any): Promise<void> {
        await this.initialize();
        await this.client.writeCharacteristic(aid, iid, value);
    }

    private onCharacteristicEvent(event: { aid: number, iid: number, value: any }) {
        // this characteristic demonstrably pushes, so the poll no longer has to cover it.
        this.pushedCharacteristics.add(event.iid);
        this.polledValues.set(event.iid, event.value);

        // Logged whether or not anything is listening. An event that arrives and is dropped looks
        // exactly like no event at all from the outside, and the two have different causes.
        this.console.debug(`event ${this.describeCharacteristic(event.iid)} = ${JSON.stringify(event.value)}`
            + (this.characteristicHandlers.has(event.iid) ? '' : ' (not one this device tracks)'));

        this.applyCharacteristic(event.iid, event.value);
    }

    /** Routes a characteristic value to whichever Scrypted property it backs. */
    private applyCharacteristic(iid: number, value: any) {
        const handler = this.characteristicHandlers.get(iid);
        if (!handler)
            return;
        try {
            handler(value);
        }
        catch (e) {
            this.console.warn('error handling characteristic value', e);
        }
    }

    /** Refuses to ask a camera that has just refused, until its wait has elapsed. */
    private checkRejectionBackoff() {
        const remaining = this.streamRecovery.remaining();
        if (!remaining)
            return;
        throw new Error(`the camera refused every stream configuration offered, so it is not being asked again `
            + `for another ${Math.ceil(remaining / 1000)}s. A camera that does this while still answering on its `
            + `control channel is either switched off or wedged; the log says which.`);
    }

    /**
     * Why the camera says it will not stream, if it is switched off.
     *
     * Read fresh rather than taken from the controls, because the question is what the camera
     * thinks at the moment it refused. A camera that fails to answer is treated as not saying -
     * this is a diagnosis, and an unreadable characteristic must not be mistaken for an off one.
     */
    private async readStreamingDisabledReason(service: HapService): Promise<string | undefined> {
        if (!this.client || !this.accessory)
            return undefined;

        const operatingMode = findService(this.accessory, Service.CameraOperatingMode);
        const wanted = {
            homeKitCameraActive: operatingMode && findCharacteristic(operatingMode, Characteristic.HomeKitCameraActive),
            manuallyDisabled: operatingMode && findCharacteristic(operatingMode, Characteristic.ManuallyDisabled),
            streamActive: findCharacteristic(service, Characteristic.Active),
        };
        const present = Object.entries(wanted).filter(([, characteristic]) => !!characteristic) as [string, HapCharacteristic][];
        if (!present.length)
            return undefined;

        try {
            const results = await this.client.readCharacteristics(
                present.map(([, characteristic]) => ({ aid: this.aid, iid: characteristic.iid })));
            const reading: Record<string, unknown> = {};
            for (const [key, characteristic] of present) {
                const result = results.find(r => r.iid === characteristic.iid);
                if (result && !result.status)
                    reading[key] = result.value;
            }
            return describeStreamingDisabled(reading);
        }
        catch (e) {
            this.console.debug('could not read the camera\'s operating mode', (e as Error).message);
            return undefined;
        }
    }

    /** Takes the next step up the recovery ladder after the camera refused every configuration. */
    private async noteStreamRejected(service: HapService) {
        const step = this.streamRecovery.next(await this.readStreamingDisabledReason(service));

        // Rung 0. Switched off is not broken, and nothing further up the ladder can help it - the
        // top rung ends by telling someone to power cycle a camera whose only problem is a switch.
        if (step.kind === 'disabled') {
            this.console.warn(`the camera refused to stream because ${step.reason}. Turn it back on to stream; `
                + `checking again in ${Math.round(step.ms / 1000)}s`);
            return;
        }

        // Rung 1. An accessory releases a stream session when the connection that created it goes
        // away, so this is what clears endpoints stranded by attempts that set one up and then
        // failed to start it. It is the cheapest thing that can work and it fixes the common case:
        // nothing the camera can see distinguishes it from the plugin being restarted, which is
        // what recovered this by hand.
        if (step.kind === 'reconnect') {
            this.console.warn('the camera refused every stream configuration; reconnecting to release any stream '
                + 'sessions it is still holding, then trying again');
            await this.client?.reconnect()
                .catch(e => this.console.warn('reconnecting failed', (e as Error).message));
            return;
        }

        // Rung 2. Still refusing on a connection it has just accepted, so the objection is to the
        // request rather than to the session behind it. The iids we write to come from the
        // accessory database read when this device started; a camera that updated its firmware
        // since can have moved them, and writing a valid value to the wrong characteristic is
        // reported exactly like writing an invalid one. Rebuilding re-reads the database.
        if (step.kind === 'rebuild') {
            this.console.warn('the camera refused every stream configuration again on a fresh connection; rebuilding '
                + 'from its accessory database in case its characteristics have moved, then trying again');
            await this.release();
            await this.initialize()
                .catch(e => this.console.warn('rebuilding failed', (e as Error).message));
            return;
        }

        // Rung 3. A clean connection and a freshly read database, and it still refuses - so there
        // is nothing further worth doing to it, and the useful thing is to stop asking.
        this.console.warn(`the camera refused every stream configuration after both a reconnect and a rebuild; `
            + `waiting ${Math.round(step.ms / 1000)}s before asking again. It almost certainly wants a power cycle.`);
    }

    /** One accepted configuration means the camera is answering again, whatever rung got it there. */
    private clearRejectionBackoff() {
        if (!this.streamRecovery.active)
            return;
        this.console.log('the camera accepted a stream configuration again');
        this.streamRecovery.reset();
    }

    /**
     * Motion, with the option of holding it on briefly after the accessory drops it.
     *
     * Some cameras report motion as a level that stays up for as long as something is moving, and
     * some report it as a series of pulses - a camera that detects in the vendor's cloud tends to
     * be the latter, because what reaches it is a sequence of verdicts rather than a continuous
     * observation. Passed through as-is, each pulse is a separate event to everything downstream:
     * a fresh HomeKit notification, a fresh recording, a fresh snapshot, several times for what a
     * person watching would call one event.
     *
     * Holding the signal up through the gaps collapses those back into one. It is off by default,
     * because it is a lie about what the accessory said and only worth telling for a camera whose
     * pulses are demonstrably one event - and how long a gap to bridge is a property of that
     * camera, not something to guess.
     */
    private applyMotion(detected: boolean) {
        clearTimeout(this.motionClearTimer);
        this.motionClearTimer = undefined;

        if (detected) {
            if (!this.motionDetected)
                this.motionOnSince = Date.now();
            this.motionDetected = true;
            // Armed once per stretch of motion, not re-armed per push. Restarting it on every true
            // would measure time since the latest push rather than since motion began, and a stuck
            // camera that keeps re-sending true would never be reported at all.
            if (!this.stuckMotionTimer)
                this.armStuckMotionWarning();
            return;
        }

        const seconds = this.motionTimeout;
        if (!seconds) {
            this.endMotion();
            return;
        }

        // already clear: nothing to hold up, and re-arming here would let a camera that repeats
        // `false` keep pushing the moment of clearing further away indefinitely.
        if (!this.motionDetected)
            return;

        this.console.debug(`motion cleared; holding it on for ${seconds}s in case it resumes`);
        this.motionClearTimer = setTimeout(() => {
            this.motionClearTimer = undefined;
            this.endMotion();
        }, seconds * 1000);
    }

    /**
     * Motion has actually stopped, as far as anything downstream is concerned.
     *
     * Kept apart from the accessory's own `false`, because with a hold those are different
     * moments: a pulse gap is a `false` from the camera while motion stays on here. Doing this
     * bookkeeping on the camera's `false` instead would restart the stuck-motion clock on every
     * gap, and report a stretch of motion as over while it was still being held.
     */
    private endMotion() {
        if (this.motionDetected && this.motionOnSince) {
            const minutes = Math.round((Date.now() - this.motionOnSince) / 60000);
            if (minutes >= STUCK_MOTION_MINUTES)
                this.console.log(`motion finally cleared after ${minutes} minutes`);
        }
        this.motionOnSince = undefined;
        clearTimeout(this.stuckMotionTimer);
        this.stuckMotionTimer = undefined;
        this.motionDetected = false;
    }

    /**
     * Says so when motion has been on implausibly long.
     *
     * Motion that never once drops is not a busy room - a room with people in it produces gaps.
     * It is something that moves without stopping and is not alive: a ceiling fan clipping the
     * frame, a blind in the draught, sunlight crossing a wall. HomeKit will keep asking for
     * recordings of it and keep discarding them, because its own analysis finds no subject, and
     * nothing anywhere would otherwise say why. Re-armed so a long latch keeps reporting rather
     * than being announced once and forgotten.
     */
    private armStuckMotionWarning() {
        clearTimeout(this.stuckMotionTimer);
        this.stuckMotionTimer = setTimeout(() => {
            const minutes = Math.round((Date.now() - (this.motionOnSince ?? Date.now())) / 60000);
            this.console.warn(`this camera has reported motion continuously for ${minutes} minutes without a single break. `
                + 'Something in frame is moving without stopping - a ceiling fan, a blind, sunlight across a room. '
                + 'HomeKit records it and then discards each clip, having found nothing in it worth keeping. '
                + 'An activity zone that excludes whatever is moving is the fix; the camera itself is working.');
            this.armStuckMotionWarning();
        }, STUCK_MOTION_MINUTES * 60000);
    }

    /** Seconds to hold motion on after the accessory clears it; 0 disables the hold. */
    private get motionTimeout(): number {
        const value = parseFloat(this.storage.getItem('motionTimeout'));
        return isFinite(value) && value > 0 ? value : 0;
    }

    // -------------------------------------------------------------------------------------------
    // VideoCamera
    // -------------------------------------------------------------------------------------------

    /** The Scrypted stream id for a stream service: its ceiling, disambiguated if two match. */
    private streamOptionId(state: StreamServiceState, index: number): string {
        const best = largestResolution(state.capabilities.video);
        const id = `${best.width}x${best.height}`;
        const duplicate = this.streamServices
            .some((other, otherIndex) => otherIndex < index
                && largestResolution(other.capabilities.video).width === best.width
                && largestResolution(other.capabilities.video).height === best.height);
        return duplicate ? `${id}-${index}` : id;
    }

    private serviceForOptionId(id?: string): StreamServiceState {
        if (!id)
            return undefined;
        return this.streamServices.find((state, index) => this.streamOptionId(state, index) === id);
    }

    /**
     * One Scrypted stream per HAP stream service.
     *
     * The stream service is the camera's actual unit of allocation: each has its own resolutions,
     * and one may offer full resolution while another is limited to a substream. Mapping them one
     * to one means a stream id names a real camera resource, so the label Rebroadcast gives a
     * stream - and the rebroadcast URL derived from it - describe something the camera can be
     * asked for, rather than a size that might have to come from a service already in use.
     */
    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        await this.initialize();

        return this.streamServices.map((state, index): ResponseMediaStreamOptions => {
            const best = largestResolution(state.capabilities.video);
            const audio = chooseAudioCodec(state.capabilities.audio, this.preferredAudioCodec);
            // HAP names the codec; Scrypted wants the container level codec name.
            const audioCodec = !audio ? null
                : audio.codec === AudioCodecType.OPUS ? 'opus'
                    : audio.codec === AudioCodecType.AAC_ELD ? 'aac'
                        : audio.codec === AudioCodecType.PCMU ? 'pcm_mulaw'
                            : audio.codec === AudioCodecType.PCMA ? 'pcm_alaw'
                                : null;

            return {
                id: this.streamOptionId(state, index),
                name: `${best.width}x${best.height} @ ${best.fps}fps`,
                container: 'rtsp',
                // the RTP arrives from the camera already packetized; nothing re-encodes it.
                tool: 'scrypted',
                video: {
                    codec: 'h264',
                    width: best.width,
                    height: best.height,
                    fps: best.fps,
                },
                audio: audioCodec ? { codec: audioCodec } : null,
                // the largest service is the one worth recording and sending to local clients;
                // the rest serve as substreams for remote viewing and detection.
                destinations: index === 0
                    ? ['local', 'local-recorder', 'remote-recorder']
                    : ['remote', 'low-resolution', 'medium-resolution'],
                // Lets Rebroadcast prebuffer a camera that reports a battery. See the setting.
                allowBatteryPrebuffer: this.storage.getItem('allowBatteryPrebuffer') === 'true',
                userConfigurable: false,
            };
        })
            // biggest first, so the default stream is the best the camera offers.
            .sort((a, b) => (b.video.width * b.video.height) - (a.video.width * a.video.height));
    }

    private get preferredAudioCodec(): AudioCodecType {
        const setting = this.storage.getItem('audioCodec');
        if (setting === 'opus')
            return AudioCodecType.OPUS;
        if (setting === 'aac-eld')
            return AudioCodecType.AAC_ELD;
        return undefined;
    }

    private get keyframeRequestMode(): string {
        return this.storage.getItem('keyframeRequests') || 'auto';
    }

    private get maxBitrate(): number {
        return parseInt(this.storage.getItem('maxBitrate')) || 2000;
    }

    /**
     * Asks the accessory whether one of its stream management services is actually free.
     *
     * Local bookkeeping alone is not enough. It starts empty on every plugin restart while the
     * accessory's own state persists, and cameras do not necessarily hand out their services in
     * order - the first can be occupied by the vendor's own app or by a session left over from a
     * controller that went away, while a later one is free.
     */
    /**
     * Which stream services the camera currently says are free, read in a single request.
     *
     * Availability is dynamic, so it has to be asked rather than remembered, but asking once per
     * service costs a round trip each and this sits directly in the path of starting a stream.
     * HAP allows several characteristics per read, so they all go in one.
     */
    private async findFreeStreamServices(): Promise<StreamServiceState[]> {
        const pending = this.streamServices
            .map((state, index) => ({ state, index }))
            .filter(entry => !entry.state.inUse);

        const ids = pending
            .map(entry => ({ entry, characteristic: findCharacteristic(entry.state.service, Characteristic.StreamingStatus) }))
            .filter(item => !!item.characteristic);

        const statuses = new Map<number, boolean>();
        if (ids.length) {
            try {
                const results = await this.client.readCharacteristics(
                    ids.map(item => ({ aid: this.aid, iid: item.characteristic.iid })));

                for (const result of results) {
                    const value = typeof result.value === 'string' ? Buffer.from(result.value, 'base64') : undefined;
                    const status = value
                        ? tlv.readUInt8(tlv.decode(value)[StreamingStatusTLV.STATUS], StreamingStatus.AVAILABLE)
                        : StreamingStatus.AVAILABLE;
                    statuses.set(result.iid, status === StreamingStatus.AVAILABLE);
                }
            }
            catch (e) {
                // if the status cannot be read, let the stream attempt be the judge.
                this.console.warn('could not read streaming status, assuming the streams are free', (e as Error).message);
            }
        }

        const report: string[] = [];
        const free: StreamServiceState[] = [];

        for (const [index, state] of this.streamServices.entries()) {
            if (state.inUse) {
                report.push(`#${index} held by us`);
                continue;
            }
            const characteristic = findCharacteristic(state.service, Characteristic.StreamingStatus);
            const available = characteristic ? statuses.get(characteristic.iid) ?? true : true;
            report.push(`#${index} ${available ? 'available' : 'in use by the camera'}`);

            const wasUsable = state.observedAvailable;
            state.observedAvailable = available;
            // what we can offer changes with it, so let Scrypted re-read the stream list.
            if (wasUsable !== undefined && wasUsable !== available)
                this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);

            if (available)
                free.push(state);
        }

        this.console.debug(`stream services: ${report.join(', ')}`);
        return free;
    }

    private async allocateStreamService(preferred?: StreamServiceState): Promise<StreamServiceState> {
        let free = await this.findFreeStreamServices();

        // Only a genuine absence of free services suggests a session left behind by a controller
        // that vanished, which reconnecting clears. A service that is free but does not happen to
        // offer the requested size is not that, and reconnecting for it costs a pair-verify round
        // trip in the middle of starting a stream for no benefit.
        if (!free.length && this.streamServices.some(state => !state.inUse)) {
            this.console.warn('the camera reports every stream in use while we hold none; reconnecting to clear a stale session');
            await this.client.reconnect();
            free = await this.findFreeStreamServices();
        }

        if (!free.length) {
            const held = this.streamServices.filter(state => state.inUse).length;
            throw new Error(`no free streaming session on the camera (${held} of ${this.streamServices.length} held by Scrypted). `
                + 'Close the vendor app and any other HomeKit client watching this camera, or reduce the number of streams enabled in the Rebroadcast plugin.');
        }

        // The service the stream asked for, if it is free. Otherwise the best that is, so a
        // camera holding one service for its own app yields a smaller stream rather than none.
        // Re-evaluated on every request, so a service released since is picked up immediately.
        const chosen = (preferred && free.includes(preferred))
            ? preferred
            : [...free].sort((a, b) =>
                (largestResolution(b.capabilities.video).width * largestResolution(b.capabilities.video).height)
                - (largestResolution(a.capabilities.video).width * largestResolution(a.capabilities.video).height))[0];

        chosen.inUse = true;
        return chosen;
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const requestedAt = Date.now();
        this.checkRejectionBackoff();
        await this.initialize();

        // One session per advertised stream. A consumer asking again for a stream it already has
        // is restarting it, and leaving the old one running would hold a service the new one then
        // cannot get - which on a two service camera exhausts it after two restarts and leaves
        // every later request failing.
        const optionId = options?.id || (await this.getVideoStreamOptions())[0]?.id;
        let replaced = false;
        for (const [session, active] of [...this.sessions]) {
            if (active.optionId !== optionId)
                continue;
            this.console.log(`stream ${optionId} was already running; replacing it`);
            await session.stop().catch(() => { });
            replaced = true;
        }

        // let the accessory free the session before asking it for another.
        if (replaced)
            await new Promise(resolve => setTimeout(resolve, SESSION_SETTLE_MS));

        // The stream id names a stream service. Take that one when it is free, and otherwise the
        // best that is - a camera can be holding a service for its own app, and a smaller stream
        // beats none. The size then comes from whichever service was actually obtained.
        const requested = this.serviceForOptionId(optionId);
        const serviceState = await this.allocateStreamService(requested);
        const allocatedAt = Date.now();

        if (requested && serviceState !== requested) {
            this.console.warn(`stream ${optionId} is served by a stream service the camera is using; `
                + `falling back to one that is free`);
        }

        const serviceCapabilities = serviceState.capabilities;
        const serviceAudio = chooseAudioCodec(serviceCapabilities.audio, this.preferredAudioCodec);
        const resolution = this.resolveRequestedResolution(serviceState, options);

        if (exceedsAdvertisedLevel(serviceCapabilities.video, resolution)) {
            this.console.warn(`the camera advertises ${resolution.width}x${resolution.height} but no H.264 level that can carry it; `
                + `requesting its highest advertised level, and falling back to the level the frame needs if that is refused`);
        }

        const session = new HapStreamSession({
            client: this.client,
            aid: this.aid,
            service: serviceState.service,
            video: serviceCapabilities.video,
            resolution,
            audio: serviceAudio,
            maxBitrate: this.maxBitrate,
            preferredVariant: this.negotiatedVariant,
            onNegotiated: label => this.negotiatedVariant = label,
            console: this.console,
        });

        // The camera's stream service belongs to the session, so it is freed whenever the session
        // ends by any route - a consumer disconnecting, a failure to start, the Retry Best Stream
        // button, or the plugin shutting down. Releasing only on one of those paths is how a
        // service stays marked in use forever, and a camera with two of them then has none free.
        const release = () => {
            serviceState.inUse = false;
            this.sessions.delete(session);
            // keep the settings page honest about what is streaming.
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
        };
        session.once('stopped', release);

        // Anything that throws between taking the service and handing it to the RTSP listener
        // would otherwise strand it, since nothing has been wired up yet to release it.
        try {
        let sdpText = createStreamSdp({
            resolution,
            profile: bestProfile(this.capabilities.video),
            // match the level the session will request, which for a resolution the advertised
            // level cannot carry is the one the frame actually needs. Taken from the service in use.
            level: advertisedLevelFor(serviceCapabilities.video, resolution),
            audio: serviceAudio,
            sessionName: this.name || 'HomeKit Camera',
        });
        sdpText = addTrackControls(sdpText);

        const parsed = parseSdp(sdpText);
        const videoTrack = parsed.msections.find(msection => msection.type === 'video');
        const audioTrack = parsed.msections.find(msection => msection.type === 'audio');

        const rtspListener = await listenSingleRtspClient();

        // The HAP session is started only once something actually connects to the RTSP server.
        // Starting it eagerly would burn one of the camera's few streaming slots on a stream that
        // may never be consumed.
        rtspListener.rtspServerPromise.then(async rtsp => {
            const clientAt = Date.now();
            // RtspServer dumps every request and response header, which is the noisiest thing
            // in this log by a wide margin. Hand it a console only when that is wanted.
            rtsp.console = this.debugLogging ? this.console : undefined;
            rtsp.sdp = sdpText;

            // stopping the session releases the service through its 'stopped' event.
            const endSession = async () => {
                await session.stop().catch(() => { });
                try {
                    rtsp.client.destroy();
                }
                catch (e) {
                }
            };
            const cleanup = () => void endSession();

            rtsp.client.on('close', cleanup);
            rtsp.client.on('error', cleanup);
            session.on('error', cleanup);

            try {
                await rtsp.handlePlayback();
                const playbackAt = Date.now();

                // Timing for the whole start path, reported once the picture can actually be
                // drawn. Startup is several distinct waits - allocating a service, the local RTSP
                // handshake, the round trips to negotiate with the camera, then the camera's own
                // encoder reaching a keyframe - and they are not separable from the outside.
                const telemetry = new StreamTelemetry({
                    mode: this.keyframeRequestMode,
                    requestKeyframe: () => session.requestKeyframe(),
                    console: this.console,
                    onFirstKeyframe: (firstPacketAt, at) => this.console.debug('stream start timing:'
                        + ` service ${allocatedAt - requestedAt}ms,`
                        + ` rtsp handshake ${playbackAt - clientAt}ms,`
                        + ` camera negotiation ${negotiatedAt - playbackAt}ms,`
                        + ` first packet ${firstPacketAt - negotiatedAt}ms,`
                        + ` first keyframe ${at - firstPacketAt}ms,`
                        + ` total ${at - requestedAt}ms`),
                });

                // A camera that stops sending keyframes, or quietly drops to a third of its
                // framerate to pay for them, is otherwise visible only as a stream that takes a
                // long time to show a picture.
                const census = setInterval(() => this.console.debug(telemetry.census()), CENSUS_INTERVAL_MS);
                session.once('stopped', () => clearInterval(census));

                // Keep a keyframe within reach of whatever is buffering downstream. A viewer
                // attaches to Rebroadcast's prebuffer long after this session started, so the
                // keyframe the camera sent at session start is long gone; if the camera's own
                // cadence is slower than the window a consumer searches, there is nothing to start
                // decoding from, which looks like audio playing while the picture takes seconds to
                // appear.
                if (telemetry.requestsKeyframes) {
                    const check = setInterval(() => telemetry.checkKeyframe(), telemetry.checkIntervalMs);
                    session.once('stopped', () => clearInterval(check));
                }

                session.on('video', rtp => {
                    telemetry.onVideoPacket(rtp);
                    rtsp.sendTrack(videoTrack.control, rtp, false);
                });

                // A stream the camera accepted and then did not feed looks exactly like a working
                // one in the log, right up until nothing plays. It is worth naming, because the
                // cause is almost never HomeKit: the accessory sends its SRTP to the address and
                // ports advertised in SetupEndpoints, so silence means those packets are not
                // arriving - a firewall, or a route that carries TCP but not inbound UDP.
                session.once('stopped', () => {
                    // A session the camera refused stops with no packets too, and saying the media
                    // never arrived would point at the network when the camera declined the stream
                    // outright - which it has already said, three lines earlier.
                    if (!session.negotiated) {
                        // the rejection is its own report; nothing to add.
                    }
                    else if (telemetry.firstPacketAt === undefined) {
                        this.console.warn('the camera accepted this stream and then sent no video at all.'
                            + ` Its media is sent over UDP to ${this.client?.localAddress ?? 'this host'}, so the usual cause is`
                            + ' a firewall or VLAN rule that permits TCP but not inbound UDP from the camera.');
                    }
                    else if (telemetry.videoIsPlausible === false) {
                        // Said before anything about keyframes, because when this is the answer,
                        // nothing about keyframes or packetization is relevant: the bytes are not
                        // H.264, so they were decrypted with the wrong key.
                        this.console.warn('the video arriving from this camera is not valid H.264, which means it is being'
                            + ' decrypted with the wrong key rather than packetized in an unexpected way.'
                            + ' Turn on Debug Logging and check the SRTP suite the camera selected in the stream endpoints line.');
                    }
                    else if (telemetry.lastKeyframeAt === undefined) {
                        // Naming what did arrive separates the two causes. Parameter sets and
                        // slices but no IDR is a camera ignoring the request; an aggregation type
                        // HAP does not permit, such as an MTAP, means its keyframes are there but
                        // packetized in a form nothing here unwraps.
                        this.console.warn('the camera sent video but never a keyframe, so nothing downstream could start'
                            + ` decoding it. NAL types seen: ${describeNaluTypes(telemetry.observedNaluTypes) || 'none'}.`
                            + ' If an IDR is missing entirely, try a fixed Keyframe Requests interval, or a smaller stream.');
                    }
                });
                if (audioTrack)
                    session.on('audio', rtp => rtsp.sendTrack(audioTrack.control, rtp, false));

                this.sessions.set(session, {
                    optionId,
                    serviceIndex: this.streamServices.indexOf(serviceState),
                    serviceIid: serviceState.service.iid,
                    resolution,
                    audio: serviceAudio ? audioCodecName(serviceAudio.codec) : undefined,
                    since: Date.now(),
                });
                await session.start();
                const negotiatedAt = Date.now();
                this.clearRejectionBackoff();
                this.onDeviceEvent(ScryptedInterface.Settings, undefined);

                this.console.log(`streaming ${resolution.width}x${resolution.height}@${resolution.fps}`
                    + (serviceAudio ? ` with ${audioCodecName(serviceAudio.codec)} audio` : ' without audio'));
            }
            catch (e) {
                this.console.error('failed to start the HomeKit stream', e);
                // Awaited, unlike the other cleanup paths: the camera only frees the stream service
                // when it is told to, and the next attempt is four seconds away. Racing the release
                // against the next allocation is how a camera ends up with both of its services
                // held by sessions nobody is using.
                await endSession();
                if (!session.negotiated)
                    await this.noteStreamRejected(serviceState.service);
            }
        }).catch(e => {
            // nothing ever connected, so the service would be held for a stream with no consumer.
            this.console.error('no RTSP client connected', e);
            release();
        });

        const ffmpegInput: FFmpegInput = {
            url: rtspListener.url,
            container: 'rtsp',
            inputArguments: [
                '-rtsp_transport', 'tcp',
                '-i', rtspListener.url,
            ],
            mediaStreamOptions: {
                id: `${resolution.width}x${resolution.height}`,
                container: 'rtsp',
                tool: 'scrypted',
                video: {
                    codec: 'h264',
                    width: resolution.width,
                    height: resolution.height,
                    fps: resolution.fps,
                },
                audio: serviceAudio ? { codec: serviceAudio.codec === AudioCodecType.OPUS ? 'opus' : 'aac' } : null,
                sdp: sdpText,
            },
        };

        // Published alongside the stream so a consumer can talk back to the camera about it.
        //
        // This is what HomeKit means by "adaptive bitrate": a phone that has moved onto cellular
        // asks for a smaller, cheaper stream, and without somewhere to send that request the ask is
        // dropped and the camera keeps pushing its full bitrate at a link that cannot carry it. A
        // HAP camera can be reconfigured mid session, so the request maps straight through.
        const feedback: MediaStreamFeedback = {
            reconfigureStream: async options => {
                await session.reconfigure({
                    bitrate: options.video?.bitrate,
                    width: options.video?.width,
                    height: options.video?.height,
                });
            },
            resizeStream: async options => {
                await session.reconfigure({ width: options.width, height: options.height });
            },
            reportEstimatedMaxBitrate: async bitrate => {
                await session.reconfigure({ bitrate });
            },
            requestKeyframe: async () => session.requestKeyframe(),
            // A consumer that cannot draw a picture wants the same thing a keyframe request wants.
            reportPictureLoss: async () => session.requestKeyframe(),
            reportPacketLoss: async report => {
                // Loss between here and the consumer, which is a different link from the one
                // between here and the camera; the camera is told about its own by this plugin's
                // receiver reports. Worth seeing, not worth acting on twice.
                this.console.debug('downstream consumer reported packet loss', JSON.stringify(report));
            },
            onRtcp: async () => {
                // The consumer's own RTCP. Its receiver reports describe the local hop rather than
                // the camera's, and the feedback that matters arrives through the calls above.
            },
        };

        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInput)), ScryptedMimeTypes.FFmpegInput, {
            sourceId: this.id,
            toMimeTypes: [ScryptedMimeTypes.MediaStreamFeedback],
            convert: async toMimeType => {
                if (toMimeType === ScryptedMimeTypes.MediaStreamFeedback)
                    return feedback as any;
                throw new Error(`cannot convert a HomeKit stream to ${toMimeType}`);
            },
        });
        }
        catch (e) {
            release();
            throw e;
        }
    }

    /**
     * The size to ask a given stream service for: the requested one snapped onto what that
     * service offers, or its ceiling when nothing specific was asked for.
     */
    private resolveRequestedResolution(state: StreamServiceState, options?: RequestMediaStreamOptions): VideoResolution {
        if (options?.video?.width || options?.video?.height)
            return nearestResolution(state.capabilities.video, options.video.width, options.video.height);

        return largestResolution(state.capabilities.video);
    }

    /**
     * Display preference only. HAP always reports temperature in Celsius regardless of what the
     * Home app shows, so this changes presentation and never the reported value.
     */
    async setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
        this.temperatureUnit = temperatureUnit;
    }

    // -------------------------------------------------------------------------------------------
    // Camera
    // -------------------------------------------------------------------------------------------

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        await this.initialize();

        const resolution = options?.picture?.width
            ? { width: options.picture.width, height: options.picture.height }
            : largestResolution(this.capabilities.video);

        const jpeg = await this.client.snapshot({
            width: resolution.width,
            height: resolution.height,
        });
        return mediaManager.createMediaObject(jpeg, 'image/jpeg');
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        await this.initialize();
        return this.capabilities.video.resolutions.map(resolution => ({
            id: `${resolution.width}x${resolution.height}`,
            picture: {
                width: resolution.width,
                height: resolution.height,
            },
        }));
    }

    // -------------------------------------------------------------------------------------------
    // Intercom: two way audio into the camera's speaker
    // -------------------------------------------------------------------------------------------

    async startIntercom(media: MediaObject): Promise<void> {
        await this.initialize();

        const session = [...this.sessions.keys()][0];
        if (!session?.audioEnabled)
            throw new Error('start a video stream before using two way audio; HomeKit carries return audio on the stream session');

        await this.stopIntercom();

        this.intercomSession = session;

        const audio = chooseAudioCodec(this.capabilities.audio, this.preferredAudioCodec);
        const sampleRate = samplerateToHz(audio.samplerate);

        const ffmpegInput: FFmpegInput = JSON.parse((await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput)).toString());

        // ffmpeg encodes to the negotiated codec and emits RTP at a local port; we then re-stamp
        // and encrypt each packet into the camera's SRTP audio session.
        const socket = dgram.createSocket('udp4');
        this.intercomSocket = socket;
        await new Promise<void>(resolve => socket.bind(0, () => resolve()));
        const port = socket.address().port;

        // What clock ffmpeg stamps its RTP with, which is not always the sample rate it encoded at:
        // its Opus muxer follows RFC 7587 and always uses 48kHz, while AAC-ELD is stamped at the
        // real rate. The session rescales from here onto the rate HAP negotiated.
        const sourceClockHz = audio.codec === AudioCodecType.OPUS ? 48000 : sampleRate;
        socket.on('message', message => {
            // ffmpeg has already packetized and paced this; the session only restamps it into the
            // camera's SRTP stream.
            if (message.length <= 12)
                return;
            session.sendReturnAudio(message, sourceClockHz);
        });

        // Return audio has to use the codec the session negotiated, and only two of the seven HAP
        // defines can be encoded here. HAP requires every camera to offer AAC-ELD, so reaching this
        // means the camera offered something unusual and it was selected.
        if (audio.codec !== AudioCodecType.OPUS && audio.codec !== AudioCodecType.AAC_ELD) {
            throw new Error(`two way audio cannot encode ${audioCodecName(audio.codec)}, which is what this session negotiated. `
                + 'Set this camera\'s Audio Codec setting to "opus" or "aac-eld".');
        }

        // Encoding AAC-ELD needs libfdk_aac, which is absent from most ffmpeg builds including the
        // one Scrypted ships; the native aac encoder only does LC, which the camera will reject.
        // Fail with something actionable rather than letting ffmpeg die with an unknown encoder.
        if (audio.codec === AudioCodecType.AAC_ELD && !await this.ffmpegHasEncoder('libfdk_aac')) {
            throw new Error('two way audio needs an Opus session, because encoding AAC-ELD requires an ffmpeg built with libfdk_aac. '
                + 'Set this camera\'s Audio Codec setting to "opus" if the camera offers it, or point Scrypted at an ffmpeg with libfdk_aac.');
        }

        // Without an explicit bitrate ffmpeg picks its own default, which for mono Opus is 64k --
        // well over the ceiling this session advertised to the camera.
        const bitrate = ['-b:a', `${AUDIO_MAX_BITRATE_KBPS}k`];
        const encoderArguments = audio.codec === AudioCodecType.OPUS
            ? ['-acodec', 'libopus', '-ar', `${sampleRate}`, '-ac', `${audio.channels}`, ...bitrate, '-application', 'voip', '-frame_duration', `${AUDIO_PACKET_TIME_MS}`]
            : ['-acodec', 'libfdk_aac', '-profile:a', 'aac_eld', '-ar', `${sampleRate}`, '-ac', `${audio.channels}`, ...bitrate];

        const args = [
            '-hide_banner',
            ...(ffmpegInput.inputArguments || ['-i', ffmpegInput.url]),
            '-vn',
            ...encoderArguments,
            '-payload_type', `${AUDIO_PAYLOAD_TYPE}`,
            '-f', 'rtp',
            `rtp://127.0.0.1:${port}`,
        ];

        const ffmpegPath = await mediaManager.getFFmpegPath();
        this.console.debug('starting intercom', ffmpegPath, args.join(' '));
        const encoder = child_process.spawn(ffmpegPath, args);
        this.intercomProcess = encoder;

        // ffmpeg explains itself on stderr, which is otherwise only in the debug log. Keeping the
        // tail of it means an encoder that dies on its own still says why, rather than talkback
        // simply going quiet with nothing written anywhere.
        let stderrTail = '';
        encoder.stderr?.on('data', data => {
            const text = data.toString();
            this.console.debug('intercom ffmpeg:', text);
            stderrTail = (stderrTail + text).slice(-2000);
        });

        encoder.on('exit', code => {
            // An exit this plugin asked for. stopIntercom clears the handle before the exit event
            // arrives, and ffmpeg answers a signal by exiting 255 of its own accord rather than
            // dying from it - so the exit code alone cannot tell a deliberate stop from a failure.
            if (this.intercomProcess !== encoder)
                return;

            if (code)
                this.console.warn(`the two way audio encoder exited with code ${code}:`, stderrTail.trim());
            this.stopIntercom().catch(() => { });
        });
    }

    private encoderCache = new Map<string, boolean>();

    /** Probes the configured ffmpeg once per encoder name and caches the answer. */
    private async ffmpegHasEncoder(name: string): Promise<boolean> {
        if (this.encoderCache.has(name))
            return this.encoderCache.get(name);

        const available = await new Promise<boolean>(async resolve => {
            try {
                const proc = child_process.spawn(await mediaManager.getFFmpegPath(), ['-hide_banner', '-encoders']);
                let out = '';
                proc.stdout?.on('data', data => out += data.toString());
                proc.on('error', () => resolve(false));
                proc.on('exit', () => resolve(new RegExp(`\\b${name}\\b`).test(out)));
            }
            catch (e) {
                resolve(false);
            }
        });

        this.encoderCache.set(name, available);
        return available;
    }

    async stopIntercom(): Promise<void> {
        // Said whenever talkback ends, because "no sound came out of the camera" has two entirely
        // different causes and nothing else distinguishes them: either nothing was sent, which is
        // this plugin's problem, or it was sent and the accessory did not play it - which is
        // usually its speaker being muted, or its own app holding the audio channel.
        const sent = this.intercomSession?.returnAudioStats;
        if (sent) {
            this.intercomSession = undefined;
            if (sent.packets) {
                this.console.log(`two way audio sent ${sent.packets} packet(s), ${Math.round(sent.bytes / 1024)}KB, to ${sent.target}.`
                    + ' If the camera stayed silent, check that its speaker is not muted -- the Speaker child device --'
                    + ' and that nothing else is holding its audio.');
            }
            else {
                this.console.warn('two way audio ended without sending a single packet to the camera;'
                    + ' the encoder produced nothing. Check the intercom ffmpeg output with Debug Logging on.');
            }
        }

        try {
            this.intercomProcess?.kill();
        }
        catch (e) {
        }
        this.intercomProcess = undefined;

        try {
            this.intercomSocket?.close();
        }
        catch (e) {
        }
        this.intercomSocket = undefined;
    }

    // -------------------------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------------------------

    /** A one line summary of what is streaming, and how it compares to the camera's best. */
    private describeActiveStreams(): string {
        if (!this.sessions.size) {
            const services = this.streamServices
                .map((state, index) => {
                    const best = largestResolution(state.capabilities.video);
                    const status = state.observedAvailable === undefined ? 'not yet checked'
                        : state.observedAvailable ? 'free' : 'in use by the camera';
                    return `#${index} up to ${best.width}x${best.height} (${status})`;
                })
                .join(', ');
            return services ? `nothing streaming. Services: ${services}` : 'nothing streaming';
        }

        return [...this.sessions.values()]
            .map(active => {
                const capable = largestResolution(this.capabilities.video);
                const short = active.resolution.width < capable.width
                    ? `, below this camera's best of ${capable.width}x${capable.height}`
                    : '';
                const seconds = Math.round((Date.now() - active.since) / 1000);
                return `${active.resolution.width}x${active.resolution.height}@${active.resolution.fps}`
                    + `${active.audio ? ` + ${active.audio}` : ' (no audio)'}`
                    + ` on service #${active.serviceIndex} (iid ${active.serviceIid}), ${seconds}s${short}`;
            })
            .join('; ');
    }

    /**
     * Ends the running streams so the next request re-picks a service.
     *
     * Which service is free changes over time, and a stream holds whichever it got for as long as
     * it runs. Dropping them is what lets a better one be taken up once the camera releases it.
     */
    private async restartStreams(): Promise<void> {
        const count = this.sessions.size;
        for (const session of [...this.sessions.keys()])
            await session.stop().catch(() => { });

        // Asking for this is asking to try now, which outranks a wait imposed because the camera
        // was refusing - the usual reason to press it is having just power cycled the camera. The
        // ladder resets with it, so the cheap rung is tried first rather than resuming where a
        // previous failure left off against what is now effectively a different camera.
        this.streamRecovery.reset();

        this.console.log(count
            ? `dropped ${count} stream(s); the next request will take the best service free at that moment`
            : 'no streams were running; the next request will take the best service free at that moment');

        // let consumers reopen, which is what triggers the re-evaluation.
        this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
    }

    async getSettings(): Promise<Setting[]> {
        const audioCodecs = this.capabilities?.audio.codecs.map(codec => audioCodecName(codec.codec)) || [];

        return [
            {
                group: 'Stream',
                key: 'audioCodec',
                title: 'Audio Codec',
                description: 'Which of the camera\'s audio codecs to request. Opus is preferred because ffmpeg and WebRTC handle it natively; AAC-ELD is HomeKit\'s mandatory codec and the safer fallback if audio fails.'
                    + (audioCodecs.length ? ` This camera offers: ${audioCodecs.join(', ')}.` : ''),
                value: this.storage.getItem('audioCodec') || 'auto',
                choices: ['auto', 'opus', 'aac-eld'],
            },
            {
                group: 'Stream',
                key: 'maxBitrate',
                title: 'Maximum Bitrate',
                description: 'Bitrate ceiling in kbps requested from the camera for the video stream.',
                type: 'number',
                value: this.maxBitrate,
            },
            {
                group: 'Motion',
                key: 'motionTimeout',
                title: 'Motion Timeout',
                description: 'Seconds to keep reporting motion after the camera says it has stopped. '
                    + 'Leave at 0 to report exactly what the camera reports, which is right for a camera whose motion stays on for as long as something is moving. '
                    + 'A camera that detects in the vendor\'s cloud tends instead to send a series of short pulses, and each gap between them starts a new event everywhere downstream - another HomeKit notification, another recording, another snapshot - for what was one thing happening. '
                    + 'Set this longer than the gaps between those pulses and they become a single event again. Too long and genuinely separate events are merged, so raise it only as far as it needs to go.',
                type: 'number',
                placeholder: '0',
                value: this.motionTimeout,
            },
            {
                group: 'Stream',
                key: 'keyframeRequests',
                title: 'Keyframe Requests',
                description: 'Video cannot start until a keyframe arrives, so a camera that sends them rarely leaves a viewer with audio and no picture for several seconds. '
                    + 'Automatic asks only when the newest keyframe is older than the four second window a consumer searches when starting a stream, so a camera that already sends them often is never asked. '
                    + 'The fixed intervals ask regardless. That is rarely what you want: keyframes are several times the size of the frames between them, and a camera encoding to a bitrate ceiling pays for them in framerate. '
                    + 'Turn Debug Logging on to see the framerate, bitrate and keyframe interval this camera actually settles on, which is the only way to tell what a change here bought.',
                choices: ['auto', 'off', '1', '2', '4', '8'],
                value: this.keyframeRequestMode,
            },
            {
                group: 'Stream',
                key: 'allowBatteryPrebuffer',
                title: 'Allow Prebuffer on Battery',
                description: 'Enable if this camera reports a battery but is actually mains powered. '
                    + 'Rebroadcast refuses to prebuffer a battery device unless it reports that it is charging, and without a prebuffer there is no HomeKit Secure Video recording. '
                    + 'Leave off for a genuinely battery powered camera, where a continuous stream would drain it.',
                type: 'boolean',
                value: this.storage.getItem('allowBatteryPrebuffer') === 'true',
            },
            {
                group: 'Stream',
                key: 'activeStreams',
                title: 'Active Stream',
                description: 'What is running right now, and which of the camera\'s stream services it is using. '
                    + 'A service the camera reserves for its own app can free up later, so a stream started while it was busy may be smaller than the camera can manage.',
                value: this.describeActiveStreams(),
                readonly: true,
            },
            {
                group: 'Stream',
                key: 'restartStreams',
                title: 'Retry Best Stream',
                description: 'Drops the current streams so the next request re-evaluates which of the camera\'s services are free and takes the best one. '
                    + 'Worth pressing after closing the vendor app, which is what usually frees the higher resolution service.',
                type: 'button',
            },
            {
                group: 'Connection',
                key: 'host',
                title: 'Address Override',
                description: 'Leave empty to locate the camera by mDNS, falling back to the address that last worked. '
                    + 'Set an address to skip discovery entirely, which is worth doing when the camera is on a network multicast does not cross and its address is fixed by a DHCP reservation.',
                placeholder: this.storage.getItem('lastKnownHost') || '192.168.1.50',
                value: this.storage.getItem('host') || '',
            },
            {
                group: 'Connection',
                key: 'port',
                title: 'Port Override',
                description: 'Only used with an address override. Defaults to the port the camera last answered on.',
                type: 'number',
                placeholder: this.storage.getItem('lastKnownPort') || '5051',
                value: this.storage.getItem('port') || '',
            },
            {
                group: 'Connection',
                key: 'lastKnown',
                title: 'Last Known Address',
                description: 'Where this camera last answered. Used automatically when mDNS does not reply.',
                value: this.storage.getItem('lastKnownHost')
                    ? `${this.storage.getItem('lastKnownHost')}:${this.storage.getItem('lastKnownPort')}`
                    : 'never connected',
                readonly: true,
            },
            {
                group: 'Info',
                key: 'accessoryId',
                title: 'Accessory ID',
                description: 'The HomeKit identifier this camera was paired with. Read only.',
                value: this.accessoryId,
                readonly: true,
            },
            {
                group: 'Info',
                key: 'capabilities',
                title: 'Camera Capabilities',
                description: 'What the camera advertised over HAP.',
                value: this.capabilities ? describeCapabilities(this.capabilities) : 'not yet connected',
                readonly: true,
            },
            {
                group: 'Info',
                key: 'debugLogging',
                title: 'Debug Logging',
                description: 'Logs the detail behind what this camera is doing: the accessory service graph, every characteristic event it pushes, '
                    + 'stream negotiation and startup timing, keyframe cadence, the RTSP exchange, and the two way audio encoder. '
                    + 'Far too noisy to leave on, but it is the only way to see why a camera is behaving oddly. Takes effect immediately, except for the RTSP exchange, which starts with the next stream.',
                type: 'boolean',
                value: this.debugLogging,
            },
            {
                group: 'Info',
                key: 'concurrentStreams',
                title: 'Concurrent Streams',
                description: 'How many simultaneous streams the camera supports. This is the hard limit on how many Scrypted consumers (rebroadcast, recording, detection) can watch at once.',
                value: this.streamServices.length ? `${this.streamServices.length}` : 'unknown',
                readonly: true,
            },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'restartStreams') {
            await this.restartStreams();
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }

        this.storage.setItem(key, value?.toString());
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);

        if (key === 'audioCodec' || key === 'maxBitrate' || key === 'allowBatteryPrebuffer' || key === 'keyframeRequests')
            this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);

        // Turning the hold off should take effect now rather than whenever the one already running
        // happens to expire, since the reason to turn it off is usually that it is holding motion on.
        if (key === 'motionTimeout' && !this.motionTimeout && this.motionClearTimer) {
            clearTimeout(this.motionClearTimer);
            this.motionClearTimer = undefined;
            this.endMotion();
        }

        // an address change has to take effect on a new connection, not the one already open.
        if (key === 'host' || key === 'port') {
            await this.release();
            this.initialize()
                .catch(e => this.console.error('failed to reconnect after the address changed', e));
        }
    }

    /**
     * Removes this controller's pairing from the accessory.
     *
     * Telling the accessory is what leaves it pairable again; without it the camera holds a
     * pairing for a controller that no longer exists and refuses any new pair-setup. That requires
     * reaching it, though, and the usual reason to unpair is that it cannot be reached. So a
     * failure here is reported rather than thrown: local credentials are cleared either way, and
     * the caller tells the user whether a factory reset is still needed.
     *
     * Returns true when the accessory itself was told.
     */
    async unpair(): Promise<boolean> {
        try {
            // the client is only built during initialize, so connect first if nothing has yet.
            await this.initialize();
            await this.client.unpair();
            this.console.log('removed this controller from the accessory');
            return true;
        }
        catch (e) {
            this.console.warn(`could not reach the camera to remove the pairing: ${(e as Error).message}`);
            return false;
        }
        finally {
            this.storage.removeItem('pairingData');
            this.storage.removeItem('accessoryId');
            await this.release();
        }
    }

    /** Tears down everything; called when the device is removed or the plugin unloads. */
    async release() {
        this.stopSensorPoll();
        clearTimeout(this.motionClearTimer);
        this.motionClearTimer = undefined;
        clearTimeout(this.stuckMotionTimer);
        this.stuckMotionTimer = undefined;
        this.motionOnSince = undefined;
        await this.stopIntercom();
        for (const session of this.sessions.keys())
            await session.stop().catch(() => { });
        this.sessions.clear();
        this.client?.stop();
        this.client = undefined;
        this.initialized = false;
    }
}
