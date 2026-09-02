import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { certificateFields, certificateRecord, validateCertificate } from '../scripts/certdata.mjs';

const config = JSON.parse(readFileSync(new URL('../config/certificates.json', import.meta.url)));
const pins = config.certificates;
const data = pins.map(pin => readFileSync(new URL(`../work/certificates/${pin.file}`, import.meta.url)));
const date = new Date('2026-08-31T12:00:00Z');
const certs = data.map((pem, i) => validateCertificate(pem, pins[i], date));

test('official pinned CA chain has valid cryptographic signatures', () => {
  assert.ok(certs[0].verify(certs[0].publicKey));
  assert.ok(certs[1].checkIssued(certs[0]));
  assert.ok(certs[1].verify(certs[0].publicKey));
});

test('rejects substituted certificates and unexpected trust roles', () => {
  assert.throws(() => validateCertificate(data[1], pins[0], date), /Fingerprint mismatch/);
  assert.throws(() => validateCertificate(data[0], { ...pins[0], role: 'anything' }, date), /Unknown CA role/);
});

test('rejects expired and not-yet-valid CAs and bundled PEMs', () => {
  assert.throws(() => validateCertificate(data[1], pins[1], new Date('2027-03-07')), /validity period/);
  assert.throws(() => validateCertificate(data[0], pins[0], new Date('2020-01-01')), /validity period/);
  assert.throws(() => validateCertificate(Buffer.concat(data), pins[0], date), /exactly one PEM/);
});

function decodeAttribute(record, name) {
  const encoded = record.match(new RegExp(`${name} MULTILINE_OCTAL\\n([\\s\\S]*?)\\nEND`))[1];
  return Buffer.from([...encoded.matchAll(/\\([0-7]{3})/g)].map(match => parseInt(match[1], 8)));
}

test('NSS records round-trip exact DER certificates and serial numbers', () => {
  certs.forEach((cert, i) => {
    const record = certificateRecord(cert, pins[i]);
    const roundTrip = new X509Certificate(decodeAttribute(record, 'CKA_VALUE'));
    assert.equal(roundTrip.fingerprint256, pins[i].sha256.match(/../g).join(':'));
    const fields = certificateFields(cert);
    assert.equal(fields.serial.subarray(2).toString('hex').replace(/^00/, '').toUpperCase(), cert.serialNumber.replace(/^00/, ''));
    assert.deepEqual(decodeAttribute(record, 'CKA_SUBJECT'), fields.subject);
    assert.deepEqual(decodeAttribute(record, 'CKA_ISSUER'), fields.issuer);
  });
});

test('only the root gains server-auth trust; neither CA gains email or code-signing trust', () => {
  const root = certificateRecord(certs[0], pins[0]);
  const intermediate = certificateRecord(certs[1], pins[1]);
  assert.match(root, /CKA_TRUST_SERVER_AUTH CK_TRUST CKT_NSS_TRUSTED_DELEGATOR/);
  assert.doesNotMatch(intermediate, /CKT_NSS_TRUSTED_DELEGATOR/);
  for (const record of [root, intermediate]) {
    assert.match(record, /CKA_TRUST_EMAIL_PROTECTION CK_TRUST CKT_NSS_MUST_VERIFY_TRUST/);
    assert.match(record, /CKA_TRUST_CODE_SIGNING CK_TRUST CKT_NSS_MUST_VERIFY_TRUST/);
    assert.match(record, /CKA_NSS_MOZILLA_CA_POLICY CK_BBOOL CK_FALSE/);
  }
});

test('issuer DER links intermediate to root, independent of formatted DN strings', () => {
  assert.deepEqual(certificateFields(certs[1]).issuer, certificateFields(certs[0]).subject);
});

test('NSS labels cannot inject additional attributes', () => {
  assert.throws(() => certificateRecord(certs[0], { ...pins[0], label: 'x"\nCKA_TOKEN CK_BBOOL CK_FALSE' }), /Unsafe NSS label/);
});
