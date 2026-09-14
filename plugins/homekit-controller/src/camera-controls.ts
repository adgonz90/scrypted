// The accessory's non-streaming controls, exposed as child devices of the camera.
//
// A HomeKit camera is rarely just a camera: baby monitors carry a night light and a speaker,
// doorbells carry a chime and a microphone, and most cameras carry operating mode switches for
// night vision and the status LED. HAP models all of these as ordinary services alongside the
// camera, so they are surfaced here as child devices rather than being dropped.
//
// Naming matters. Scrypted's HomeKit plugin merges a camera's children back onto the single
// HomeKit accessory rather than publishing them as separate tiles, and it keys some of that off
// specific nativeId suffixes (`:statuslight`, `:nightvision-auto`) so the Home app's own camera
// settings sheet drives the real control instead of a dummy. The suffixes below are chosen to
// match those hooks.

import {
    AudioVolumeControl,
    AudioVolumes,
    Brightness,
    ColorHsv,
    ColorSettingHsv,
    OnOff,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
} from '@scrypted/sdk';
import { HapAccessory, HapService } from './hap/types';
import { findCharacteristic, findServices } from './hap/client';
import { Characteristic, Service } from './hap/uuids';

/** A characteristic this control reads and writes, by instance id. */
interface CharacteristicRef {
    iid: number;
    // some HAP characteristics are the logical inverse of the Scrypted property, such as a
    // microphone Mute against an "on" switch.
    inverted?: boolean;
}

export interface ControlDescriptor {
    nativeId: string;
    name: string;
    type: ScryptedDeviceType;
    interfaces: string[];
    aid: number;

    on?: CharacteristicRef;
    brightness?: CharacteristicRef;
    hue?: CharacteristicRef;
    saturation?: CharacteristicRef;
    volume?: CharacteristicRef;
}

// The parent camera, reduced to what a control actually needs from it.
export interface ControlHost {
    readonly console: Console;
    writeCharacteristic(aid: number, iid: number, value: any): Promise<void>;
}

export class HomeKitCameraControl extends ScryptedDeviceBase implements OnOff, Brightness, ColorSettingHsv, AudioVolumeControl {
    constructor(public host: ControlHost, nativeId: string, public descriptor: ControlDescriptor) {
        super(nativeId);
    }

    /** Applies a value that arrived from the accessory, by characteristic instance id. */
    apply(iid: number, value: any) {
        const { on, brightness, hue, saturation, volume } = this.descriptor;

        if (on && iid === on.iid) {
            // HAP sends booleans as 0 and 1.
            this.on = on.inverted ? !value : !!value;
            return;
        }
        if (brightness && iid === brightness.iid) {
            this.brightness = value;
            this.syncHsv();
            return;
        }
        if ((hue && iid === hue.iid) || (saturation && iid === saturation.iid)) {
            this.syncHsv(iid === hue?.iid ? value : undefined, iid === saturation?.iid ? value : undefined);
            return;
        }
        if (volume && iid === volume.iid) {
            this.audioVolumes = { speaker: value };
        }
    }

    private lastHue = 0;
    private lastSaturation = 0;

    private syncHsv(hue?: number, saturation?: number) {
        if (hue !== undefined)
            this.lastHue = hue;
        if (saturation !== undefined)
            this.lastSaturation = saturation;
        if (!this.descriptor.hue)
            return;

        const hsv: ColorHsv = {
            h: this.lastHue,
            // Scrypted expresses saturation and value as 0..1; HAP uses percentages.
            s: this.lastSaturation / 100,
            v: (this.brightness ?? 100) / 100,
        };
        this.hsv = hsv;
    }

    async turnOn(): Promise<void> {
        await this.setOn(true);
    }

    async turnOff(): Promise<void> {
        await this.setOn(false);
    }

    private async setOn(value: boolean) {
        const { on, aid } = this.descriptor;
        if (!on)
            throw new Error('this control has no on/off characteristic');
        await this.host.writeCharacteristic(aid, on.iid, on.inverted ? !value : value);
        this.on = value;
    }

    async setBrightness(brightness: number): Promise<void> {
        const { brightness: ref, aid } = this.descriptor;
        if (!ref)
            throw new Error('this control has no brightness characteristic');
        const clamped = Math.max(0, Math.min(100, Math.round(brightness)));
        await this.host.writeCharacteristic(aid, ref.iid, clamped);
        this.brightness = clamped;
    }

