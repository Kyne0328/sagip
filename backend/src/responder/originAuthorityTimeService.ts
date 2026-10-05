import {createHash, createPublicKey, randomUUID, verify} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {canonicalizeNewReceiptSignature, decodeReceipt, encodeReceipt, receiptSigningInput,
  validateReceiptPublicKey, verifyReceiptSignature, type TimeProofFields} from '../protocol/receiptV2.js';
import {issuerProviderId} from './receiptAuthority.js';
import type {AuthoritySigner} from './receiptService.js';
import type {QualifiedAuthorityTime, TimeChallenge} from './grantProvisioning.js';
const NIL = '00000000-0000-0000-0000-000000000000';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest();
export function originTimeRequestSigningInput(reportId: string, body: Uint8Array) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(reportId)) throw new Error('INVALID_FIELDS');
  return Buffer.from('SAGIP-ORIGIN-TIME-REQUEST-V1\nPOST\n/v2/reports/' + reportId +
    '/authority/time\n' + hash(body).toString('hex') + '\n');
}
function parse(body: Buffer): TimeChallenge {
  if (body.length > 4096) throw new Error('INVALID_FIELDS');
  const text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(body);
  const f = JSON.parse(text) as Record<string, unknown>;
  if (!f || Array.isArray(f) || JSON.stringify(f) !== text ||
    Object.keys(f).length !== 3 || !['verifierId','verifierBootSessionId','nonce'].every(k => Object.hasOwn(f,k)))
    throw new Error('INVALID_FIELDS');
  const bytes = (v: unknown) => {
    if (typeof v !== 'string' || v.length !== 44) throw new Error('INVALID_FIELDS');
    const b = Buffer.from(v,'base64');
    if (b.length !== 32 || b.toString('base64') !== v) throw new Error('INVALID_FIELDS'); return b;
  };
  if (typeof f.verifierBootSessionId !== 'string' || f.verifierBootSessionId === NIL ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(f.verifierBootSessionId)) throw new Error('INVALID_FIELDS');
  return {verifierId:bytes(f.verifierId),nonce:bytes(f.nonce),verifierBootSessionId:f.verifierBootSessionId};
}
export class OriginAuthorityTimeService {
  private readonly root: Buffer; private readonly rootId: Buffer;
  constructor(private readonly pool: Pick<Pool,'connect'>, private readonly signer: AuthoritySigner,
    private readonly qualifiedTime: () => QualifiedAuthorityTime) {
    this.root=Buffer.from(signer.publicKeyDer); validateReceiptPublicKey(this.root); this.rootId=hash(this.root);
  }
  private async authenticateUsing(c: PoolClient, reportId: string, body: Buffer, signature: string | null) {
    try {
      const challenge=parse(body);
      if (!signature || signature.length!==88) return null;
      const sig=Buffer.from(signature,'base64');
      if (sig.length!==64 || sig.toString('base64')!==signature ||
        !canonicalizeNewReceiptSignature(sig).equals(sig)) return null;
      const origin=(await c.query<{origin_key_id:Buffer; public_key_der:Buffer}>(
        'SELECT m.origin_key_id,k.public_key_der FROM accepted_messages m JOIN origin_keys k ON k.origin_key_id=m.origin_key_id WHERE m.report_id=$1 LIMIT 1',
        [reportId])).rows[0];
      if (!origin || !Buffer.from(challenge.verifierId).equals(origin.origin_key_id) ||
        !hash(origin.public_key_der).equals(origin.origin_key_id)) return null;
      validateReceiptPublicKey(origin.public_key_der);
      return verify('sha256',originTimeRequestSigningInput(reportId,body),{
        key:createPublicKey({key:origin.public_key_der,format:'der',type:'spki'}),dsaEncoding:'ieee-p1363',
      },sig) ? challenge : null;
    } catch (e) {
      if (e instanceof Error && (e.message.includes('Invalid') || e.message==='INVALID_FIELDS' ||
        e instanceof SyntaxError || e instanceof TypeError)) return null;
      throw e;
    }
  }
  async authenticate(reportId:string, body:Buffer, signature:string|null):Promise<boolean> {
    const c=await this.pool.connect();
    try {return (await this.authenticateUsing(c,reportId,body,signature))!==null;} finally {c.release();}
  }
  async issue(reportId:string, body:Buffer, signature:string|null):Promise<Buffer> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      try {
        await this.signer.assertActive?.(c);
        const challenge=await this.authenticateUsing(c,reportId,body,signature);
        if (!challenge) throw new Error('ORIGIN_PROOF_REQUIRED');
        await c.query('SELECT pg_advisory_xact_lock($1)',[
          hash(Buffer.from('SAGIP-ORIGIN-TIME-CAPACITY-V1')).readBigInt64BE().toString()]);
        await c.query('SELECT pg_advisory_xact_lock($1)',[hash(challenge.verifierId).readBigInt64BE().toString()]);
        const t=this.qualifiedTime(), low=t.timeMs-t.uncertaintyMs, high=t.timeMs+t.uncertaintyMs;
        if (![t.timeMs,t.uncertaintyMs,t.validForMs,low,high].every(Number.isSafeInteger) ||
          t.uncertaintyMs<0 || t.uncertaintyMs>60000 || low<0 || t.validForMs<=t.uncertaintyMs ||
          t.validForMs+t.uncertaintyMs>86400000) throw new Error('TIME_UNAVAILABLE');
        const existing=(await c.query<{verifier_boot_id:string; report_id:string; valid_until_ms:string; object_bytes:Buffer}>(
          'SELECT * FROM origin_authority_time_proofs WHERE verifier_id=$1 AND nonce=$2',
          [Buffer.from(challenge.verifierId),Buffer.from(challenge.nonce)])).rows[0];
        if(existing) {
          if(existing.verifier_boot_id!==challenge.verifierBootSessionId || existing.report_id!==reportId ||
            high>=Number(existing.valid_until_ms)) throw new Error('TIME_CHALLENGE_REUSED');
          await c.query('COMMIT'); return Buffer.from(existing.object_bytes);
        }
        const state=(await c.query<{high_water_earliest_ms:string}>(
          'SELECT high_water_earliest_ms FROM receipt_authority_time_state WHERE verifier_id=$1',
          [Buffer.from(challenge.verifierId)])).rows[0];
        if(state && low<Number(state.high_water_earliest_ms)) throw new Error('TIME_ROLLBACK');
        const recent=(await c.query<{count:string}>(
          'SELECT COUNT(*) AS count FROM origin_authority_time_proofs WHERE verifier_id=$1 AND signed_time_ms >= $2',
          [Buffer.from(challenge.verifierId),Math.max(0,t.timeMs-60000)])).rows[0]!;
        const budget=(await c.query<{count:string; bytes:string}>(
          'SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(object_bytes)+128),0) AS bytes FROM origin_authority_time_proofs')).rows[0]!;
        if(Number(recent.count)>=128 || Number(budget.count)>=10000) throw new Error('CAPACITY_FULL');
        const fields:TimeProofFields={
          purpose:4,proofId:randomUUID(),signerProviderId:issuerProviderId(1,this.rootId,NIL),
          signerKeyId:this.rootId,grantId:NIL,signerBootSessionId:NIL,
          verifierId:challenge.verifierId,verifierBootSessionId:challenge.verifierBootSessionId,
          nonce:challenge.nonce,parentCheckpointDigest:Buffer.alloc(32),signedTimeMs:t.timeMs,
          elapsedSinceCheckpointMs:0,uncertaintyMs:t.uncertaintyMs,validUntilMs:t.timeMs+t.validForMs,
        };
        const bytes=encodeReceipt(fields,await this.signer.sign(receiptSigningInput(fields,Buffer.alloc(0)),c),Buffer.alloc(0));
        if(!verifyReceiptSignature(decodeReceipt(bytes),this.root)) throw new Error('SIGNER_UNAVAILABLE');
        const final=this.qualifiedTime();
        if(final.timeMs-final.uncertaintyMs<low || final.timeMs+final.uncertaintyMs>=fields.validUntilMs)
          throw new Error('TIME_UNAVAILABLE');
        if(Number(budget.bytes)+bytes.length+128>64*1024*1024) throw new Error('CAPACITY_FULL');
        await c.query('INSERT INTO origin_authority_time_proofs VALUES ($1,$2,$3,$4,$5,$6,$7)',[
          Buffer.from(challenge.verifierId),Buffer.from(challenge.nonce),challenge.verifierBootSessionId,
          reportId,t.timeMs,fields.validUntilMs,bytes]);
        await c.query('INSERT INTO receipt_authority_time_state VALUES ($1,$2) ON CONFLICT (verifier_id) DO UPDATE SET high_water_earliest_ms=EXCLUDED.high_water_earliest_ms',
          [Buffer.from(challenge.verifierId),low]);
        await c.query('COMMIT'); return bytes;
      } catch(error) {await c.query('ROLLBACK');throw error;}
    } finally {c.release();}
  }
}
