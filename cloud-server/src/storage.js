import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, pool } from './auth.js';

const storageRoot = path.resolve(process.env.STORAGE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage'));
const defaultQuota = Math.max(1024 * 1024, Number(process.env.DEFAULT_STORAGE_LIMIT_BYTES) || 157286400);
const encryptionKey = (() => {const value=Buffer.from(process.env.STORAGE_ENCRYPTION_KEY||'', 'base64');if(value.length!==32)throw new Error('STORAGE_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64.');return value})();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safePart = value => String(value).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 100);

async function ensureAccount(connection, userId) {
  await connection.query('INSERT IGNORE INTO firefly_storage_accounts (user_id, quota_bytes, usage_bytes) VALUES (?, ?, 0)', [userId, defaultQuota]);
  const [[account]] = await connection.query('SELECT quota_bytes, usage_bytes FROM firefly_storage_accounts WHERE user_id=? FOR UPDATE', [userId]);return account;
}
async function encryptToFile(fileName, plaintext) {
  await fs.mkdir(storageRoot,{recursive:true});const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv),ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag(),payload=Buffer.concat([Buffer.from('FF1'),iv,tag,ciphertext]),target=path.join(storageRoot,fileName),temporary=`${target}.${process.pid}.tmp`;await fs.writeFile(temporary,payload);await fs.rename(temporary,target);return target;
}
async function decryptFromFile(fileName) {const payload=await fs.readFile(path.join(storageRoot,path.basename(fileName)));if(payload.subarray(0,3).toString()!=='FF1')throw new Error('Stored object header is invalid.');const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,payload.subarray(3,15));decipher.setAuthTag(payload.subarray(15,31));return Buffer.concat([decipher.update(payload.subarray(31)),decipher.final()])}
function bearer(req){const value=String(req.headers.authorization||'');return value.startsWith('Bearer ')?value.slice(7).trim():''}