    async setHsv(hue: number, saturation: number, value: number): Promise<void> {
        const { hue: hueRef, saturation: saturationRef, brightness: brightnessRef, aid } = this.descriptor;
        if (!hueRef || !saturationRef)
            throw new Error('this control has no color characteristics');

        await this.host.writeCharacteristic(aid, hueRef.iid, Math.max(0, Math.min(360, Math.round(hue))));
        await this.host.writeCharacteristic(aid, saturationRef.iid, Math.max(0, Math.min(100, Math.round(saturation * 100))));
        if (brightnessRef)
            await this.setBrightness(value * 100);

        this.lastHue = hue;
        this.lastSaturation = saturation * 100;
        this.syncHsv();
    }

    async setAudioVolumes(audioVolumes: AudioVolumes): Promise<void> {
        const { volume, aid } = this.descriptor;
        if (!volume)
            throw new Error('this control has no volume characteristic');

        // the speaker key is the one HomeKit cameras expose; accept any single provided value.
        const value = audioVolumes.speaker ?? Object.values(audioVolumes)[0];
        if (value === undefined)
            return;

        const clamped = Math.max(0, Math.min(100, Math.round(value)));
        await this.host.writeCharacteristic(aid, volume.iid, clamped);
        this.audioVolumes = { speaker: clamped };
    }
}

// A boolean characteristic on the camera operating mode service, and the child it becomes. The
// first two suffixes are what Scrypted's HomeKit plugin looks for to drive the Home app's native
// camera settings toggles instead of publishing a duplicate switch.
const OPERATING_MODE_SWITCHES: { type: string, suffix: string, name: string, inverted?: boolean }[] = [
    { type: Characteristic.CameraOperatingModeIndicator, suffix: 'statuslight', name: 'Status Light' },
    { type: Characteristic.NightVision, suffix: 'nightvision-auto', name: 'Night Vision' },
    { type: Characteristic.HomeKitCameraActive, suffix: 'camera-active', name: 'Camera Active' },
    // HAP states this one as "disabled", which reads backwards as a switch.
    { type: Characteristic.ManuallyDisabled, suffix: 'camera-enabled', name: 'Camera Enabled', inverted: true },
    { type: Characteristic.EventSnapshotsActive, suffix: 'event-snapshots', name: 'Event Snapshots' },
    { type: Characteristic.PeriodicSnapshotsActive, suffix: 'periodic-snapshots', name: 'Periodic Snapshots' },
    { type: Characteristic.RecordingAudioActive, suffix: 'recording-audio', name: 'Recording Audio' },
];

/**
 * Walks the accessory graph and describes every control worth exposing as a child device.
 *
 * Services are addressed by instance id where an accessory could plausibly have more than one
 * (lights, switches), and by a fixed suffix where it cannot, so that nativeIds stay stable across
 * restarts and firmware updates.
 */
