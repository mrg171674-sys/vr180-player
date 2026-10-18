// A tiny certificate authority for the phone stream. Phones can trust it once
// (instead of tapping through a warning every time). It is limited by name
// constraints to private network addresses and "localhost", so even if its key
// were stolen it could never be used to impersonate a real website.
const forge = require('node-forge');
const crypto = require('crypto');

const { asn1, pki } = forge;
const U = asn1.Class.UNIVERSAL, C = asn1.Class.CONTEXT_SPECIFIC;

// private IPv4 ranges + link-local + loopback
const PERMITTED_IPS = [['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'], ['169.254.0.0', '255.255.0.0'], ['127.0.0.0', '255.0.0.0']];
const bytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));

function nameConstraints() {
  const subtree = (generalName) => asn1.create(U, asn1.Type.SEQUENCE, true, [generalName]);
  const permitted = [
    ...PERMITTED_IPS.map(([ip, mask]) => subtree(asn1.create(C, 7, false, bytes(ip) + bytes(mask)))),
    subtree(asn1.create(C, 2, false, 'localhost'))
  ];
  return asn1.create(U, asn1.Type.SEQUENCE, true, [asn1.create(C, 0, true, permitted)]);
}

const serial = () => '01' + crypto.randomBytes(15).toString('hex'); // positive
const subject = (cn) => [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'VR180 Player (this PC only)' }];

function createCA() {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
  const name = subject(`VR180 Player on ${require('os').hostname()}`.slice(0, 64));
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { id: '2.5.29.30', critical: true, value: nameConstraints() },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: pki.privateKeyToPem(keys.privateKey), cert: pki.certificateToPem(cert) };
}

// a server certificate for this PC's addresses, signed by the CA.
// 397 days keeps it within Apple's limits for TLS server certificates.
function issueServer(ca, ips, names = ['localhost']) {
  const caCert = pki.certificateFromPem(ca.cert);
  const caKey = pki.privateKeyFromPem(ca.key);
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 397 * 86400000);
  cert.setSubject(subject(ips[0] || 'localhost'));
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...names.map((value) => ({ type: 2, value })), ...ips.map((ip) => ({ type: 7, ip }))] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { key: pki.privateKeyToPem(keys.privateKey), cert: pki.certificateToPem(cert), expires: cert.validity.notAfter.getTime() };
}

const toDer = (pem) => Buffer.from(forge.asn1.toDer(pki.certificateToAsn1(pki.certificateFromPem(pem))).getBytes(), 'binary');
const fingerprint = (pem) => crypto.createHash('sha256').update(toDer(pem)).digest('hex').toUpperCase().match(/../g).join(':');

module.exports = { createCA, issueServer, toDer, fingerprint };
