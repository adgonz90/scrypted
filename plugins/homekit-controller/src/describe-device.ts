// Maps a paired accessory's service graph onto the Scrypted device it should become.
//
// This lives apart from both the provider and the device because both need it: the provider calls
// it once at pairing time, and the device calls it again on every startup so that a camera keeps
// up with firmware changes, and so that cameras paired by an older version of this plugin gain
// interfaces that were added since.

import { Device, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { discoverControls } from './camera-controls';
import { HapAccessory } from './hap/types';
import { Category, Characteristic, Service, uuidEquals } from './hap/uuids';

export function describeDevice(accessory: HapAccessory, category: Category, name: string, nativeId: string): Device {
    const has = (type: string) => accessory.services.some(service => uuidEquals(service.type, type));

    const isDoorbell = has(Service.Doorbell) || category === Category.VIDEO_DOORBELL;

    const interfaces: string[] = [
        ScryptedInterface.Camera,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.Settings,
        ScryptedInterface.Online,
    ];

    // Scrypted's HomeKit plugin turns on HomeKit Secure Video for any camera that reports motion,
    // so forwarding the accessory's own motion sensor is what makes recording work downstream.
    if (has(Service.MotionSensor))
        interfaces.push(ScryptedInterface.MotionSensor);

    if (isDoorbell || has(Service.StatelessProgrammableSwitch))
        interfaces.push(ScryptedInterface.BinarySensor);

    if (has(Service.Battery)) {
        interfaces.push(ScryptedInterface.Battery);

        // Reporting the charger matters more than it looks. Rebroadcast will not prebuffer a
        // device that claims a battery unless it also claims a charger and says it is charging,
        // and no prebuffer means no HomeKit Secure Video. Mains powered cameras that carry a
        // backup battery, such as baby monitors, land exactly on this.
        const battery = accessory.services.find(service => uuidEquals(service.type, Service.Battery));
        if (battery?.characteristics.some(c => uuidEquals(c.type, Characteristic.ChargingState)))
            interfaces.push(ScryptedInterface.Charger);
    }

    // a speaker service means the camera can play back audio we send it.
    if (has(Service.Speaker))
        interfaces.push(ScryptedInterface.Intercom);

    // Environmental sensors, common on baby monitors. The HomeKit plugin re-publishes temperature
    // and humidity as linked services on the camera accessory, so these survive back into Home.
    if (has(Service.TemperatureSensor))
        interfaces.push(ScryptedInterface.Thermometer);

    if (has(Service.HumiditySensor))
        interfaces.push(ScryptedInterface.HumiditySensor);

    if (has(Service.AirQualitySensor))
        interfaces.push(ScryptedInterface.AirQualitySensor);

    if (has(Service.LightSensor))
        interfaces.push(ScryptedInterface.AmbientLightSensor);

    if (has(Service.OccupancySensor))
        interfaces.push(ScryptedInterface.OccupancySensor);

    // Lights, switches, speaker volume and the operating mode toggles become child devices, which
    // requires the camera itself to be a DeviceProvider. Only claim it when there is something to
    // provide, so a bare camera does not grow an empty children list.
    if (discoverControls(accessory, nativeId, name).length)
        interfaces.push(ScryptedInterface.DeviceProvider);

    return {
        nativeId,
        name,
        type: isDoorbell ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera,
        interfaces,
    };
}
