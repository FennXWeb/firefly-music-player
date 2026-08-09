import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, pool } from './auth.js';

const storageRoot = path.resolve(process.env.STORAGE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage'));
const legacyDefaultQuota = 157286400;
const standardQuota = 256 * 1024 * 1024 * 1024;
const configuredQuota = Number(process.env.DEFAULT_STORAGE_LIMIT_BYTES);
const defaultQuota = Math.max(1024 * 1024, configuredQuota > 0 && configuredQuota !== legacyDefaultQuota ? configuredQuota : standardQuota);
const encryptionKey = (() => {
  const value = Buffer.from(process.env.STORAGE_ENCRYPTION_KEY || '', 'base64');
  if (value.length !== 32) throw new Error('STORAGE_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64.');
  return value;
})();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safePart = value => String(value).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 100);

async function ensureAccount(client, userId) {
  await client.query(
    'INSERT INTO firefly_storage_accounts (user_id, quota_bytes, usage_bytes) VALUES ($1, $2, 0) ON CONFLICT (user_id) DO NOTHING',
    [userId, defaultQuota]
  );
  await client.query(
    'UPDATE firefly_storage_accounts SET quota_bytes=$1, updated_at=CURRENT_TIMESTAMP WHERE user_id=$2 AND quota_bytes=$3',
    [defaultQuota, userId, legacyDefaultQuota]
  );
  const { rows: [account] } = await client.query(
    'SELECT quota_bytes, usage_bytes FROM firefly_storage_accounts WHERE user_id=$1 FOR UPDATE',
    [userId]
  );
  return account;
}

async function encryptToFile(fileName, plaintext) {
  await fs.mkdir(storageRoot, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from('FF1'), iv, tag, ciphertext]);
  const target = path.join(storageRoot, fileName);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, payload);
  await fs.rename(temporary, target);
  return target;
}

async function decryptFromFile(fileName) {
  const payload = await fs.readFile(path.join(storageRoot, path.basename(fileName)));
  if (payload.subarray(0, 3).toString() !== 'FF1') throw new Error('Stored object header is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, payload.subarray(3, 15));
  decipher.setAuthTag(payload.subarray(15, 31));
  return Buffer.concat([decipher.update(payload.subarray(31)), decipher.final()]);
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export async function requireDesktopAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Sign in to Ignifire first.' });
    const hash = digest(token);
    const { rows } = await pool.query(
      'SELECT user_id FROM firefly_api_tokens WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP',
      [hash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'This Ignifire session has expired.' });
    req.fireflyUserId = rows[0].user_id;
    req.fireflyTokenHash = hash;
    void pool.query('UPDATE firefly_api_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE token_hash=$1', [hash]).catch(() => {});
    next();
  } catch (error) { next(error); }
}

export async function revokeDesktopAuth(req, res, next) {
  try {
    await pool.query('DELETE FROM firefly_api_tokens WHERE token_hash=$1 AND user_id=$2', [req.fireflyTokenHash, req.fireflyUserId]);
    res.status(204).end();
  } catch (error) { next(error); }
}

export async function issueDesktopCode(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.id) return res.status(401).json({ error: 'Sign in before connecting Ignifire.' });
    const code = crypto.randomBytes(24).toString('base64url');
    await pool.query(
      "INSERT INTO firefly_desktop_codes (code_hash,user_id,expires_at) VALUES ($1,$2,CURRENT_TIMESTAMP + INTERVAL '5 minutes')",
      [digest(code), session.user.id]
    );
    res.json({ code, expiresIn: 300 });
  } catch (error) { next(error); }
}

