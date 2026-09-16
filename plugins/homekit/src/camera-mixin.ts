import { SettingsMixinDeviceOptions } from "@scrypted/common/src/settings-mixin";
import sdk, { Readme, ScryptedDeviceType, ScryptedInterface, Setting, SettingValue, VideoCamera } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";
import { HomekitMixin } from "./homekit-mixin";
import { getDebugMode } from "./types/camera/camera-debug-mode-storage";
import { defaultMaxDurationSeconds, defaultMotionGraceSeconds } from "./types/camera/camera-recording-limits";

const { systemManager, deviceManager, log } = sdk;

export const defaultObjectDetectionContactSensorTimeout = 60;

export function canCameraMixin(type: ScryptedDeviceType | string, interfaces: string[]) {
    return (type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell)
        && interfaces.includes(ScryptedInterface.VideoCamera);
}

export function createCameraStorageSettings(device: StorageSettingsDevice) {
    return new StorageSettings(device, {
        secureVideo3Html: {
            title: 'HomeKit Secure Video 3',
            subgroup: 'Pairing',
            type: 'html',
            defaultValue: `<div style="color: red; padding-bottom: 16px;">HomeKit Secure Video 3 is experimental and is not recommended for most cameras. Refer to the <a target="_blank" href="https://docs.scrypted.app/homekit.html#homekit-secure-video-v3">documentation.</a></div>`,
        },
        secureVideo3: {
            title: 'HomeKit Secure Video 3',
            subgroup: 'Pairing',
            description: 'Toggle HomeKit Secure Video 3. Changing this setting will reset the accessory pairing and reload the HomeKit plugin. The device must be re-paired.',
            type: 'boolean',
            defaultValue: false,
        },
        secureVideo3UseSystemClock: {
            title: 'Use System Clock for Video',
            subgroup: 'Pairing',
            description: 'Use local send timing for HomeKit Secure Video 3 native RTP video timestamps to reduce stuttering from irregular camera delivery. Changes apply when the live stream is restarted.',
            type: 'boolean',
            defaultValue: true,
        },
        hasWarnedBridgedCamera: {
            description: 'Setting to warn user that bridged cameras are bad.',
            type: 'boolean',
            hide: true,
        },
        doorbellAutomationButton: {
            title: 'Doorbell Automation Button',
            type: 'boolean',
            description: 'Add an unconfigured doorbell button to HomeKit that can be used to create automations.',
            hide: true,
        },
        hksvMotionGrace: {
            title: 'Recording Grace Period',
            subgroup: 'Recording',
            description: 'How long a recording keeps running after motion clears, in seconds. HomeKit normally ends a recording itself; this only ends one it has left open. Raise it for a camera that reports motion as short pulses, where too low a value splits one event into several clips.',
            type: 'number',
            defaultValue: defaultMotionGraceSeconds,
        },
        hksvMaxDuration: {
            title: 'Recording Maximum Duration',
            subgroup: 'Recording',
            description: 'The longest a single recording may run, in seconds, no matter how long motion lasts. This is the backstop for a motion sensor stuck on, which would otherwise record without end.',
            type: 'number',
            defaultValue: defaultMaxDurationSeconds,
        },
    });
}

export class CameraMixin extends HomekitMixin<Readme & VideoCamera> implements Readme {
    cameraStorageSettings = createCameraStorageSettings(this);

    constructor(options: SettingsMixinDeviceOptions<Readme & VideoCamera>) {
        super(options);

        this.storageSettings.settings.standalone.persistedDefaultValue = true;
        this.cameraStorageSettings.settings.doorbellAutomationButton.hide = this.type !== ScryptedDeviceType.Doorbell;
        this.cameraStorageSettings.settings.secureVideo3.onPut = (oldValue, newValue) => {
            if (oldValue !== newValue)
                this.alertReload();
        };

        // HomeKit Secure Video is only offered for a camera that reports motion, so without one
        // there is no recording for these to bound.
        const canRecord = this.interfaces.includes(ScryptedInterface.MotionSensor);
        this.cameraStorageSettings.settings.hksvMotionGrace.hide = !canRecord;
        this.cameraStorageSettings.settings.hksvMaxDuration.hide = !canRecord;

        if (!this.cameraStorageSettings.values.hasWarnedBridgedCamera && !this.storageSettings.values.standalone) {
            this.cameraStorageSettings.values.hasWarnedBridgedCamera = true;
            log.a(`${this.name} is paired in Bridge Mode. Using Accessory Mode is recommended for cameras for optimal performance.`)
        }

        this.cameraStorageSettings.settings.secureVideo3.onPut = (oldValue, newValue) => {
            this.storageSettings.values.resetAccessory = 'RESET';
        }
    }

