// HAP service and characteristic UUIDs. Accessories are permitted to abbreviate the Apple defined
// UUIDs down to their significant hex digits, so everything is compared through normalize().

const HAP_UUID_SUFFIX = '-0000-1000-8000-0026BB765291';

// Expands a short form UUID ("3E", "110") to its full form, and lowercases everything so that
// comparisons are stable regardless of how the accessory chose to spell it.
export function normalizeUuid(uuid: string): string {
    if (!uuid)
        return uuid;
    let value = uuid.toUpperCase();
    if (value.length <= 8)
        value = value.padStart(8, '0') + HAP_UUID_SUFFIX;
    return value.toLowerCase();
}

export function uuidEquals(a: string, b: string): boolean {
    return normalizeUuid(a) === normalizeUuid(b);
}

export const Service = {
    AccessoryInformation: normalizeUuid('3E'),
    ProtocolInformation: normalizeUuid('A2'),
    CameraRTPStreamManagement: normalizeUuid('110'),
    CameraOperatingMode: normalizeUuid('21A'),
    CameraEventRecordingManagement: normalizeUuid('204'),
    Microphone: normalizeUuid('112'),
    Speaker: normalizeUuid('113'),
    MotionSensor: normalizeUuid('85'),
    OccupancySensor: normalizeUuid('86'),
    ContactSensor: normalizeUuid('80'),
    Doorbell: normalizeUuid('121'),
    StatelessProgrammableSwitch: normalizeUuid('89'),
    Battery: normalizeUuid('96'),
    TemperatureSensor: normalizeUuid('8A'),
    HumiditySensor: normalizeUuid('82'),
    LightSensor: normalizeUuid('84'),
    AirQualitySensor: normalizeUuid('8D'),
    Switch: normalizeUuid('49'),
    Lightbulb: normalizeUuid('43'),
    Outlet: normalizeUuid('47'),
    LockMechanism: normalizeUuid('45'),
    GarageDoorOpener: normalizeUuid('41'),
    Thermostat: normalizeUuid('4A'),
    SecuritySystem: normalizeUuid('7E'),
    LeakSensor: normalizeUuid('83'),
    SmokeSensor: normalizeUuid('87'),
    CarbonMonoxideSensor: normalizeUuid('7F'),
    Fan: normalizeUuid('40'),
    Fanv2: normalizeUuid('B7'),
    WindowCovering: normalizeUuid('8C'),
};

export const Characteristic = {
    // accessory information
    Identify: normalizeUuid('14'),
    Manufacturer: normalizeUuid('20'),
    Model: normalizeUuid('21'),
    Name: normalizeUuid('23'),
    SerialNumber: normalizeUuid('30'),
    FirmwareRevision: normalizeUuid('52'),
    HardwareRevision: normalizeUuid('53'),

    // camera streaming
    StreamingStatus: normalizeUuid('120'),
    SupportedVideoStreamConfiguration: normalizeUuid('114'),
    SupportedAudioStreamConfiguration: normalizeUuid('115'),
    SupportedRTPConfiguration: normalizeUuid('116'),
    SelectedRTPStreamConfiguration: normalizeUuid('117'),
    SetupEndpoints: normalizeUuid('118'),

    // camera controls
    Volume: normalizeUuid('119'),
    Mute: normalizeUuid('11A'),
    NightVision: normalizeUuid('11B'),
    OpticalZoom: normalizeUuid('11C'),
    DigitalZoom: normalizeUuid('11D'),
    ImageRotation: normalizeUuid('11E'),
    ImageMirroring: normalizeUuid('11F'),

    // camera operating mode / HKSV on the accessory side
    EventSnapshotsActive: normalizeUuid('223'),
    HomeKitCameraActive: normalizeUuid('21B'),
    ThirdPartyCameraActive: normalizeUuid('21C'),
    CameraOperatingModeIndicator: normalizeUuid('21D'),
    PeriodicSnapshotsActive: normalizeUuid('225'),
    ManuallyDisabled: normalizeUuid('227'),
    RecordingAudioActive: normalizeUuid('226'),

    // sensors
    MotionDetected: normalizeUuid('22'),
    OccupancyDetected: normalizeUuid('71'),
    ContactSensorState: normalizeUuid('6A'),
    ProgrammableSwitchEvent: normalizeUuid('73'),
    StatusActive: normalizeUuid('75'),
    StatusFault: normalizeUuid('77'),
    StatusLowBattery: normalizeUuid('79'),
    StatusTampered: normalizeUuid('7A'),
    BatteryLevel: normalizeUuid('68'),
    ChargingState: normalizeUuid('8F'),
    CurrentTemperature: normalizeUuid('11'),
    CurrentRelativeHumidity: normalizeUuid('10'),
    CurrentAmbientLightLevel: normalizeUuid('6B'),
    AirQuality: normalizeUuid('95'),

    // generic
    On: normalizeUuid('25'),
    Brightness: normalizeUuid('8'),
    Hue: normalizeUuid('13'),
    Saturation: normalizeUuid('2F'),
    Active: normalizeUuid('B0'),
};

// Reverse lookups, for logs. An accessory is a list of numbers until its UUIDs are named, and
// working out which characteristic an event came from by hand is the slow part of diagnosing one.
const serviceNames = new Map(Object.entries(Service).map(([name, uuid]) => [uuid, name]));
const characteristicNames = new Map(Object.entries(Characteristic).map(([name, uuid]) => [uuid, name]));

/** The Apple name for a service UUID, or its short form when it is one this plugin does not know. */
export function serviceName(uuid: string): string {
    return serviceNames.get(normalizeUuid(uuid)) || shortUuid(uuid);
}

/** The Apple name for a characteristic UUID, or its short form when unrecognized. */
export function characteristicName(uuid: string): string {
    return characteristicNames.get(normalizeUuid(uuid)) || shortUuid(uuid);
}

/** Trims an Apple UUID back to the significant digits accessories are allowed to abbreviate to. */
function shortUuid(uuid: string): string {
    const normalized = normalizeUuid(uuid);
    if (!normalized?.toUpperCase().endsWith(HAP_UUID_SUFFIX))
        return uuid;
    return normalized.substring(0, 8).replace(/^0+/, '').toUpperCase();
}

// HAP accessory categories, used to pick a sensible Scrypted device type after discovery.
export enum Category {
    OTHER = 1,
    BRIDGE = 2,
    FAN = 3,
    GARAGE_DOOR_OPENER = 4,
    LIGHTBULB = 5,
    DOOR_LOCK = 6,
    OUTLET = 7,
    SWITCH = 8,
    THERMOSTAT = 9,
    SENSOR = 10,
    SECURITY_SYSTEM = 11,
    DOOR = 12,
    WINDOW = 13,
    WINDOW_COVERING = 14,
    PROGRAMMABLE_SWITCH = 15,
    RANGE_EXTENDER = 16,
    IP_CAMERA = 17,
    VIDEO_DOORBELL = 18,
    AIR_PURIFIER = 19,
    HEATER = 20,
    AIR_CONDITIONER = 21,
    HUMIDIFIER = 22,
    DEHUMIDIFIER = 23,
    SPRINKLER = 28,
    FAUCET = 29,
    SHOWER_HEAD = 30,
    TELEVISION = 31,
    TARGET_CONTROLLER = 32,
}