export async function claimDesktopCode(req, res, next) {
  const client = await pool.connect();
  let transaction = false;
  try {
    const code = String(req.body?.code || '');
    const deviceName = String(req.body?.deviceName || 'Windows PC').slice(0, 160);
    if (!/^[A-Za-z0-9_-]{24,80}$/.test(code)) return res.status(400).json({ error: 'The connection code is invalid.' });
    await client.query('BEGIN');
    transaction = true;
    const { rows } = await client.query(
      'SELECT user_id FROM firefly_desktop_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP FOR UPDATE',
      [digest(code)]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(400).json({ error: 'This connection code is invalid, expired, or already used.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query('UPDATE firefly_desktop_codes SET used_at=CURRENT_TIMESTAMP WHERE code_hash=$1', [digest(code)]);
    await client.query(
      "INSERT INTO firefly_api_tokens (token_hash,user_id,device_name,expires_at) VALUES ($1,$2,$3,CURRENT_TIMESTAMP + INTERVAL '90 days')",
      [digest(token), rows[0].user_id, deviceName]
    );
    await ensureAccount(client, rows[0].user_id);
    await client.query('COMMIT');
    transaction = false;
    res.json({ token, expiresIn: 7776000 });
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

export async function me(req, res, next) {
  const client = await pool.connect();
  let transaction = false;
  try {
    const { rows: [user] } = await client.query(
      'SELECT id,name,email,"phoneNumber" FROM "user" WHERE id=$1',
      [req.fireflyUserId]
    );
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    await client.query('BEGIN');
    transaction = true;
    const storage = await ensureAccount(client, req.fireflyUserId);
    await client.query('COMMIT');
    transaction = false;
    res.json({
      user: { id: user.id, name: user.name, email: user.email, phoneNumber: user.phoneNumber || '' },
      storageUsed: Number(storage.usage_bytes),
      storageLimit: Number(storage.quota_bytes)
    });
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

export async function headObject(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2',
      [req.fireflyUserId, req.params.hash]
    );
    if (!rows[0]) return res.sendStatus(404);
    const size = String(rows[0].size_bytes);
    res.set({ 'X-Ignifire-Object-Size': size, 'X-Firefly-Object-Size': size }).status(200).end();
  } catch (error) { next(error); }
}

export async function putObject(req, res, next) {
  const client = await pool.connect();
  let transaction = false;
  let target = '';
  try {
    const hash = String(req.params.hash || '').toLowerCase();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!/^[a-f0-9]{64}$/.test(hash) || digest(body) !== hash) return res.status(400).json({ error: 'The uploaded file hash did not match its contents.' });
    await client.query('BEGIN');
    transaction = true;
    const account = await ensureAccount(client, req.fireflyUserId);
    const { rows: existing } = await client.query(
      'SELECT size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2 FOR UPDATE',
      [req.fireflyUserId, hash]
    );
    if (existing[0]) {
      await client.query('COMMIT');
      transaction = false;
      return res.json({ deduplicated: true, size: Number(existing[0].size_bytes) });
    }
    if (Number(account.usage_bytes) + body.length > Number(account.quota_bytes)) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(413).json({ error: 'This upload would exceed the account’s storage limit.' });
    }
    let name = 'music-file';
    try {
      name = Buffer.from(String(req.headers['x-ignifire-filename'] || req.headers['x-firefly-filename'] || ''), 'base64url').toString('utf8').slice(0, 190) || name;
    } catch { /* Use the safe fallback. */ }
    const storageName = `object-${safePart(req.fireflyUserId)}-${hash}.ff`;
    target = await encryptToFile(storageName, body);
    await client.query(
      'INSERT INTO firefly_sync_objects (user_id,content_hash,original_name,storage_name,size_bytes) VALUES ($1,$2,$3,$4,$5)',
      [req.fireflyUserId, hash, name, storageName, body.length]
    );
    await client.query(
      'UPDATE firefly_storage_accounts SET usage_bytes=usage_bytes+$1,updated_at=CURRENT_TIMESTAMP WHERE user_id=$2',
      [body.length, req.fireflyUserId]
    );
    await client.query('COMMIT');
    transaction = false;
    res.json({ stored: true, size: body.length });
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (target) await fs.rm(target, { force: true }).catch(() => {});
    next(error);
  } finally { client.release(); }
}

export async function getObject(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT original_name,storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2',
      [req.fireflyUserId, req.params.hash]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cloud file not found.' });
    const data = await decryptFromFile(rows[0].storage_name);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${safePart(rows[0].original_name) || 'ignifire-audio'}"`
    }).send(data);
  } catch (error) { next(error); }
}

