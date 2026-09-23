import type { Resolution, RTCSignalingChannel } from '@scrypted/sdk';
import sdk, { AudioSensor, Camera, DeviceProvider, HumiditySensor, Intercom, MotionSensor, OnOff, ScryptedDevice, ScryptedDeviceType, ScryptedInterface, Thermometer, VideoCamera, VideoCameraConfiguration } from '@scrypted/sdk';
import { createCameraStorageSettings } from '../camera-mixin';
import { DummyDevice, addSupportedType, bindCharacteristic } from '../common';
import { AudioRecordingCodec, AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodec, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController, CameraRecordingConfiguration, CameraRecordingDelegate, CameraRecordingOptions, CameraStreamingOptions, Characteristic, CharacteristicEventTypes, H264Level, H264Profile, MediaContainerType, RecordingPacket, SRTPCryptoSuites, SecureVideoController, Service, VideoCodecType, WithUUID } from '../hap';
import type { HomeKitPlugin } from '../main';
import { setServiceName } from '../service-names';
import { createMultiTierRtpDelegate } from './camera/camera-multitier-rtp';
import { handleFragmentsRequests, iframeIntervalSeconds } from './camera/camera-recording';
import { createSecureVideoController, secureVideoCmafEnabled } from './camera/camera-secure-video';
import { createCameraStreamingDelegate } from './camera/camera-streaming';
import { FORCE_OPUS } from './camera/camera-utils';
import { createHomeKitWebRTCDelegate } from './camera/camera-webrtc';
import { getChildDevices, makeAccessory, mergeLightDevicesByType, mergeOnOffDevicesByType, mergeVolumeDevicesByType } from './common';

const { deviceManager, systemManager } = sdk;

const numberPrebufferSegments = 1;

