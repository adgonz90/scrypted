// Pair Setup and Pair Verify, the controller half of HAP specification chapters 5.6 and 5.7.
//
// Pair Setup runs once, exchanges long term public keys authenticated by the accessory's eight
// digit setup code via SRP, and produces the PairingData this plugin persists. Pair Verify runs on
// every connection, proves both sides still hold those long term keys, and derives the two
// directional ChaCha20-Poly1305 session keys the transport then uses.

import crypto from 'crypto';
import { SRP, SrpClient } from 'fast-srp-hap';
import { HapConnection } from './connection';
import {
    chacha20Poly1305Decrypt,
    chacha20Poly1305Encrypt,
    curve25519SharedSecret,
    Ed25519KeyPair,
    ed25519Sign,
    ed25519Verify,
    generateCurve25519KeyPair,
    generateEd25519KeyPair,
    hkdf,
    pairingNonce,
} from './crypto';
import * as tlv from './tlv';
import { PairingError, pairingErrorMessages, PairingPermission, PairMethod, PairingTLV } from './types';

const PAIRING_CONTENT_TYPE = 'application/pairing+tlv8';

// Everything needed to re-establish an encrypted session with an accessory. Persisted verbatim.
export interface PairingData {
    // the accessory's identity
    accessoryPairingId: string;
    accessoryLtpk: string;
    // this controller's identity, as known to the accessory
    controllerPairingId: string;
    controllerLtsk: string;
    controllerLtpk: string;
}

export interface SessionKeys {
    accessoryToController: Buffer;
    controllerToAccessory: Buffer;
}

export class PairingProtocolError extends Error {
    constructor(public code: number, message: string) {
        super(message);
    }
}

function checkForError(response: Record<number, Buffer>) {
    const error = response[PairingTLV.ERROR];
    if (!error?.length)
        return;
    const code = error.readUInt8(0);
    const retryDelay = response[PairingTLV.RETRY_DELAY];
    let message = pairingErrorMessages[code] || `the accessory reported pairing error 0x${code.toString(16)}`;
    if (retryDelay?.length)
        message += ` (retry after ${tlv.readUIntLE(retryDelay)}s)`;
    throw new PairingProtocolError(code, message);
}

function expectState(response: Record<number, Buffer>, state: number) {
    checkForError(response);
    const actual = response[PairingTLV.STATE]?.readUInt8(0);
    if (actual !== state)
        throw new Error(`unexpected HAP pairing state: expected M${state}, got M${actual}`);
}

async function exchange(connection: HapConnection, path: string, payload: Buffer): Promise<Record<number, Buffer>> {
    const response = await connection.request('POST', path, payload, PAIRING_CONTENT_TYPE);
    if (response.statusCode !== 200)
        throw new Error(`HAP ${path} returned ${response.statusCode} ${response.statusMessage}`);
    return tlv.decode(response.body);
}

// Accepts "12345678", "123-45-678" and "123 45 678"; HAP requires the dashed form on the wire.
export function normalizeSetupCode(code: string): string {
    const digits = (code || '').replace(/\D/g, '');
    if (digits.length !== 8)
        throw new Error(`a HomeKit setup code has 8 digits; got ${digits.length}`);
    return `${digits.substring(0, 3)}-${digits.substring(3, 5)}-${digits.substring(5)}`;
}

/**
 * Runs Pair Setup against an unpaired accessory, returning the credentials needed for every
 * future connection. The connection is left in the clear; call pairVerify to secure it.
 */
