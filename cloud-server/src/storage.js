import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, pool } from './auth.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredStorageRoot = String(process.env.STORAGE_ROOT || '').trim();
const legacyDeploymentStorage = !configuredStorageRoot || /^\.?[\\/]?storage[\\/]?$/i.test(configuredStorageRoot);
const persistentStorageRoot = process.env.HOME
  ? path.join(process.env.HOME, '.ignifire', 'storage')
  : path.resolve(serverRoot, '..', '.ignifire-storage');
const storageRoot = path.resolve(
  process.env.NODE_ENV === 'production' && legacyDeploymentStorage
    ? persistentStorageRoot
    : configuredStorageRoot || path.join(serverRoot, 'storage')
);
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

async function storedObjectAvailable(fileName) {
  try {
    const stats = await fs.stat(path.join(storageRoot, path.basename(fileName)));
    return stats.isFile() && stats.size >= 31;
  } catch { return false; }
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

export async function requireWebAuth(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.id) return res.status(401).json({ error: 'Sign in to use Ignifire for Web.' });
    req.fireflyUserId = session.user.id;
    req.fireflyWebUser = session.user;
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

function webArtwork(value) {
  const source = String(value || '');
  return /^(?:https:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i.test(source) ? source : '';
}

function webTrack(track = {}, availableHashes = null) {
  const hash = String(track.cloudFile?.hash || '').toLowerCase();
  const hasValidHash = /^[a-f0-9]{64}$/.test(hash);
  return {
    id: String(track.id || ''),
    title: String(track.title || 'Untitled track'),
    artist: String(track.artist || 'Unknown Artist'),
    album: String(track.album || 'Unknown Album'),
    albumId: String(track.albumId || ''),
    duration: String(track.duration || ''),
    durationSeconds: Math.max(0, Number(track.durationSeconds) || 0),
    trackNumber: Math.max(0, Number(track.trackNumber) || 0),
    discNumber: Math.max(1, Number(track.discNumber) || 1),
    plays: Math.max(0, Number(track.plays) || 0),
    lastPlayed: Number(track.lastPlayed) || null,
    added: Number(track.added) || 0,
    favorite: Boolean(track.favorite),
    playable: hasValidHash && (!availableHashes || availableHashes.has(hash)),
    cloudHash: hasValidHash ? hash : ''
  };
}

function webPlaylist(playlist = {}) {
  return {
    id: String(playlist.id || ''),
    title: String(playlist.title || 'Untitled playlist'),
    color: String(playlist.color || ''),
    trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds.map(String) : [],
    children: Array.isArray(playlist.children) ? playlist.children.map(webPlaylist) : [],
    coverDesign: playlist.coverDesign ? {
      background: String(playlist.coverDesign.background || ''),
      colorA: String(playlist.coverDesign.colorA || ''),
      colorB: String(playlist.coverDesign.colorB || ''),
      font: String(playlist.coverDesign.font || ''),
      layout: String(playlist.coverDesign.layout || ''),
      overlay: String(playlist.coverDesign.overlay || ''),
      title: String(playlist.coverDesign.title || ''),
      subtitle: String(playlist.coverDesign.subtitle || ''),
      image: webArtwork(playlist.coverDesign.image)
    } : null
  };
}

function webLibraryState(state = {}, availableHashes = null) {
  const albums = Array.isArray(state.albums) ? state.albums.map(album => ({
    id: String(album.id || ''),
    title: String(album.title || 'Untitled album'),
    artist: String(album.artist || 'Unknown Artist'),
    year: Number(album.year) || null,
    genre: String(album.genre || ''),
    cover: String(album.cover || ''),
    customCover: webArtwork(album.customCover),
    tracks: Array.isArray(album.tracks) ? album.tracks.filter(track => !track?.pending).map(track => webTrack(track, availableHashes)) : []
  })).filter(album => album.tracks.length) : [];
  const artistProfiles = {};
  if (state.artistProfiles && typeof state.artistProfiles === 'object' && !Array.isArray(state.artistProfiles)) {
    for (const [artist, profile] of Object.entries(state.artistProfiles)) {
      artistProfiles[String(artist)] = { image: webArtwork(profile?.image), animated: Boolean(profile?.animated) };
    }
  }
  return {
    albums,
    playlists: Array.isArray(state.playlists) ? state.playlists.map(webPlaylist) : [],
    artistProfiles,
    playHistory: Array.isArray(state.playHistory) ? state.playHistory.slice(-500).map(event => ({ trackId: String(event?.trackId || ''), playedAt: Number(event?.playedAt) || 0 })) : []
  };
}

export async function getWebLibrary(req, res, next) {
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    const storage = await ensureAccount(client, req.fireflyUserId);
    const { rows } = await client.query(
      'SELECT storage_name,revision,device_name,synced_at FROM firefly_sync_snapshots WHERE user_id=$1',
      [req.fireflyUserId]
    );
    await client.query('COMMIT');
    transaction = false;
    let library = null;
    if (rows[0] && await storedObjectAvailable(rows[0].storage_name)) {
      const data = await decryptFromFile(rows[0].storage_name);
      const state = JSON.parse(data.toString('utf8'));
      const hashes = [...new Set((Array.isArray(state.albums) ? state.albums : []).flatMap(album => Array.isArray(album?.tracks) ? album.tracks : [])
        .map(track => String(track?.cloudFile?.hash || '').toLowerCase())
        .filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
      const availableHashes = new Set();
      if (hashes.length) {
        const { rows: objects } = await client.query(
          'SELECT content_hash,storage_name FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=ANY($2::text[])',
          [req.fireflyUserId, hashes]
        );
        await Promise.all(objects.map(async object => {
          if (await storedObjectAvailable(object.storage_name)) availableHashes.add(String(object.content_hash).toLowerCase());
        }));
      }
      library = webLibraryState(state, availableHashes);
    }
    const catalogTracks = library?.albums?.flatMap(album => album.tracks || []) || [];
    const streamableTrackCount = catalogTracks.filter(track => track.playable).length;
    res.set('Cache-Control', 'private, no-store').json({
      user: {
        id: req.fireflyWebUser.id,
        name: req.fireflyWebUser.name || 'Ignifire listener',
        email: /@phone\.(?:firefly|ignifire)\.invalid$/i.test(String(req.fireflyWebUser.email || '')) ? '' : String(req.fireflyWebUser.email || ''),
        phoneNumber: String(req.fireflyWebUser.phoneNumber || '')
      },
      storageUsed: Number(storage.usage_bytes),
      storageLimit: Number(storage.quota_bytes),
      revision: Number(rows[0]?.revision || 0),
      syncedAt: rows[0]?.synced_at || null,
      deviceName: rows[0]?.device_name || '',
      catalogTrackCount: catalogTracks.length,
      streamableTrackCount,
      missingTrackCount: Math.max(0, catalogTracks.length - streamableTrackCount),
      library
    });
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

export async function headObject(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2',
      [req.fireflyUserId, req.params.hash]
    );
    if (!rows[0]) return res.sendStatus(404);
    if (!(await storedObjectAvailable(rows[0].storage_name))) {
      return res.set('X-Ignifire-Object-State', 'missing').sendStatus(404);
    }
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
      'SELECT storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2 FOR UPDATE',
      [req.fireflyUserId, hash]
    );
    if (existing[0] && await storedObjectAvailable(existing[0].storage_name)) {
      await client.query('COMMIT');
      transaction = false;
      return res.json({ deduplicated: true, size: Number(existing[0].size_bytes) });
    }
    if (existing[0]) {
      await client.query(
        'DELETE FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2',
        [req.fireflyUserId, hash]
      );
      await client.query(
        'UPDATE firefly_storage_accounts SET usage_bytes=GREATEST(0,usage_bytes-$1),updated_at=CURRENT_TIMESTAMP WHERE user_id=$2',
        [Number(existing[0].size_bytes) || 0, req.fireflyUserId]
      );
      account.usage_bytes = Math.max(0, Number(account.usage_bytes) - (Number(existing[0].size_bytes) || 0));
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
    const size = data.length, headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': audioContentType(rows[0].original_name),
      'Content-Disposition': `inline; filename="${safePart(rows[0].original_name) || 'ignifire-audio'}"`,
      'Cache-Control': 'private, max-age=3600'
    };
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (!range) return res.set({ ...headers, 'Content-Length': String(size) }).send(data);
    let start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1] && range[2]) { const suffix = Math.max(0, Number(range[2]));start = Math.max(0, size - suffix);end = size - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    end = Math.min(end, size - 1);const chunk = data.subarray(start, end + 1);
    return res.status(206).set({ ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(chunk.length) }).send(chunk);
  } catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: 'This cloud file needs to be uploaded again.' });
    next(error);
  }
}