export async function putSnapshot(req, res, next) {
  const client = await pool.connect();
  let transaction = false;
  let target = '';
  try {
    const state = req.body?.state;
    const deviceName = String(req.body?.deviceName || 'Windows PC').slice(0, 160);
    if (!state || typeof state !== 'object' || !Array.isArray(state.albums)) return res.status(400).json({ error: 'The Ignifire snapshot is invalid.' });
    const body = Buffer.from(JSON.stringify(state));
    const referencedHashes = new Set(
      state.albums.flatMap(album => Array.isArray(album?.tracks) ? album.tracks : [])
        .map(track => String(track?.cloudFile?.hash || '').toLowerCase())
        .filter(hash => /^[a-f0-9]{64}$/.test(hash))
    );
    await client.query('BEGIN');
    transaction = true;
    const account = await ensureAccount(client, req.fireflyUserId);
    const { rows: priorRows } = await client.query(
      'SELECT storage_name,size_bytes,revision FROM firefly_sync_snapshots WHERE user_id=$1 FOR UPDATE',
      [req.fireflyUserId]
    );
    const prior = priorRows[0];
    const { rows: objectRows } = await client.query(
      'SELECT content_hash,storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=$1 FOR UPDATE',
      [req.fireflyUserId]
    );
    const orphanedObjects = objectRows.filter(object => !referencedHashes.has(String(object.content_hash).toLowerCase()));
    const reclaimedBytes = orphanedObjects.reduce((total, object) => total + Number(object.size_bytes || 0), 0);
    const nextUsage = Math.max(0, Number(account.usage_bytes) - Number(prior?.size_bytes || 0) - reclaimedBytes + body.length);
    if (nextUsage > Number(account.quota_bytes)) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(413).json({ error: "This backup would exceed the account's storage limit." });
    }
    const storageName = `snapshot-${safePart(req.fireflyUserId)}-${Date.now()}.ff`;
    target = await encryptToFile(storageName, body);
    const { rows: [snapshot] } = await client.query(
      `INSERT INTO firefly_sync_snapshots (user_id,storage_name,size_bytes,revision,device_name)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         storage_name=EXCLUDED.storage_name,
         size_bytes=EXCLUDED.size_bytes,
         revision=firefly_sync_snapshots.revision+1,
         device_name=EXCLUDED.device_name,
         synced_at=CURRENT_TIMESTAMP
       RETURNING revision,synced_at`,
      [req.fireflyUserId, storageName, body.length, deviceName]
    );
    if (orphanedObjects.length) {
      const placeholders = orphanedObjects.map((_, index) => `$${index + 2}`).join(',');
      await client.query(
        `DELETE FROM firefly_sync_objects WHERE user_id=$1 AND content_hash IN (${placeholders})`,
        [req.fireflyUserId, ...orphanedObjects.map(object => object.content_hash)]
      );
    }
    await client.query(
      'UPDATE firefly_storage_accounts SET usage_bytes=$1,updated_at=CURRENT_TIMESTAMP WHERE user_id=$2',
      [nextUsage, req.fireflyUserId]
    );
    await client.query('COMMIT');
    transaction = false;
    if (prior?.storage_name) await fs.rm(path.join(storageRoot, path.basename(prior.storage_name)), { force: true }).catch(() => {});
    await Promise.all(orphanedObjects.map(object => fs.rm(path.join(storageRoot, path.basename(object.storage_name)), { force: true }).catch(() => {})));
    res.json({
      revision: Number(snapshot.revision),
      syncedAt: snapshot.synced_at,
      storageUsed: nextUsage,
      storageLimit: Number(account.quota_bytes)
    });
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (target) await fs.rm(target, { force: true }).catch(() => {});
    next(error);
  } finally { client.release(); }
}

export async function getSnapshot(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT storage_name,revision,device_name,synced_at FROM firefly_sync_snapshots WHERE user_id=$1',
      [req.fireflyUserId]
    );
    if (!rows[0]) return res.status(204).end();
    const data = await decryptFromFile(rows[0].storage_name);
    res.json({
      state: JSON.parse(data.toString('utf8')),
      revision: Number(rows[0].revision),
      deviceName: rows[0].device_name,
      syncedAt: rows[0].synced_at
    });
  } catch (error) { next(error); }
}