export async function pairSetup(connection: HapConnection, setupCode: string, console?: Console): Promise<PairingData> {
    const pin = normalizeSetupCode(setupCode);

    // M1: ask the accessory to start a pair setup.
    const m2 = await exchange(connection, '/pair-setup', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([1]),
        PairingTLV.METHOD, Buffer.from([PairMethod.PAIR_SETUP]),
    ));
    expectState(m2, 2);

    const accessorySrpPublicKey = m2[PairingTLV.PUBLIC_KEY];
    const salt = m2[PairingTLV.SALT];
    if (!accessorySrpPublicKey?.length || !salt?.length)
        throw new Error('accessory did not return an SRP public key and salt');

    // M3: prove we know the setup code. HAP pins SRP to the 3072 bit group with SHA-512.
    const srp = new SrpClient(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(pin), crypto.randomBytes(32), true);
    srp.setB(accessorySrpPublicKey);

    const m4 = await exchange(connection, '/pair-setup', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([3]),
        PairingTLV.PUBLIC_KEY, srp.computeA(),
        PairingTLV.PROOF, srp.computeM1(),
    ));
    expectState(m4, 4);

    // M4 carries the accessory's counter proof. A mismatch means a wrong setup code.
    try {
        srp.checkM2(m4[PairingTLV.PROOF]);
    }
    catch (e) {
        throw new PairingProtocolError(PairingError.AUTHENTICATION, 'the accessory failed to prove it knows the setup code');
    }

    const srpSharedSecret = srp.computeK();

    // M5: hand over our long term public key, signed so the accessory knows it is ours.
    const controllerKeyPair = generateEd25519KeyPair();
    const controllerPairingId = crypto.randomUUID().toUpperCase();

    const controllerX = hkdf('Pair-Setup-Controller-Sign-Salt', srpSharedSecret, 'Pair-Setup-Controller-Sign-Info');
    const controllerInfo = Buffer.concat([
        controllerX,
        Buffer.from(controllerPairingId, 'utf8'),
        controllerKeyPair.publicKey,
    ]);
    const controllerSignature = ed25519Sign(controllerKeyPair, controllerInfo);

    const subTlv = tlv.encodeAll(
        PairingTLV.IDENTIFIER, Buffer.from(controllerPairingId, 'utf8'),
        PairingTLV.PUBLIC_KEY, controllerKeyPair.publicKey,
        PairingTLV.SIGNATURE, controllerSignature,
    );

    const encryptionKey = hkdf('Pair-Setup-Encrypt-Salt', srpSharedSecret, 'Pair-Setup-Encrypt-Info');
    const encrypted = chacha20Poly1305Encrypt(encryptionKey, pairingNonce('PS-Msg05'), null, subTlv);

    const m6 = await exchange(connection, '/pair-setup', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([5]),
        PairingTLV.ENCRYPTED_DATA, encrypted,
    ));
    expectState(m6, 6);

    // M6: the accessory returns its own identity, signed the same way.
    const decrypted = chacha20Poly1305Decrypt(encryptionKey, pairingNonce('PS-Msg06'), null, m6[PairingTLV.ENCRYPTED_DATA]);
    const accessoryTlv = tlv.decode(decrypted);

    const accessoryPairingId = accessoryTlv[PairingTLV.IDENTIFIER];
    const accessoryLtpk = accessoryTlv[PairingTLV.PUBLIC_KEY];
    const accessorySignature = accessoryTlv[PairingTLV.SIGNATURE];
    if (!accessoryPairingId?.length || !accessoryLtpk?.length || !accessorySignature?.length)
        throw new Error('accessory did not return a complete identity in M6');

    const accessoryX = hkdf('Pair-Setup-Accessory-Sign-Salt', srpSharedSecret, 'Pair-Setup-Accessory-Sign-Info');
    const accessoryInfo = Buffer.concat([accessoryX, accessoryPairingId, accessoryLtpk]);
    if (!ed25519Verify(accessoryLtpk, accessoryInfo, accessorySignature))
        throw new Error('the accessory long term public key failed signature verification');

    console?.log(`paired with accessory ${accessoryPairingId.toString('utf8')}`);

    return {
        accessoryPairingId: accessoryPairingId.toString('utf8'),
        accessoryLtpk: accessoryLtpk.toString('base64'),
        controllerPairingId,
        controllerLtsk: controllerKeyPair.privateKey.toString('base64'),
        controllerLtpk: controllerKeyPair.publicKey.toString('base64'),
    };
}

/**
 * Runs Pair Verify on an already paired accessory and switches the connection to encrypted
 * framing. Must be the first thing done on every new connection.
 */