    async getReadmeMarkdown(): Promise<string> {
        let readme = this.mixinDeviceInterfaces.includes(ScryptedInterface.Readme) ? await this.mixinDevice.getReadmeMarkdown() + '\n\n' : '';

        if (!this.storageSettings.values.standalone) {
            readme += `
## <span style="color:red">HomeKit Performance Warning</span>

HomeKit Cameras should be paired to HomeKit in Accessory Mode for optimal performance. iOS 15.5+ will always route bridged camera video through the active HomeHub, which may result in severe performance degradation.

Enable Standalone Accessory Mode in the HomeKit settings for this camera and reload the HomeKit plugin. This camera can then be individually paired with the Home app. The pairing QR code can be seen in this camera\'s console.

More details can be found [here](https://github.com/koush/scrypted/blob/main/plugins/homekit/notes/iOS-15.5.md).
`;
        }

        const id = deviceManager.getDeviceState(this.mixinProviderNativeId).id;
        readme += `
## HomeKit Codec Settings

The recommended codec settings for cameras in HomeKit can be viewed in the [HomeKit plugin](#/device/${id}).

## HomeKit Troubleshooting

The latest troubleshooting guide for all known streaming or recording issues can be viewed in the [HomeKit plugin](#/device/${id}).`;

        if (this.storageSettings.values.standalone) {
            readme += `

## HomeKit Pairing

${this.storageSettings.values.pincode}
${this.storageSettings.values.qrCode}
            `
        }

        return readme;
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = [];

        // settings.push({
        //     title: 'H265 Streams',
        //     key: 'h265Support',
        //     description: 'Camera outputs h265 codec streams.',
        //     value: (this.storage.getItem('h265Support') === 'true').toString(),
        //     type: 'boolean',
        // });

        settings.push({
            title: 'RTP Sender',
            subgroup: 'Debug',
            key: 'rtpSender',
            description: 'The RTP Sender used by Scrypted. FFMpeg is stable. Scrypted is experimental and much faster.',
            choices: [
                'Default',
                'Scrypted',
                'FFmpeg',
            ],
            value: this.storage.getItem('rtpSender') || 'Default',
        });

        let debugMode = getDebugMode(this.storage);

        settings.push({
            title: 'Debug Mode',
            subgroup: 'Debug',
            key: 'debugMode',
            description: 'Force transcoding on this camera for streaming and recording, save recordings to disk, or log every recording fragment. These can be used to diagnose errors with HomeKit functionality, and all of them are expensive to leave on. Enable the Rebroadcast plugin for more robust transcoding options.',
            choices: [
                'Transcode Video',
                'Transcode Audio',
                'Save Recordings',
                'Verbose Logging',
            ],
            multiple: true,
            value: debugMode.value,
        });

        if (this.interfaces.includes(ScryptedInterface.OnOff)) {
            settings.push({
                title: 'Camera Status Indicator',
                description: 'Allow HomeKit to control the camera status indicator light.',
                key: 'statusIndicator',
                value: this.storage.getItem('statusIndicator') === 'true',
                type: 'boolean',
            });
        }

        return [...await super.getMixinSettings(), ...settings, ...await this.cameraStorageSettings.getSettings()];
    }

    async putMixinSetting(key: string, value: SettingValue) {
        if (this.storageSettings.settings[key]) {
            return super.putMixinSetting(key, value);
        }
        if (this.cameraStorageSettings.settings[key]) {
            return this.cameraStorageSettings.putSetting(key, value);
        }

        if (key === 'debugMode') {
            this.storage.setItem(key, JSON.stringify(value));
        }
        else {
            this.storage.setItem(key, value?.toString() || '');
        }

        deviceManager.onMixinEvent(this.id, this, ScryptedInterface.Settings, undefined);
    }
}
