// HomeKit Accessory Protocol constants, from the HAP specification and cross checked against
// hap-nodejs's accessory side implementation, which this plugin is the mirror image of.

// ---------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------

export enum PairingTLV {
    METHOD = 0x00,
    IDENTIFIER = 0x01,
    SALT = 0x02,
    PUBLIC_KEY = 0x03,
    PROOF = 0x04,
    ENCRYPTED_DATA = 0x05,
    STATE = 0x06,
    ERROR = 0x07,
    RETRY_DELAY = 0x08,
    CERTIFICATE = 0x09,
    SIGNATURE = 0x0a,
    PERMISSIONS = 0x0b,
    FRAGMENT_DATA = 0x0c,
    FRAGMENT_LAST = 0x0d,
    FLAGS = 0x13,
    // The pairing TLV table reserves 0xff as a separator. Camera TLVs instead delimit list
    // entries with an empty item of type 0x00 - see TLV_DELIMITER in tlv.ts.
    SEPARATOR = 0xff,
}

export enum PairMethod {
    PAIR_SETUP = 0x00,
    PAIR_SETUP_WITH_AUTH = 0x01,
    PAIR_VERIFY = 0x02,
    ADD_PAIRING = 0x03,
    REMOVE_PAIRING = 0x04,
    LIST_PAIRINGS = 0x05,
}

export enum PairingError {
    UNKNOWN = 0x01,
    AUTHENTICATION = 0x02,
    BACKOFF = 0x03,
    MAX_PEERS = 0x04,
    MAX_TRIES = 0x05,
    UNAVAILABLE = 0x06,
    BUSY = 0x07,
}

export const pairingErrorMessages: Record<number, string> = {
    [PairingError.UNKNOWN]: 'the accessory reported an unknown error',
    [PairingError.AUTHENTICATION]: 'the setup code was rejected',
    [PairingError.BACKOFF]: 'too many failed attempts, the accessory is throttling; wait and retry',
    [PairingError.MAX_PEERS]: 'the accessory has no free pairing slots',
    [PairingError.MAX_TRIES]: 'too many failed setup code attempts; the accessory must be reset',
    [PairingError.UNAVAILABLE]: 'the accessory is already paired to another controller and will not accept a new pairing. remove it from the Home app or factory reset it first',
    [PairingError.BUSY]: 'the accessory is busy; retry shortly',
};

export enum PairingPermission {
    USER = 0x00,
    ADMIN = 0x01,
}

// ---------------------------------------------------------------------------------------------
// Camera RTP stream management
// ---------------------------------------------------------------------------------------------

export enum SupportedVideoStreamConfigurationTLV {
    VIDEO_CODEC_CONFIGURATION = 0x01,
}

export enum VideoCodecConfigurationTLV {
    CODEC_TYPE = 0x01,
    CODEC_PARAMETERS = 0x02,
    ATTRIBUTES = 0x03,
}

export enum VideoCodecParametersTLV {
    PROFILE_ID = 0x01,
    LEVEL = 0x02,
    PACKETIZATION_MODE = 0x03,
    CVO_ENABLED = 0x04,
    CVO_ID = 0x05,
}

export enum VideoAttributesTLV {
    IMAGE_WIDTH = 0x01,
    IMAGE_HEIGHT = 0x02,
    FRAME_RATE = 0x03,
}

export enum VideoCodecType {
    H264 = 0x00,
}

export enum H264Profile {
    BASELINE = 0x00,
    MAIN = 0x01,
    HIGH = 0x02,
}

export enum H264Level {
    LEVEL3_1 = 0x00,
    LEVEL3_2 = 0x01,
    LEVEL4_0 = 0x02,
}

export enum VideoCodecPacketizationMode {
    NON_INTERLEAVED = 0x00,
}

export enum SupportedAudioStreamConfigurationTLV {
    AUDIO_CODEC_CONFIGURATION = 0x01,
    COMFORT_NOISE_SUPPORT = 0x02,
}

export enum AudioCodecConfigurationTLV {
    CODEC_TYPE = 0x01,
    CODEC_PARAMETERS = 0x02,
}

export enum AudioCodecType {
    PCMU = 0x00,
    PCMA = 0x01,
    AAC_ELD = 0x02,
    OPUS = 0x03,
    MSBC = 0x04,
    AMR = 0x05,
    AMR_WB = 0x06,
}

export enum AudioCodecParametersTLV {
    CHANNEL = 0x01,
    BIT_RATE = 0x02,
    SAMPLE_RATE = 0x03,
    PACKET_TIME = 0x04,
}

export enum AudioBitrate {
    VARIABLE = 0x00,
    CONSTANT = 0x01,
}

export enum AudioSamplerate {
    KHZ_8 = 0x00,
    KHZ_16 = 0x01,
    KHZ_24 = 0x02,
}

