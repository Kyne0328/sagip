import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  parseReportStatusAccessProof, reportStatusAccessDomain, verifyReportStatusAccessProof,
} from '../../src/responder/reportStatusAccess.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/victim-status-proof-v1.json', import.meta.url), 'utf8')) as {
  publicKeySpkiBase64: string;
  vectors: Array<{reportId: string; timestamp: string; nonce: string; cursor: string | null; domainUtf8: string; domainHex: string; signatureP1363Base64: string}>;
};

test('shared status proof vectors verify exact UTF-8, SPKI and low-S P1363 on both pages', () => {
  for (const vector of fixture.vectors) {
    const headers = new Headers({
      'x-sagip-status-timestamp': vector.timestamp,
      'x-sagip-status-nonce': vector.nonce,
      'x-sagip-status-signature': vector.signatureP1363Base64,
    });
    const now = Number(vector.timestamp);
    const proof = parseReportStatusAccessProof(headers, now)!;
    assert.ok(proof);
    const input = reportStatusAccessDomain(vector.reportId, proof, vector.cursor);
    assert.equal(input.toString('utf8'), vector.domainUtf8);
    assert.equal(input.toString('hex'), vector.domainHex);
    const publicKey = Buffer.from(fixture.publicKeySpkiBase64, 'base64');
    assert.equal(verifyReportStatusAccessProof(vector.reportId, proof, vector.cursor, publicKey), true);
    assert.equal(verifyReportStatusAccessProof(vector.reportId, proof, vector.cursor, Buffer.alloc(91)), false);
    const tamperedSignature = Buffer.from(proof.signature);
    tamperedSignature[0] = tamperedSignature[0]! ^ 1;
    assert.equal(verifyReportStatusAccessProof(vector.reportId, {...proof, signature: tamperedSignature}, vector.cursor, publicKey), false);
    for (const offset of [-60000, 60000]) assert.ok(parseReportStatusAccessProof(headers, now + offset));
    for (const offset of [-60001, 60001]) assert.equal(parseReportStatusAccessProof(headers, now + offset), null);
    for (const malformed of ['!'.repeat(44), vector.nonce.slice(0, -1), vector.nonce.slice(0, -2) + '9=']) {
      const invalid = new Headers(headers);
      invalid.set('x-sagip-status-nonce', malformed);
      assert.equal(parseReportStatusAccessProof(invalid, now), null);
    }
    const invalidSignature = new Headers(headers);
    invalidSignature.set('x-sagip-status-signature', '!'.repeat(88));
    assert.equal(parseReportStatusAccessProof(invalidSignature, now), null);
  }
});