addSupportedType({
    type: ScryptedDeviceType.Camera,
    probe(device: DummyDevice) {
        return device.interfaces.includes(ScryptedInterface.VideoCamera);
    },
    async getAccessory(device: ScryptedDevice & VideoCamera & VideoCameraConfiguration & Camera & MotionSensor & AudioSensor & Intercom & OnOff & Resolution, homekitPlugin: HomeKitPlugin) {
        const console = deviceManager.getMixinConsole(device.id, undefined);
        const storage = deviceManager.getMixinStorage(device.id, undefined);
        const cameraStorage = createCameraStorageSettings({ storage, onDeviceEvent: undefined });
        const secureVideo3 = cameraStorage.values.secureVideo3;
        const twoWayAudio = device.interfaces?.includes(ScryptedInterface.Intercom);

        const forceOpus = FORCE_OPUS;

        const codecs: AudioStreamingCodec[] = [];
        // homekit seems to prefer AAC_ELD if it is offered.
        // so forcing opus must be done by not offering AAC_ELD.
        const enabledStreamingCodecTypes = [
            AudioStreamingCodecType.OPUS,
        ];
        if (!forceOpus) {
            enabledStreamingCodecTypes.push(AudioStreamingCodecType.AAC_ELD);
        }
        for (const type of enabledStreamingCodecTypes) {
            for (const samplerate of [
                // required by watch
                AudioStreamingSamplerate.KHZ_8,
                // never seen this requested
                AudioStreamingSamplerate.KHZ_16,
                // requested (required?) by ios/mac.
                AudioStreamingSamplerate.KHZ_24
            ]) {
                codecs.push({
                    type,
                    samplerate,
                    // AudioBitrate.VARIABLE
                    bitrate: 0,
                    audioChannels: 1,
                });
                codecs.push({
                    type,
                    samplerate,
                    // AudioBitrate.CONSTANT
                    bitrate: 1,
                    audioChannels: 1,
                });
            }
        }

        const streamingOptions: CameraStreamingOptions = {
            video: {
                codec: {
                    levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                    profiles: [H264Profile.MAIN],
                },

                // HomeKit will request a resolution from this list, but it seems to do it
                // stupidly. For example, local network macOS on a 6k monitor requests the 480p stream?
                // so using the resolution for device fingerprinting can't be trusted.
                resolutions: [
                    // 3840x2160@30 (4k).
                    [3840, 2160, 30],
                    // 3K
                    [2880, 1620, 30],
                    // 2MP
                    [2560, 1440, 30],
                    // 1920x1080@30 (1080p).
                    [1920, 1080, 30],
                    // 1280x720@30 (720p).
                    [1280, 720, 30],
                    [960, 540, 30],
                    [640, 360, 30],
                    // 320x240@15 (Apple Watch).
                    [320, 240, 15],
                ]
            },
            audio: {
                codecs,
                twoWayAudio,
            },
            supportedCryptoSuites: [
                // not supported by ffmpeg
                // SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80,
                SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
                SRTPCryptoSuites.NONE,
            ]
        }

        let recordingDelegate: CameraRecordingDelegate | undefined;
        let recordingOptions: CameraRecordingOptions | undefined;

        const accessory = makeAccessory(device, homekitPlugin);

        const isRecordingEnabled = device.interfaces.includes(ScryptedInterface.MotionSensor);

        let configuration: CameraRecordingConfiguration;
        const openRecordingStreams = new Map<number, AsyncGenerator<RecordingPacket>>();
        if (isRecordingEnabled || secureVideo3) {
            recordingDelegate = {
                updateRecordingConfiguration(newConfiguration: CameraRecordingConfiguration) {
                    configuration = newConfiguration;
                },
                handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
                    const ret = handleFragmentsRequests(streamId, device, configuration, console, homekitPlugin, 
                        () => openRecordingStreams.has(streamId));
                    openRecordingStreams.set(streamId, ret);
                    return ret;
                },
                closeRecordingStream(streamId, reason) {
                    const r = openRecordingStreams.get(streamId);
                    console.log(`motion recording closed ${reason > 0 ? `(error code: ${reason})` : ''}`);
                    openRecordingStreams.delete(streamId);
                },
                updateRecordingActive(active) {
                },
            };

            const recordingCodecs: AudioRecordingCodec[] = [];
            const samplerate: AudioRecordingSamplerate[] = [];
            for (const sr of [
                // i believe more options may be causing issues with recordings
                // (see other half of change).
                // AudioRecordingSamplerate.KHZ_8,
                // AudioRecordingSamplerate.KHZ_16,
                // AudioRecordingSamplerate.KHZ_24,
                AudioRecordingSamplerate.KHZ_32,
                // AudioRecordingSamplerate.KHZ_44_1,
                // AudioRecordingSamplerate.KHZ_48,
            ]) {
                samplerate.push(sr);
            }

            // homekit seems to prefer AAC_ELD if it is offered.
            // so forcing AAC_LC must be done by not offering AAC_ELD.
            const enabledRecordingCodecTypes = [
                AudioRecordingCodecType.AAC_LC,
            ];
            if (!forceOpus) {
                enabledRecordingCodecTypes.push(AudioRecordingCodecType.AAC_ELD);
            }
            for (const type of enabledRecordingCodecTypes) {
                const entry: AudioRecordingCodec = {
                    type,
                    bitrateMode: 0,
                    samplerate,
                    audioChannels: 1,
                }
                recordingCodecs.push(entry);
            }

            // const recordingResolutions = [...nativeResolutions];
            // ensureHasWidthResolution(recordingResolutions, 1280, 720);
            // ensureHasWidthResolution(recordingResolutions, 1920, 1080);

            recordingOptions = {
                prebufferLength: numberPrebufferSegments * iframeIntervalSeconds * 1000,
                mediaContainerConfiguration: [
                    {
                        type: MediaContainerType.FRAGMENTED_MP4,
                        fragmentLength: iframeIntervalSeconds * 1000,
                    }
                ],
                video: {
                    type: VideoCodecType.H264,
                    parameters: {
                        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
                    },
                    resolutions: [
                        [1280, 720, 30],
                        [1920, 1080, 30],
                    ],
                },
                audio: {
                    codecs: recordingCodecs,
                },
            };
        }

        const delegate = createCameraStreamingDelegate(device, console, storage, homekitPlugin);

        const controller = secureVideo3
            ? createSecureVideoController(accessory, delegate.handleSnapshotRequest, console, recordingDelegate,
                tiers => createMultiTierRtpDelegate(device, tiers, console, storage),
                tiers => createHomeKitWebRTCDelegate(systemManager.getDeviceById<RTCSignalingChannel>(device.id), console, tiers[0]),
                device.resolution)
            : new CameraController({
                cameraStreamCount: 8,
                delegate,
                streamingOptions,
                recording: !isRecordingEnabled ? undefined : {
                    options: recordingOptions,
                    delegate: recordingDelegate,
                },
                sensors: {
                    motion: isRecordingEnabled,
                },
            });

        accessory.configureController(controller);

        if (controller instanceof SecureVideoController) {
            console.log('HomeKit Secure Video 3 multi-tier RTP, SFrame WebRTC, and HDS recording enabled.');
            if (secureVideoCmafEnabled)
                console.log('HSV3 CMAF services enabled for diagnostics; clip production is not implemented.');
            // logSecureVideoRequests(accessory, controller, console);
        }

        // Temperature/Humidity/Audio detection aren't part of HAP's CameraController - add them as
        // ordinary linked services on the camera's own accessory, same pattern sensor.ts already
        // uses for standalone Sensor-type accessories. Each service needs a distinct subtype so
        // they don't collide. Named by sensor kind alone rather than upstream's "<camera> <kind>":
        // these sit inside the camera's own accessory in the Home app, where the camera's name
        // would only repeat.
        if (device.interfaces.includes(ScryptedInterface.Thermometer)) {
            const service = accessory.addService(Service.TemperatureSensor, 'Temperature', 'Thermometer');
            setServiceName(service, 'Temperature');
            bindCharacteristic(device, ScryptedInterface.Thermometer, service, Characteristic.CurrentTemperature,
                () => (device as ScryptedDevice as ScryptedDevice & Thermometer).temperature || 0);
        }

        if (device.interfaces.includes(ScryptedInterface.HumiditySensor)) {
            const service = accessory.addService(Service.HumiditySensor, 'Humidity', 'HumiditySensor');
            setServiceName(service, 'Humidity');
            bindCharacteristic(device, ScryptedInterface.HumiditySensor, service, Characteristic.CurrentRelativeHumidity,
                () => (device as ScryptedDevice as ScryptedDevice & HumiditySensor).humidity || 0);
        }

        if (device.interfaces.includes(ScryptedInterface.AudioSensor)) {
            const service = accessory.addService(Service.ContactSensor, 'Sound', 'AudioSensor');
            setServiceName(service, 'Sound');
            bindCharacteristic(device, ScryptedInterface.AudioSensor, service, Characteristic.ContactSensorState,
                () => !!device.audioDetected);
        }

        if (controller.motionService && isRecordingEnabled) {
            const motionDevice = device;
            if (!motionDevice) {
                return;
            }

            const motionDetected = () => !!motionDevice.motionDetected;

            const { motionService } = controller;
            setServiceName(motionService, 'Motion');
            bindCharacteristic(motionDevice,
                ScryptedInterface.MotionSensor,
                motionService,
                Characteristic.MotionDetected,
                () => motionDetected(), true)

            const { recordingManagement } = controller;

            const persistBooleanCharacteristic = (service: Service, characteristic: WithUUID<{ new(): Characteristic }>) => {
                const property = `characteristic-v2-${characteristic.UUID}`
                service.getCharacteristic(characteristic)
                    .on(CharacteristicEventTypes.GET, callback => callback(null, storage.getItem(property) === 'true' ? 1 : 0))
                    .removeOnSet()
                    .on(CharacteristicEventTypes.SET, (value, callback) => {
                        callback();
                        storage.setItem(property, (!!value).toString());
                    });
            }

            // Status Light: if this camera is a DeviceProvider with a dedicated Status Light child
            // device (a nativeId ending ':statuslight' - a convention the nanit and
            // homekit-controller plugins both follow, as with Night Vision below), bind
            // the native CameraOperatingModeIndicator characteristic directly to that child's real
            // OnOff state instead of falling back to the generic branches below - otherwise the
            // native toggle in the camera's Home app settings sheet is a disconnected dummy
            // (persistBooleanCharacteristic, local storage only) while the real control lives
            // elsewhere as a separate merged switch. Unifying them avoids two different "Status
            // Light" controls on the same accessory where only one actually does anything.
            const statusLightDevice = device.interfaces.includes(ScryptedInterface.DeviceProvider)
                ? getChildDevices(device as ScryptedDevice as ScryptedDevice & DeviceProvider)
                    .find(child => child.nativeId?.endsWith(':statuslight')) as (ScryptedDevice & OnOff) | undefined
                : undefined;

            if (statusLightDevice) {
                const indicator = recordingManagement.operatingModeService.getCharacteristic(Characteristic.CameraOperatingModeIndicator);
                bindCharacteristic(statusLightDevice, ScryptedInterface.OnOff, recordingManagement.operatingModeService, Characteristic.CameraOperatingModeIndicator,
                    () => !!statusLightDevice.on);
                indicator.on(CharacteristicEventTypes.SET, (value, callback) => {
                    callback();
                    if (value)
                        statusLightDevice.turnOn();
                    else
                        statusLightDevice.turnOff();
                });
                homekitPlugin.mergedDevices.add(statusLightDevice.id);
            }
            else if (!device.interfaces.includes(ScryptedInterface.OnOff)) {
                persistBooleanCharacteristic(recordingManagement.operatingModeService, Characteristic.CameraOperatingModeIndicator);
            }
            else {
                const indicator = recordingManagement.operatingModeService.getCharacteristic(Characteristic.CameraOperatingModeIndicator);
                const linkStatusIndicator = storage.getItem('statusIndicator') === 'true';
                const property = `characteristic-v2-${Characteristic.CameraOperatingModeIndicator.UUID}`
                bindCharacteristic(device, ScryptedInterface.OnOff, recordingManagement.operatingModeService, Characteristic.CameraOperatingModeIndicator, () => {
                    if (!linkStatusIndicator)
                        return storage.getItem(property) === 'true' ? 1 : 0;

                    return device.on ? 1 : 0;
                });
                indicator.on(CharacteristicEventTypes.SET, (value, callback) => {
                    callback();
                    if (!linkStatusIndicator)
                        return storage.setItem(property, (!!value).toString());

                    if (value)
                        device.turnOn();
                    else
                        device.turnOff();
                });
            }

            // Night Vision: HAP's CameraOperatingMode service (the same service object as
            // recordingManagement.operatingModeService above) has an optional NightVision
            // characteristic - this is the toggle Apple's Home app shows in a camera's own
            // settings sheet for enabling/disabling automatic IR. There's no generic
            // ScryptedInterface for "night vision enable", so this looks for a specific child
            // device nativeId suffix - a deliberate convention shared with the nanit and
            // homekit-controller plugins, not a generic mechanism.
            if (device.interfaces.includes(ScryptedInterface.DeviceProvider)) {
                const nightVisionChildren = getChildDevices(device as ScryptedDevice as ScryptedDevice & DeviceProvider);
                const nightVisionAutoDevice = nightVisionChildren
                    .find(child => child.nativeId?.endsWith(':nightvision-auto')) as (ScryptedDevice & OnOff) | undefined;
                // The "On" (force-manual) child is used only for the OFF direction below - turning
                // its OnOff off explicitly forces night vision off and clears both switches,
                // unlike the Automatic switch's own turnOff() (which deliberately freezes the
                // current IR state instead of forcing it off, to avoid killing the picture when
                // just disabling auto-mode elsewhere). HomeKit's single boolean has no "freeze"
                // concept, so OFF here needs to mean truly off.
                const nightVisionOnDevice = nightVisionChildren
                    .find(child => child.nativeId?.endsWith(':nightvision-on')) as (ScryptedDevice & OnOff) | undefined;
                if (nightVisionAutoDevice) {
                    const nightVisionCharacteristic = recordingManagement.operatingModeService.getCharacteristic(Characteristic.NightVision);
                    bindCharacteristic(nightVisionAutoDevice, ScryptedInterface.OnOff, recordingManagement.operatingModeService, Characteristic.NightVision,
                        () => !!nightVisionAutoDevice.on);
                    nightVisionCharacteristic.on(CharacteristicEventTypes.SET, (value, callback) => {
                        callback();
                        if (value)
                            nightVisionAutoDevice.turnOn();
                        else
                            (nightVisionOnDevice ?? nightVisionAutoDevice).turnOff();
                    });
                    homekitPlugin.mergedDevices.add(nightVisionAutoDevice.id);
                }
            }
        }

        // if the camera is a device provider, merge in child devices and
        // ensure the devices are skipped by the rest of homekit by
        // reporting that they've been merged
        if (device.interfaces.includes(ScryptedInterface.DeviceProvider)) {
            // merge in lights (as lightbulbs, preserving brightness where available)
            mergeLightDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Light).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });

            // merge in sirens
            mergeOnOffDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Siren).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });

            // merge in remaining switches (Status Light and Night Vision Automatic are already
            // handled above as native camera characteristics and excluded here via mergedDevices)
            mergeOnOffDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Switch, homekitPlugin.mergedDevices).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });

            // merge in speaker volume controls (experimental - see mergeVolumeDevicesByType)
            mergeVolumeDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Speaker).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });
        }

        return accessory;
    }
});