export enum SupportedRTPConfigurationTLV {
    SRTP_CRYPTO_SUITE = 0x02,
}

export enum SRTPCryptoSuite {
    AES_CM_128_HMAC_SHA1_80 = 0x00,
    AES_CM_256_HMAC_SHA1_80 = 0x01,
    NONE = 0x02,
}

export enum SetupEndpointsTLV {
    SESSION_ID = 0x01,
    STATUS = 0x02,
    ADDRESS = 0x03,
    VIDEO_SRTP_PARAMETERS = 0x04,
    AUDIO_SRTP_PARAMETERS = 0x05,
    VIDEO_SSRC = 0x06,
    AUDIO_SSRC = 0x07,
}

export enum AddressTLV {
    ADDRESS_VERSION = 0x01,
    ADDRESS = 0x02,
    VIDEO_RTP_PORT = 0x03,
    AUDIO_RTP_PORT = 0x04,
}

export enum IPAddressVersion {
    IPV4 = 0x00,
    IPV6 = 0x01,
}

export enum SRTPParametersTLV {
    CRYPTO_SUITE = 0x01,
    MASTER_KEY = 0x02,
    MASTER_SALT = 0x03,
}

export enum SetupEndpointsStatus {
    SUCCESS = 0x00,
    BUSY = 0x01,
    ERROR = 0x02,
}

export enum SelectedRTPStreamConfigurationTLV {
    SESSION_CONTROL = 0x01,
    SELECTED_VIDEO_PARAMETERS = 0x02,
    SELECTED_AUDIO_PARAMETERS = 0x03,
}

export enum SessionControlTLV {
    SESSION_IDENTIFIER = 0x01,
    COMMAND = 0x02,
}

export enum SessionControlCommand {
    END_SESSION = 0x00,
    START_SESSION = 0x01,
    SUSPEND_SESSION = 0x02,
    RESUME_SESSION = 0x03,
    RECONFIGURE_SESSION = 0x04,
}

export enum SelectedVideoParametersTLV {
    CODEC_TYPE = 0x01,
    CODEC_PARAMETERS = 0x02,
    ATTRIBUTES = 0x03,
    RTP_PARAMETERS = 0x04,
}

export enum VideoRTPParametersTLV {
    PAYLOAD_TYPE = 0x01,
    SYNCHRONIZATION_SOURCE = 0x02,
    MAX_BIT_RATE = 0x03,
    MIN_RTCP_INTERVAL = 0x04,
    MAX_MTU = 0x05,
}

export enum SelectedAudioParametersTLV {
    CODEC_TYPE = 0x01,
    CODEC_PARAMETERS = 0x02,
    RTP_PARAMETERS = 0x03,
    COMFORT_NOISE = 0x04,
}

export enum AudioRTPParametersTLV {
    PAYLOAD_TYPE = 0x01,
    SYNCHRONIZATION_SOURCE = 0x02,
    MAX_BIT_RATE = 0x03,
    MIN_RTCP_INTERVAL = 0x04,
    COMFORT_NOISE_PAYLOAD_TYPE = 0x06,
}

export enum StreamingStatus {
    AVAILABLE = 0x00,
    IN_USE = 0x01,
    UNAVAILABLE = 0x02,
}

export enum StreamingStatusTLV {
    STATUS = 0x01,
}

// ---------------------------------------------------------------------------------------------
// Accessory database
// ---------------------------------------------------------------------------------------------

export interface HapCharacteristic {
    aid?: number;
    iid: number;
    type: string;
    value?: any;
    perms?: string[];
    format?: string;
    ev?: boolean;
    description?: string;
    unit?: string;
    minValue?: number;
    maxValue?: number;
    minStep?: number;
    maxLen?: number;
    'valid-values'?: number[];
    status?: number;
}

export interface HapService {
    iid: number;
    type: string;
    primary?: boolean;
    hidden?: boolean;
    linked?: number[];
    characteristics: HapCharacteristic[];
}

export interface HapAccessory {
    aid: number;
    services: HapService[];
}

export interface HapAccessories {
    accessories: HapAccessory[];
}

// The HAP status codes returned per characteristic in a multi-characteristic response.
export const hapStatusMessages: Record<number, string> = {
    [-70401]: 'request denied due to insufficient privileges',
    [-70402]: 'unable to communicate with the requested service',
    [-70403]: 'resource is busy, try again',
    [-70404]: 'cannot write to a read only characteristic',
    [-70405]: 'cannot read from a write only characteristic',
    [-70406]: 'notification is not supported for this characteristic',
    [-70407]: 'out of resources to process the request',
    [-70408]: 'operation timed out',
    [-70409]: 'resource does not exist',
    [-70410]: 'accessory received an invalid value in a write request',
    [-70411]: 'insufficient authorization',
    [-70412]: 'not allowed in the current state',
};