export function discoverControls(accessory: HapAccessory, parentNativeId: string, cameraName: string): ControlDescriptor[] {
    const controls: ControlDescriptor[] = [];
    const aid = accessory.aid;

    const characteristicName = (service: HapService, fallback: string) =>
        findCharacteristic(service, Characteristic.Name)?.value || fallback;

    // ---- lights: the night light on a baby monitor, or a doorbell's illuminator ----
    const lights = [
        ...findServices(accessory, Service.Lightbulb),
    ];
    for (const service of lights) {
        const on = findCharacteristic(service, Characteristic.On);
        if (!on)
            continue;

        const brightness = findCharacteristic(service, Characteristic.Brightness);
        const hue = findCharacteristic(service, Characteristic.Hue);
        const saturation = findCharacteristic(service, Characteristic.Saturation);

        const interfaces = [ScryptedInterface.OnOff];
        if (brightness)
            interfaces.push(ScryptedInterface.Brightness);
        if (hue && saturation)
            interfaces.push(ScryptedInterface.ColorSettingHsv);

        controls.push({
            nativeId: `${parentNativeId}:light-${service.iid}`,
            name: characteristicName(service, lights.length > 1 ? `${cameraName} Light ${service.iid}` : `${cameraName} Light`),
            type: ScryptedDeviceType.Light,
            interfaces,
            aid,
            on: { iid: on.iid },
            brightness: brightness ? { iid: brightness.iid } : undefined,
            hue: hue ? { iid: hue.iid } : undefined,
            saturation: saturation ? { iid: saturation.iid } : undefined,
        });
    }

    // ---- plain switches and outlets ----
    const switches = [
        ...findServices(accessory, Service.Switch),
        ...findServices(accessory, Service.Outlet),
    ];
    for (const service of switches) {
        const on = findCharacteristic(service, Characteristic.On);
        if (!on)
            continue;

        controls.push({
            nativeId: `${parentNativeId}:switch-${service.iid}`,
            name: characteristicName(service, `${cameraName} Switch`),
            type: ScryptedDeviceType.Switch,
            interfaces: [ScryptedInterface.OnOff],
            aid,
            on: { iid: on.iid },
        });
    }

    // ---- speaker: volume, and mute as a separate switch ----
    const speaker = findServices(accessory, Service.Speaker)[0];
    if (speaker) {
        const volume = findCharacteristic(speaker, Characteristic.Volume);
        const mute = findCharacteristic(speaker, Characteristic.Mute);

        if (volume) {
            controls.push({
                nativeId: `${parentNativeId}:speaker`,
                name: `${cameraName} Speaker`,
                type: ScryptedDeviceType.Speaker,
                interfaces: [ScryptedInterface.AudioVolumeControl],
                aid,
                volume: { iid: volume.iid },
            });
        }

        if (mute) {
            controls.push({
                nativeId: `${parentNativeId}:speaker-mute`,
                name: `${cameraName} Speaker Enabled`,
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
                aid,
                // on means audible, which is the opposite of HAP's Mute.
                on: { iid: mute.iid, inverted: true },
            });
        }
    }

    // ---- microphone mute ----
    const microphone = findServices(accessory, Service.Microphone)[0];
    if (microphone) {
        const mute = findCharacteristic(microphone, Characteristic.Mute);
        if (mute) {
            controls.push({
                nativeId: `${parentNativeId}:microphone`,
                name: `${cameraName} Microphone`,
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
                aid,
                on: { iid: mute.iid, inverted: true },
            });
        }

        const volume = findCharacteristic(microphone, Characteristic.Volume);
        if (volume) {
            controls.push({
                nativeId: `${parentNativeId}:microphone-volume`,
                name: `${cameraName} Microphone Volume`,
                type: ScryptedDeviceType.Speaker,
                interfaces: [ScryptedInterface.AudioVolumeControl],
                aid,
                volume: { iid: volume.iid },
            });
        }
    }

    // ---- operating mode toggles ----
    // NightVision lives on the camera operating mode service on newer accessories and on the
    // stream management service on older ones, so both are searched.
    const modeServices = [
        ...findServices(accessory, Service.CameraOperatingMode),
        ...findServices(accessory, Service.CameraRTPStreamManagement).slice(0, 1),
    ];

    const seen = new Set<string>();
    for (const service of modeServices) {
        for (const entry of OPERATING_MODE_SWITCHES) {
            if (seen.has(entry.suffix))
                continue;
            const characteristic = findCharacteristic(service, entry.type);
            if (!characteristic)
                continue;
            // a read only characteristic is a status report, not a control.
            if (characteristic.perms && !characteristic.perms.includes('pw'))
                continue;

            seen.add(entry.suffix);
            controls.push({
                nativeId: `${parentNativeId}:${entry.suffix}`,
                name: `${cameraName} ${entry.name}`,
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
                aid,
                on: { iid: characteristic.iid, inverted: entry.inverted },
            });
        }
    }

    return controls;
}

/** The initial values for a control, read out of the cached accessory database. */
export function seedControl(control: HomeKitCameraControl, accessory: HapAccessory) {
    const byIid = new Map<number, any>();
    for (const service of accessory.services) {
        for (const characteristic of service.characteristics)
            byIid.set(characteristic.iid, characteristic.value);
    }

    for (const ref of [control.descriptor.on, control.descriptor.brightness, control.descriptor.hue,
    control.descriptor.saturation, control.descriptor.volume]) {
        if (!ref)
            continue;
        const value = byIid.get(ref.iid);
        if (value !== undefined && value !== null)
            control.apply(ref.iid, value);
    }
}