export async function requireDesktopAuth(req,res,next){
  try{const token=bearer(req);if(!token)return res.status(401).json({error:'Sign in to Firefly first.'});const hash=digest(token),[rows]=await pool.query('SELECT user_id FROM firefly_api_tokens WHERE token_hash=? AND expires_at>NOW(3)',[hash]);if(!rows[0])return res.status(401).json({error:'This Firefly session has expired.'});req.fireflyUserId=rows[0].user_id;req.fireflyTokenHash=hash;void pool.query('UPDATE firefly_api_tokens SET last_used_at=NOW(3) WHERE token_hash=?',[hash]);next()}catch(error){next(error)}
}
export async function revokeDesktopAuth(req,res,next){try{await pool.query('DELETE FROM firefly_api_tokens WHERE token_hash=? AND user_id=?',[req.fireflyTokenHash,req.fireflyUserId]);res.status(204).end()}catch(error){next(error)}}
export async function issueDesktopCode(req,res,next){try{const session=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});if(!session?.user?.id)return res.status(401).json({error:'Sign in before connecting Firefly.'});const code=crypto.randomBytes(24).toString('base64url');await pool.query('INSERT INTO firefly_desktop_codes (code_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(NOW(3),INTERVAL 5 MINUTE))',[digest(code),session.user.id]);res.json({code,expiresIn:300})}catch(error){next(error)}}
export async function claimDesktopCode(req,res,next){const connection=await pool.getConnection();try{const code=String(req.body?.code||''),deviceName=String(req.body?.deviceName||'Windows PC').slice(0,160);if(!/^[A-Za-z0-9_-]{24,80}$/.test(code))return res.status(400).json({error:'The connection code is invalid.'});await connection.beginTransaction();const [rows]=await connection.query('SELECT user_id FROM firefly_desktop_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>NOW(3) FOR UPDATE',[digest(code)]);if(!rows[0]){await connection.rollback();return res.status(400).json({error:'This connection code is invalid, expired, or already used.'})}const token=crypto.randomBytes(32).toString('base64url');await connection.query('UPDATE firefly_desktop_codes SET used_at=NOW(3) WHERE code_hash=?',[digest(code)]);await connection.query('INSERT INTO firefly_api_tokens (token_hash,user_id,device_name,expires_at) VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL 90 DAY))',[digest(token),rows[0].user_id,deviceName]);await ensureAccount(connection,rows[0].user_id);await connection.commit();res.json({token,expiresIn:7776000})}catch(error){await connection.rollback();next(error)}finally{connection.release()}}
export async function me(req,res,next){try{const [[user]]=await pool.query('SELECT id,name,email,phoneNumber FROM `user` WHERE id=?',[req.fireflyUserId]),connection=await pool.getConnection();let storage;try{await connection.beginTransaction();storage=await ensureAccount(connection,req.fireflyUserId);await connection.commit()}finally{connection.release()}res.json({user:{id:user.id,name:user.name,email:user.email,phoneNumber:user.phoneNumber||''},storageUsed:Number(storage.usage_bytes),storageLimit:Number(storage.quota_bytes)})}catch(error){next(error)}}
export async function headObject(req,res,next){try{const [rows]=await pool.query('SELECT size_bytes FROM firefly_sync_objects WHERE user_id=? AND content_hash=?',[req.fireflyUserId,req.params.hash]);if(!rows[0])return res.sendStatus(404);res.set('X-Firefly-Object-Size',String(rows[0].size_bytes)).status(200).end()}catch(error){next(error)}}
export async function putObject(req,res,next){const connection=await pool.getConnection();let target='';try{const hash=String(req.params.hash||'').toLowerCase(),body=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);if(!/^[a-f0-9]{64}$/.test(hash)||digest(body)!==hash)return res.status(400).json({error:'The uploaded file hash did not match its contents.'});await connection.beginTransaction();const [existing]=await connection.query('SELECT size_bytes FROM firefly_sync_objects WHERE user_id=? AND content_hash=? FOR UPDATE',[req.fireflyUserId,hash]);if(existing[0]){await connection.commit();return res.json({deduplicated:true,size:Number(existing[0].size_bytes)})}const account=await ensureAccount(connection,req.fireflyUserId);if(Number(account.usage_bytes)+body.length>Number(account.quota_bytes)){await connection.rollback();return res.status(413).json({error:'This upload would exceed the account’s storage limit.'})}let name='music-file';try{name=Buffer.from(String(req.headers['x-firefly-filename']||''),'base64url').toString('utf8').slice(0,190)||name}catch{/* Use the safe fallback. */}const storageName=`object-${safePart(req.fireflyUserId)}-${hash}.ff`;target=await encryptToFile(storageName,body);await connection.query('INSERT INTO firefly_sync_objects (user_id,content_hash,original_name,storage_name,size_bytes) VALUES (?,?,?,?,?)',[req.fireflyUserId,hash,name,storageName,body.length]);await connection.query('UPDATE firefly_storage_accounts SET usage_bytes=usage_bytes+? WHERE user_id=?',[body.length,req.fireflyUserId]);await connection.commit();res.json({stored:true,size:body.length})}catch(error){await connection.rollback();if(target)await fs.rm(target,{force:true}).catch(()=>{});next(error)}finally{connection.release()}}
export async function getObject(req,res,next){try{const [rows]=await pool.query('SELECT original_name,storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=? AND content_hash=?',[req.fireflyUserId,req.params.hash]);if(!rows[0])return res.status(404).json({error:'Cloud file not found.'});const data=await decryptFromFile(rows[0].storage_name);res.set({'Content-Type':'application/octet-stream','Content-Length':String(data.length),'Content-Disposition':`attachment; filename="${safePart(rows[0].original_name)||'firefly-audio'}"`}).send(data)}catch(error){next(error)}}
export async function putSnapshot(req,res,next){
  const connection=await pool.getConnection();
  let target='';
  try{
    const state=req.body?.state,deviceName=String(req.body?.deviceName||'Windows PC').slice(0,160);
    if(!state||typeof state!=='object'||!Array.isArray(state.albums))return res.status(400).json({error:'The Firefly snapshot is invalid.'});
    const body=Buffer.from(JSON.stringify(state));
    const referencedHashes=new Set(state.albums.flatMap(album=>Array.isArray(album?.tracks)?album.tracks:[]).map(track=>String(track?.cloudFile?.hash||'').toLowerCase()).filter(hash=>/^[a-f0-9]{64}$/.test(hash)));
    await connection.beginTransaction();
    const account=await ensureAccount(connection,req.fireflyUserId),[priorRows]=await connection.query('SELECT storage_name,size_bytes,revision FROM firefly_sync_snapshots WHERE user_id=? FOR UPDATE',[req.fireflyUserId]),prior=priorRows[0];
    const [objectRows]=await connection.query('SELECT content_hash,storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=? FOR UPDATE',[req.fireflyUserId]);
    const orphanedObjects=objectRows.filter(object=>!referencedHashes.has(String(object.content_hash).toLowerCase()));
    const reclaimedBytes=orphanedObjects.reduce((total,object)=>total+Number(object.size_bytes||0),0);
    const nextUsage=Math.max(0,Number(account.usage_bytes)-Number(prior?.size_bytes||0)-reclaimedBytes+body.length);
    if(nextUsage>Number(account.quota_bytes)){await connection.rollback();return res.status(413).json({error:"This backup would exceed the account's storage limit."})}
    const storageName=`snapshot-${safePart(req.fireflyUserId)}-${Date.now()}.ff`;
    target=await encryptToFile(storageName,body);
    await connection.query('INSERT INTO firefly_sync_snapshots (user_id,storage_name,size_bytes,revision,device_name) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE storage_name=VALUES(storage_name),size_bytes=VALUES(size_bytes),revision=revision+1,device_name=VALUES(device_name),synced_at=NOW(3)',[req.fireflyUserId,storageName,body.length,1,deviceName]);
    if(orphanedObjects.length)await connection.query(`DELETE FROM firefly_sync_objects WHERE user_id=? AND content_hash IN (${orphanedObjects.map(()=>'?').join(',')})`,[req.fireflyUserId,...orphanedObjects.map(object=>object.content_hash)]);
    await connection.query('UPDATE firefly_storage_accounts SET usage_bytes=? WHERE user_id=?',[nextUsage,req.fireflyUserId]);
    await connection.commit();
    if(prior?.storage_name)await fs.rm(path.join(storageRoot,path.basename(prior.storage_name)),{force:true}).catch(()=>{});
    await Promise.all(orphanedObjects.map(object=>fs.rm(path.join(storageRoot,path.basename(object.storage_name)),{force:true}).catch(()=>{})));
    const [[snapshot]]=await pool.query('SELECT revision,synced_at FROM firefly_sync_snapshots WHERE user_id=?',[req.fireflyUserId]);
    res.json({revision:Number(snapshot.revision),syncedAt:snapshot.synced_at,storageUsed:nextUsage,storageLimit:Number(account.quota_bytes)});
  }catch(error){
    await connection.rollback();
    if(target)await fs.rm(target,{force:true}).catch(()=>{});
    next(error);
  }finally{connection.release()}
}
export async function getSnapshot(req,res,next){try{const [rows]=await pool.query('SELECT storage_name,revision,device_name,synced_at FROM firefly_sync_snapshots WHERE user_id=?',[req.fireflyUserId]);if(!rows[0])return res.status(204).end();const data=await decryptFromFile(rows[0].storage_name);res.json({state:JSON.parse(data.toString('utf8')),revision:Number(rows[0].revision),deviceName:rows[0].device_name,syncedAt:rows[0].synced_at})}catch(error){next(error)}}
