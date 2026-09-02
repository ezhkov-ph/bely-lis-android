import { createHash, X509Certificate } from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function validateCertificate(data, pin, now = new Date()) {
  const pem = data.toString('utf8').trim();
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(pem)) {
    throw new Error('Expected exactly one PEM certificate');
  }
  const cert = new X509Certificate(pem);
  if (sha256(cert.raw).toUpperCase() !== pin.sha256) throw new Error(`Fingerprint mismatch: ${pin.label}`);
  if (!cert.ca) throw new Error('Not a CA certificate');
  if (!Number.isFinite(now.getTime()) || now < cert.validFromDate || now >= cert.validToDate) {
    throw new Error(`Certificate outside validity period: ${pin.label}`);
  }
  if (cert.publicKey.asymmetricKeyType !== 'rsa' || cert.publicKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('Unexpected CA key type or length');
  }
  if (!['root', 'intermediate'].includes(pin.role)) throw new Error('Unknown CA role');
  if (pin.role === 'root' && (cert.subject !== cert.issuer || !cert.verify(cert.publicKey))) {
    throw new Error('Invalid root self-signature');
  }
  return cert;
}

// Read only enough DER structure to preserve issuer, subject and serial bytes.
// X509Certificate/OpenSSL validates the certificate before this is used.
function tlv(data, start, limit = data.length) {
  if (start + 2 > limit) throw new Error('Truncated DER');
  const tag = data[start];
  let cursor = start + 2;
  let length = data[start + 1];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 4 || cursor + count > limit) throw new Error('Invalid DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[cursor++];
  }
  const end = cursor + length;
  if (end > limit) throw new Error('DER exceeds parent');
  return { tag, start, content: cursor, end, raw: data.subarray(start, end) };
}

function children(data, parent) {
  const result = [];
  let cursor = parent.content;
  while (cursor < parent.end) {
    const item = tlv(data, cursor, parent.end);
    result.push(item);
    cursor = item.end;
  }
  return result;
}

export function certificateFields(cert) {
  const data = cert.raw;
  const outer = tlv(data, 0);
  if (outer.tag !== 0x30 || outer.end !== data.length) throw new Error('Invalid certificate DER');
  const tbs = children(data, outer)[0];
  if (tbs.tag !== 0x30) throw new Error('Invalid TBSCertificate');
  const fields = children(data, tbs);
  const offset = fields[0].tag === 0xa0 ? 1 : 0;
  const serial = fields[offset];
  const issuer = fields[offset + 2];
  const subject = fields[offset + 4];
  if (serial?.tag !== 0x02 || issuer?.tag !== 0x30 || subject?.tag !== 0x30) throw new Error('Invalid certificate fields');
  return { serial: serial.raw, issuer: issuer.raw, subject: subject.raw };
}

export function octalAttribute(name, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push([...bytes.subarray(i, i + 16)].map(b => '\\' + b.toString(8).padStart(3, '0')).join(''));
  }
  return `${name} MULTILINE_OCTAL\n${lines.join('\n')}\nEND\n`;
}

export function certificateRecord(cert, { label, role }) {
  if (!/^[A-Za-z0-9 ._-]+$/.test(label)) throw new Error('Unsafe NSS label');
  if (!['root', 'intermediate'].includes(role)) throw new Error('Unknown CA role');
  const { serial, issuer, subject } = certificateFields(cert);
  const common = `CKA_TOKEN CK_BBOOL CK_TRUE\nCKA_PRIVATE CK_BBOOL CK_FALSE\nCKA_MODIFIABLE CK_BBOOL CK_FALSE\nCKA_LABEL UTF8 "${label}"\n`;
  let text = `\n# Local CA addition; not a Mozilla root-program endorsement.\n# SHA-256: ${cert.fingerprint256}\n`;
  text += `CKA_CLASS CK_OBJECT_CLASS CKO_CERTIFICATE\n${common}CKA_CERTIFICATE_TYPE CK_CERTIFICATE_TYPE CKC_X_509\n`;
  text += octalAttribute('CKA_SUBJECT', subject) + 'CKA_ID UTF8 "0"\n';
  text += octalAttribute('CKA_ISSUER', issuer) + octalAttribute('CKA_SERIAL_NUMBER', serial);
  text += octalAttribute('CKA_VALUE', cert.raw);
  text += 'CKA_NSS_MOZILLA_CA_POLICY CK_BBOOL CK_FALSE\n';
  text += `\nCKA_CLASS CK_OBJECT_CLASS CKO_NSS_TRUST\n${common}`;
  // SHA-1 and MD5 are NSS lookup attributes, not certificate signature algorithms.
  text += octalAttribute('CKA_CERT_SHA1_HASH', createHash('sha1').update(cert.raw).digest());
  text += octalAttribute('CKA_CERT_MD5_HASH', createHash('md5').update(cert.raw).digest());
  text += octalAttribute('CKA_ISSUER', issuer) + octalAttribute('CKA_SERIAL_NUMBER', serial);
  text += `CKA_TRUST_SERVER_AUTH CK_TRUST ${role === 'root' ? 'CKT_NSS_TRUSTED_DELEGATOR' : 'CKT_NSS_MUST_VERIFY_TRUST'}\n`;
  text += 'CKA_TRUST_EMAIL_PROTECTION CK_TRUST CKT_NSS_MUST_VERIFY_TRUST\n';
  text += 'CKA_TRUST_CODE_SIGNING CK_TRUST CKT_NSS_MUST_VERIFY_TRUST\n';
  text += 'CKA_TRUST_STEP_UP_APPROVED CK_BBOOL CK_FALSE\n';
  return text;
}