export async function pairVerify(connection: HapConnection, pairingData: PairingData): Promise<SessionKeys> {
    const controllerKeyPair: Ed25519KeyPair = {
        privateKey: Buffer.from(pairingData.controllerLtsk, 'base64'),
        publicKey: Buffer.from(pairingData.controllerLtpk, 'base64'),
    };
    const accessoryLtpk = Buffer.from(pairingData.accessoryLtpk, 'base64');

    // M1: send an ephemeral Curve25519 public key.
    const ephemeral = generateCurve25519KeyPair();
    const m2 = await exchange(connection, '/pair-verify', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([1]),
        PairingTLV.PUBLIC_KEY, ephemeral.publicKey,
    ));
    expectState(m2, 2);

    const accessoryEphemeralPublicKey = m2[PairingTLV.PUBLIC_KEY];
    if (!accessoryEphemeralPublicKey?.length)
        throw new Error('accessory did not return an ephemeral public key');

    const sharedSecret = curve25519SharedSecret(ephemeral, accessoryEphemeralPublicKey);
    const sessionEncryptionKey = hkdf('Pair-Verify-Encrypt-Salt', sharedSecret, 'Pair-Verify-Encrypt-Info');

    // M2's encrypted payload proves the accessory still holds the long term key we paired with.
    const decrypted = chacha20Poly1305Decrypt(sessionEncryptionKey, pairingNonce('PV-Msg02'), null, m2[PairingTLV.ENCRYPTED_DATA]);
    const accessoryTlv = tlv.decode(decrypted);

    const accessoryPairingId = accessoryTlv[PairingTLV.IDENTIFIER];
    const accessorySignature = accessoryTlv[PairingTLV.SIGNATURE];
    if (!accessoryPairingId?.length || !accessorySignature?.length)
        throw new Error('accessory did not return an identity in pair-verify M2');

    if (accessoryPairingId.toString('utf8') !== pairingData.accessoryPairingId)
        throw new Error(`accessory identity changed: expected ${pairingData.accessoryPairingId}, got ${accessoryPairingId.toString('utf8')}. it was likely reset and must be paired again`);

    const accessoryInfo = Buffer.concat([
        accessoryEphemeralPublicKey,
        accessoryPairingId,
        ephemeral.publicKey,
    ]);
    if (!ed25519Verify(accessoryLtpk, accessoryInfo, accessorySignature))
        throw new Error('accessory signature verification failed during pair-verify');

    // M3: prove we still hold our own long term key.
    const controllerInfo = Buffer.concat([
        ephemeral.publicKey,
        Buffer.from(pairingData.controllerPairingId, 'utf8'),
        accessoryEphemeralPublicKey,
    ]);
    const subTlv = tlv.encodeAll(
        PairingTLV.IDENTIFIER, Buffer.from(pairingData.controllerPairingId, 'utf8'),
        PairingTLV.SIGNATURE, ed25519Sign(controllerKeyPair, controllerInfo),
    );
    const encrypted = chacha20Poly1305Encrypt(sessionEncryptionKey, pairingNonce('PV-Msg03'), null, subTlv);

    const m4 = await exchange(connection, '/pair-verify', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([3]),
        PairingTLV.ENCRYPTED_DATA, encrypted,
    ));
    expectState(m4, 4);

    // Note the direction naming: "Read" is the accessory writing to us.
    const keys: SessionKeys = {
        accessoryToController: hkdf('Control-Salt', sharedSecret, 'Control-Read-Encryption-Key'),
        controllerToAccessory: hkdf('Control-Salt', sharedSecret, 'Control-Write-Encryption-Key'),
    };
    connection.enableEncryption(keys.accessoryToController, keys.controllerToAccessory);
    return keys;
}

/**
 * Removes this controller's pairing from the accessory, returning it to an unpaired state if we
 * were the last admin controller. Requires an already verified connection.
 */
export async function removePairing(connection: HapConnection, controllerPairingId: string): Promise<void> {
    const response = await exchange(connection, '/pairings', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([1]),
        PairingTLV.METHOD, Buffer.from([PairMethod.REMOVE_PAIRING]),
        PairingTLV.IDENTIFIER, Buffer.from(controllerPairingId, 'utf8'),
    ));
    expectState(response, 2);
}

/**
 * Adds another controller to the accessory. Only usable while this controller holds admin
 * permission, which it does when it ran the original pair setup.
 */
export async function addPairing(connection: HapConnection, pairingId: string, publicKey: Buffer, admin = false): Promise<void> {
    const response = await exchange(connection, '/pairings', tlv.encodeAll(
        PairingTLV.STATE, Buffer.from([1]),
        PairingTLV.METHOD, Buffer.from([PairMethod.ADD_PAIRING]),
        PairingTLV.IDENTIFIER, Buffer.from(pairingId, 'utf8'),
        PairingTLV.PUBLIC_KEY, publicKey,
        PairingTLV.PERMISSIONS, Buffer.from([admin ? PairingPermission.ADMIN : PairingPermission.USER]),
    ));
    expectState(response, 2);
}
