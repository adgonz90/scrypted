// Cryptographic primitives for the HAP controller role.
//
// Everything here is backed by node's built in crypto. HAP uses Ed25519 for long term identity,
// Curve25519 for the pair-verify key exchange, HKDF-SHA512 for key derivation and
// ChaCha20-Poly1305 for both the pairing payloads and the session transport.

import crypto, { KeyObject } from 'crypto';

export interface Ed25519KeyPair {
    // raw 32 byte seed and public key, which is what goes on the wire and into storage.
    privateKey: Buffer;
    publicKey: Buffer;
}

function toBase64Url(buffer: Buffer) {
    return buffer.toString('base64url');
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'jwk' }) as any;
    const priv = privateKey.export({ format: 'jwk' }) as any;
    return {
        privateKey: Buffer.from(priv.d, 'base64url'),
        publicKey: Buffer.from(pub.x, 'base64url'),
    };
}

function importEd25519Private(keyPair: Ed25519KeyPair): KeyObject {
    return crypto.createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            d: toBase64Url(keyPair.privateKey),
            x: toBase64Url(keyPair.publicKey),
        },
        format: 'jwk',
    });
}

function importEd25519Public(publicKey: Buffer): KeyObject {
    return crypto.createPublicKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: toBase64Url(publicKey),
        },
        format: 'jwk',
    });
}

export function ed25519Sign(keyPair: Ed25519KeyPair, message: Buffer): Buffer {
    return crypto.sign(null, message, importEd25519Private(keyPair));
}

export function ed25519Verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
    try {
        return crypto.verify(null, message, importEd25519Public(publicKey), signature);
    }
    catch (e) {
        return false;
    }
}

export interface Curve25519KeyPair {
    privateKey: KeyObject;
    publicKey: Buffer;
}

export function generateCurve25519KeyPair(): Curve25519KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'jwk' }) as any;
    return {
        privateKey,
        publicKey: Buffer.from(pub.x, 'base64url'),
    };
}

export function curve25519SharedSecret(keyPair: Curve25519KeyPair, remotePublicKey: Buffer): Buffer {
    const publicKey = crypto.createPublicKey({
        key: {
            kty: 'OKP',
            crv: 'X25519',
            x: toBase64Url(remotePublicKey),
        },
        format: 'jwk',
    });
    return crypto.diffieHellman({ privateKey: keyPair.privateKey, publicKey });
}

export function hkdf(salt: string, ikm: Buffer, info: string, length = 32): Buffer {
    return Buffer.from(crypto.hkdfSync('sha512', ikm, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), length));
}

// HAP pairing nonces are an 8 byte ASCII label left padded with four zero bytes.
export function pairingNonce(label: string): Buffer {
    const nonce = Buffer.alloc(12);
    Buffer.from(label, 'utf8').copy(nonce, 4);
    return nonce;
}

// HAP session nonces are a 64 bit little endian counter left padded with four zero bytes.
export function sessionNonce(counter: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32LE(counter % 0x100000000, 4);
    nonce.writeUInt32LE(Math.floor(counter / 0x100000000), 8);
    return nonce;
}

export function chacha20Poly1305Encrypt(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad)
        cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    // HAP appends the 16 byte auth tag to the ciphertext.
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

export function chacha20Poly1305Decrypt(key: Buffer, nonce: Buffer, aad: Buffer, ciphertextWithTag: Buffer): Buffer {
    if (ciphertextWithTag.length < 16)
        throw new Error('chacha20-poly1305 payload is too short to contain an auth tag');
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad)
        decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