function audioContentType(fileName = '') {
  const extension = path.extname(fileName).toLowerCase();
  return ({
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wave': 'audio/wav', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.opus': 'audio/ogg; codecs=opus', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff'
  })[extension] || 'application/octet-stream';
}

export async function streamWebObject(req, res, next) {
  try {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ error: 'The cloud track identifier is invalid.' });
    const { rows } = await pool.query(
      'SELECT original_name,storage_name,size_bytes FROM firefly_sync_objects WHERE user_id=$1 AND content_hash=$2',
      [req.fireflyUserId, hash]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cloud track not found.' });
    const data = await decryptFromFile(rows[0].storage_name);
    const size = data.length;
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': audioContentType(rows[0].original_name),
      'Content-Disposition': `inline; filename="${safePart(rows[0].original_name) || 'ignifire-audio'}"`,
      'Cache-Control': 'private, max-age=3600'
    };
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (!range) return res.set({ ...commonHeaders, 'Content-Length': String(size) }).send(data);
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1] && range[2]) { const suffix = Math.max(0, Number(range[2]));start = Math.max(0, size - suffix);end = size - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    end = Math.min(end, size - 1);
    const chunk = data.subarray(start, end + 1);
    res.status(206).set({ ...commonHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(chunk.length) }).send(chunk);
  } catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: 'This cloud track needs to be uploaded again.' });
    next(error);
  }
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
    if (!(await storedObjectAvailable(rows[0].storage_name))) return res.status(204).end();
    const data = await decryptFromFile(rows[0].storage_name);
    res.json({
      state: JSON.parse(data.toString('utf8')),
      revision: Number(rows[0].revision),
      deviceName: rows[0].device_name,
      syncedAt: rows[0].synced_at
    });
  } catch (error) { next(error); }
}
