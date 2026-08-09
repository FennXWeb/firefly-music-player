const { app, BrowserWindow, shell, dialog, ipcMain, safeStorage, session, net, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsNative = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const AdmZip = require('adm-zip');
const DiscordRPC = require('discord-rpc');

// Keep user content completely separate from the portable executable and its
// temporary extraction directory. This path is stable across Ignifire upgrades.
// Retain the original profile directory so the first durable-data build can
// migrate the user's existing localStorage library in place.
const configuredDataRoot = process.env.IGNIFIRE_DATA_ROOT || process.env.FIREFLY_DATA_ROOT;
// Keep the legacy on-disk directory so upgrading users retain every library,
// credential, downloaded update, and generated asset after the rebrand.
const persistentRoot = configuredDataRoot
  ? path.resolve(configuredDataRoot)
  : path.join(app.getPath('appData'), 'firefly-music');
app.setPath('userData', persistentRoot);
const dataDirectory = path.join(persistentRoot, 'Data');
const statePath = path.join(dataDirectory, 'library.json');
const credentialsPath = path.join(dataDirectory, 'credentials.json');
const fontDirectory = path.join(dataDirectory, 'fonts');
const fontManifestPath = path.join(fontDirectory, 'manifest.json');
const dynamicArtDirectory = path.join(dataDirectory, 'dynamic-case-art');
const artistArtDirectory = path.join(dataDirectory, 'artist-art');
const sunoDirectory = path.join(dataDirectory, 'suno');
const updatesDirectory = path.join(dataDirectory, 'updates');
const zipImportDirectory = path.join(dataDirectory, 'zip-imports');
const cloudCacheDirectory = path.join(dataDirectory, 'cloud-library');
const apiPassBaseUrl = 'https://api.apipass.dev';
const ignifireAccountEndpoint = 'https://accounts.ignifire.app';
const updateRepository = 'FennXWeb/firefly-music-player';
const updateBranches = { stable: 'main', beta: 'beta' };
const ignifireDiscordApplicationId = '1535771097595777104';
let preparedUpdate = null;
let primaryWindow = null;
let nativePlaybackState = { playing: false, hasTrack: false, title: '', artist: '', album: '', durationSeconds: 0, positionSeconds: 0, artworkUrl: '' };
let discordClient = null;
let discordClientId = '';
let discordConfig = { enabled: false, showTrack: true, showAlbum: true, showPaused: true, timeDisplay: 'elapsed', shareArtwork: true, showButton: false };
let discordStatus = { status: 'disabled', error: '' };
let discordReconnectTimer = null;
let discordConnectionToken = 0;
let lastDiscordActivity = '';
const liveFolderWatchers = new Map();
const liveEntryCache = new Map();
let cloudSyncTimer = null;
let cloudSyncInFlight = false;
let pendingCloudState = null;

const taskbarIconData = {
  previous: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAS0lEQVR4nO3POwoAMAhEQe9/6U2VRvCzKoSAr14GFdmYACAc3DLYCAhVGdRQC7QwGvQgGsz2Dhx/OXt5CfTQMmjBbVBvox3VOPhnB5a2xkg1hCLdAAAAAElFTkSuQmCC',
  play: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAR0lEQVR4nO3P0QkAIAwD0e6/dMQ/KVZtGhDEG+DBmf16ACAHpShccrAMRyCNrkAKPgFT6BVQtpyCdiCFzUAa8mAZGkEZ9n4N/qc22IE0LvwAAAAASUVORK5CYII=',
  pause: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAIElEQVR4nGNgGAUg8B8JkCI3auCogaMGjhpImoHDGwAAPUFOwNAX5xQAAAAASUVORK5CYII=',
  next: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAS0lEQVR4nO3PMQ4AIAgDQP7/6TppjEEowuBA5/aSinQAoBxkUWyhSh78BFqDFKiN0uA5LgMn8C9YdtnqhkGvS4PXYhS0oDDIYJ2VATraxkiKxaCQAAAAAElFTkSuQmCC'
};
const taskbarIcons = {};
const mediaAccelerators = new Map([
  ['Media Play/Pause', 'toggle'],
  ['Media Next Track', 'next'],
  ['Media Previous Track', 'previous'],
  ['Media Stop', 'stop']
]);

function taskbarIcon(name) {
  taskbarIcons[name] ||= nativeImage.createFromBuffer(Buffer.from(taskbarIconData[name], 'base64'));
  return taskbarIcons[name];
}
function sendMediaCommand(command, win = primaryWindow) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send('media:command', command);
  return true;
}
function updateTaskbarControls(win = primaryWindow) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const enabled = nativePlaybackState.hasTrack ? ['enabled'] : ['disabled'];
  win.setThumbarButtons([
    { tooltip: 'Previous track', icon: taskbarIcon('previous'), flags: enabled, click: () => sendMediaCommand('previous', win) },
    { tooltip: nativePlaybackState.playing ? 'Pause' : 'Play', icon: taskbarIcon(nativePlaybackState.playing ? 'pause' : 'play'), flags: enabled, click: () => sendMediaCommand('toggle', win) },
    { tooltip: 'Next track', icon: taskbarIcon('next'), flags: enabled, click: () => sendMediaCommand('next', win) }
  ]);
  const details = nativePlaybackState.hasTrack ? `${nativePlaybackState.title}${nativePlaybackState.artist ? ` — ${nativePlaybackState.artist}` : ''}` : 'Ignifire';
  win.setThumbnailToolTip(details);
}
function registerMediaHotkeys() {
  for (const [accelerator, command] of mediaAccelerators) {
    try { globalShortcut.register(accelerator, () => sendMediaCommand(command)); }
    catch { /* Some keyboards or Windows utilities reserve individual media keys. */ }
  }
}

function cleanDiscordConfig(value = {}) {
  const timeDisplay = ['off', 'elapsed', 'remaining'].includes(value.timeDisplay) ? value.timeDisplay : 'elapsed';
  return {
    enabled: Boolean(value.enabled),
    showTrack: value.showTrack !== false,
    showAlbum: value.showAlbum !== false,
    showPaused: value.showPaused !== false,
    timeDisplay,
    shareArtwork: value.shareArtwork !== false,
    showButton: Boolean(value.showButton)
  };
}
function sendDiscordStatus(status, error = '') {
  discordStatus = { status, error: String(error || '').slice(0, 240) };
  if (primaryWindow && !primaryWindow.isDestroyed() && !primaryWindow.webContents.isDestroyed()) primaryWindow.webContents.send('discord:status', discordStatus);
  return discordStatus;
}
function clearDiscordReconnect() {
  if (discordReconnectTimer) clearTimeout(discordReconnectTimer);
  discordReconnectTimer = null;
}
function destroyDiscordClient(status = 'disabled') {
  clearDiscordReconnect();
  discordConnectionToken += 1;
  const client = discordClient;
  discordClient = null;
  discordClientId = '';
  lastDiscordActivity = '';
  if (client) Promise.resolve(client.destroy()).catch(() => {});
  return sendDiscordStatus(status);
}
function scheduleDiscordReconnect() {
  clearDiscordReconnect();
  if (!discordConfig.enabled) return;
  discordReconnectTimer = setTimeout(() => connectDiscord(), 30000);
  discordReconnectTimer.unref?.();
}
function discordActivity() {
  if (!nativePlaybackState.hasTrack || (!nativePlaybackState.playing && !discordConfig.showPaused)) return null;
  const title = nativePlaybackState.title || 'Unknown track';
  const artist = nativePlaybackState.artist || 'Unknown artist';
  const activity = {
    details: discordConfig.showTrack ? title.slice(0, 128) : (nativePlaybackState.playing ? 'Listening in Ignifire' : 'Paused in Ignifire'),
    state: (discordConfig.showAlbum && nativePlaybackState.album ? `${artist} — ${nativePlaybackState.album}` : artist).slice(0, 128),
    instance: false
  };
  if (nativePlaybackState.playing && discordConfig.timeDisplay === 'elapsed') activity.startTimestamp = new Date(Date.now() - nativePlaybackState.positionSeconds * 1000);
  if (nativePlaybackState.playing && discordConfig.timeDisplay === 'remaining' && nativePlaybackState.durationSeconds > nativePlaybackState.positionSeconds) activity.endTimestamp = new Date(Date.now() + (nativePlaybackState.durationSeconds - nativePlaybackState.positionSeconds) * 1000);
  const externalArtwork = discordConfig.shareArtwork && /^https:\/\//i.test(nativePlaybackState.artworkUrl) ? nativePlaybackState.artworkUrl : '';
  if (externalArtwork) {
    activity.largeImageKey = externalArtwork;
    activity.largeImageText = `${nativePlaybackState.album || title} · Ignifire`.slice(0, 128);
  }
  if (discordConfig.showButton) activity.buttons = [{ label: 'Get Ignifire', url: 'https://github.com/FennXWeb/firefly-music-player' }];
  return activity;
}
async function updateDiscordPresence(force = false) {
  if (!discordClient || discordStatus.status !== 'connected') return;
  const activity = discordActivity();
  const key = activity ? JSON.stringify({ ...activity, startTimestamp: activity.startTimestamp?.getTime(), endTimestamp: activity.endTimestamp?.getTime() }) : 'clear';
  if (!force && key === lastDiscordActivity) return;
  lastDiscordActivity = key;
  try {
    if (activity) await discordClient.setActivity(activity);
    else await discordClient.clearActivity();
  } catch (error) {
    lastDiscordActivity = '';
    sendDiscordStatus('unavailable', error?.message || 'Discord is unavailable.');
    scheduleDiscordReconnect();
  }
}
async function connectDiscord(nextConfig) {
  if (nextConfig) discordConfig = cleanDiscordConfig(nextConfig);
  if (!discordConfig.enabled) return destroyDiscordClient('disabled');
  if (discordClient && discordClientId === ignifireDiscordApplicationId && discordStatus.status === 'connected') {
    await updateDiscordPresence(true);
    return discordStatus;
  }
  destroyDiscordClient('connecting');
  const token = discordConnectionToken;
  const client = new DiscordRPC.Client({ transport: 'ipc' });
  discordClient = client;
  discordClientId = ignifireDiscordApplicationId;
  const disconnect = () => {
    if (discordClient !== client || token !== discordConnectionToken) return;
    discordClient = null;
    discordClientId = '';
    lastDiscordActivity = '';
    sendDiscordStatus('unavailable', 'Discord is closed or its local connection was interrupted.');
    scheduleDiscordReconnect();
  };
  client.on('disconnected', disconnect);
  client.on('error', disconnect);
  try {
    await client.login({ clientId: ignifireDiscordApplicationId });
    if (discordClient !== client || token !== discordConnectionToken) return discordStatus;
    sendDiscordStatus('connected');
    await updateDiscordPresence(true);
  } catch (error) {
    if (discordClient === client && token === discordConnectionToken) {
      discordClient = null;
      discordClientId = '';
      Promise.resolve(client.destroy()).catch(() => {});
      sendDiscordStatus('unavailable', error?.message || 'Open Discord and try again.');
      scheduleDiscordReconnect();
    }
  }
  return discordStatus;
}

const audioExtensions = new Set(['.mp3','.wav','.flac','.m4a','.aac','.ogg','.opus','.wma']);
const imageExtensions = new Set(['.jpg','.jpeg','.png','.webp','.bmp']);
const dynamicFontCatalog = [
  ['Inter','sans',['modern','minimal','pop']],['Montserrat','sans',['bold','modern','pop']],
  ['Poppins','sans',['bright','modern','dance']],['Roboto','sans',['clean','neutral','electronic']],
  ['Nunito Sans','sans',['soft','friendly','indie']],['Rubik','sans',['geometric','pop','electronic']],
  ['Josefin Sans','sans',['vintage','indie','elegant']],['Oswald','display',['condensed','rock','bold']],
  ['Bebas Neue','display',['condensed','rock','cinematic']],['Anton','display',['loud','metal','bold']],
  ['Righteous','display',['retro','funk','electronic']],['Orbitron','display',['futuristic','electronic','industrial']],
  ['Playfair Display','serif',['elegant','soul','jazz']],['Merriweather','serif',['warm','folk','acoustic']],
  ['Lora','serif',['literary','folk','indie']],['Cormorant Garamond','serif',['classical','dramatic','elegant']],
  ['Cinzel','serif',['epic','classical','cinematic']],['Abril Fatface','serif',['retro','soul','bold']],
  ['DM Serif Display','serif',['editorial','jazz','soul']],['Libre Baskerville','serif',['classic','acoustic','folk']],
  ['Space Mono','mono',['electronic','experimental','industrial']],['IBM Plex Mono','mono',['technical','electronic','minimal']],
  ['Permanent Marker','handwriting',['punk','garage','playful']],['Caveat','handwriting',['intimate','acoustic','indie']]
].map(([family,category,moods],index)=>({id:`font-${String(index+1).padStart(2,'0')}`,family,category,moods}));

let metadataModule;
async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
}
async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath).catch(async () => {
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
  });
}
async function writeBufferAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, value);
  await fs.rename(temporaryPath, filePath).catch(async () => {
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
  });
}
async function accountCredentials() {
  const saved = await readJson(credentialsPath, {});
  return { token: decryptSecret(saved.accountToken) };
}
async function updateAccountCredentials({ token } = {}) {
  const saved = await readJson(credentialsPath, {});
  if (token !== undefined) saved.accountToken = encryptSecret(token);
  delete saved.accountEndpoint;
  await writeJsonAtomic(credentialsPath, saved);
}
async function accountRequest(resource, options = {}) {
  const stored = await accountCredentials(), endpoint = ignifireAccountEndpoint;
  const token = options.token ?? stored.token;
  const { endpoint: _endpoint, token: _token, headers: requestedHeaders, ...requestOptions } = options;
  const headers = { Accept: 'application/json', 'User-Agent': `Ignifire/${app.getVersion()}`, ...(requestedHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await net.fetch(`${endpoint}${resource}`, { ...requestOptions, headers });
  if (!response.ok) {
    let detail = '';
    try { detail = String((await response.json())?.error || ''); } catch { /* Use the HTTP status below. */ }
    const error = new Error(detail || `Account server returned ${response.status}.`);error.status = response.status;throw error;
  }
  return response;
}
async function accountStatus() {
  const stored = await accountCredentials();
  if (!stored.token) return { signedIn: false, configured: true };
  try {
    const response = await accountRequest('/v1/me');
    return { signedIn: true, configured: true, ...(await response.json()) };
  } catch (error) {
    if (error.status === 401) { await updateAccountCredentials({ token: '' });return { signedIn: false, configured: true, expired: true }; }
    return { signedIn: false, configured: true, offline: true, error: error.message };
  }
}
async function uploadCloudObject(filePath, endpoint, token) {
  const stats = await fs.stat(filePath);if (!stats.isFile()) return null;
  const hash = await new Promise((resolve, reject) => {const digest=crypto.createHash('sha256'),stream=fsNative.createReadStream(filePath);stream.on('data',chunk=>digest.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(digest.digest('hex')))});
  const name = path.basename(filePath).slice(0, 180), encodedName = Buffer.from(name, 'utf8').toString('base64url');
  const existing = await accountRequest(`/v1/sync/objects/${hash}`, { method: 'HEAD', endpoint, token }).catch(error => error.status === 404 ? null : Promise.reject(error));
  if (!existing) {
    const body = await fs.readFile(filePath);
    await accountRequest(`/v1/sync/objects/${hash}`, { method: 'PUT', endpoint, token, body, headers: { 'Content-Type': 'application/octet-stream', 'X-Ignifire-Filename': encodedName, 'X-Firefly-Filename': encodedName } });
  }
  return { hash, name, size: stats.size };
}
async function embedPortableFiles(value, key = '') {
  if (Array.isArray(value)) return Promise.all(value.map(item => embedPortableFiles(item, key)));
  if (value && typeof value === 'object') {for (const [childKey, child] of Object.entries(value)) value[childKey] = await embedPortableFiles(child, childKey);return value}
  if (typeof value !== 'string') return value;
  if (key === 'path' || /(?:sourcePath|backgroundPath|audioPath)$/i.test(key)) return null;
  if (!value.startsWith('file:')) return value;
  try {
    const filePath=fileURLToPath(value),stats=await fs.stat(filePath);if(!stats.isFile()||stats.size>50*1024*1024)return null;
    const extension=path.extname(filePath).toLowerCase(),mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.mp4':'video/mp4','.webm':'video/webm'}[extension]||'application/octet-stream');
    return `data:${mime};base64,${(await fs.readFile(filePath)).toString('base64')}`;
  } catch { return null; }
}
async function portableCloudState(state, endpoint, token) {
  const portable = JSON.parse(JSON.stringify(state || {}));
  portable.liveFolders = [];
  const sourceTracks = new Map((state?.albums || []).flatMap(album => (album.tracks || []).map(track => [track.id, track])));
  for (const album of portable.albums || []) for (const track of album.tracks || []) {
    const original = sourceTracks.get(track.id), filePath = String(original?.path || '');
    track.path = null;track.url = null;delete track.liveFolderId;delete track.cloudSourceId;
    if (!filePath) continue;
    try { track.cloudFile = await uploadCloudObject(filePath, endpoint, token); }
    catch (error) { if (error.status === 413) throw error;track.cloudFileUnavailable = true; }
  }
  await embedPortableFiles(portable);
  portable.cloudSnapshot = { createdAt: new Date().toISOString(), appVersion: app.getVersion() };
  return portable;
}
async function uploadCloudSnapshot(state, { manual = false } = {}) {
  if (cloudSyncInFlight) { pendingCloudState = state;return { queued: true }; }
  const endpoint = ignifireAccountEndpoint, enabled = Boolean(state?.settings?.cloudSyncEnabled);
  const { token } = await accountCredentials();
  if (!enabled || !endpoint || !token) return { skipped: true };
  cloudSyncInFlight = true;
  try {
    const portable = await portableCloudState(state, endpoint, token);
    const response = await accountRequest('/v1/sync/snapshot', { method: 'PUT', endpoint, token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: portable, deviceName: process.env.COMPUTERNAME || 'Windows PC' }) });
    const result = await response.json();
    primaryWindow?.webContents?.send('account:sync-status', { status: 'synced', ...result });
    return result;
  } catch (error) {
    primaryWindow?.webContents?.send('account:sync-status', { status: 'error', error: error.message });
    if (manual) throw error;
    return { error: error.message };
  } finally {
    cloudSyncInFlight = false;
    if (pendingCloudState) { const next = pendingCloudState;pendingCloudState = null;scheduleCloudBackup(next, 500); }
  }
}
function scheduleCloudBackup(state, delay = 3500) {
  clearTimeout(cloudSyncTimer);cloudSyncTimer = setTimeout(() => uploadCloudSnapshot(state), delay);cloudSyncTimer.unref?.();
}
async function downloadCloudSnapshot() {
  const stored = await accountCredentials(), base = ignifireAccountEndpoint;
  const response = await accountRequest('/v1/sync/snapshot', { endpoint: base, token: stored.token });
  if (response.status === 204) return null;
  const payload = await response.json(), state = payload.state;
  await fs.mkdir(cloudCacheDirectory, { recursive: true });
  for (const album of state?.albums || []) for (const track of album.tracks || []) {
    if (!track.cloudFile?.hash) continue;
    const stem = `${track.cloudFile.hash.slice(0,16)}-${safeFileStem(track.cloudFile.name || `${track.id}.audio`)}`, destination = path.join(cloudCacheDirectory, stem);
    try { await fs.stat(destination); }
    catch {
      const asset = await accountRequest(`/v1/sync/objects/${track.cloudFile.hash}`, { endpoint: base, token: stored.token, headers: { Accept: 'application/octet-stream' } });
      await writeBufferAtomic(destination, Buffer.from(await asset.arrayBuffer()));
    }
    track.path = destination;track.url = pathToFileURL(destination).href;
  }
  return { ...payload, state };
}
function compareVersions(left='',right='') {
  const parse=value=>{const [core,pre='']=String(value).trim().replace(/^v/i,'').split('-',2);return{core:core.split('.').map(part=>Number(part)||0),pre}};
  const a=parse(left),b=parse(right),length=Math.max(a.core.length,b.core.length);
  for(let index=0;index<length;index++){const difference=(a.core[index]||0)-(b.core[index]||0);if(difference)return Math.sign(difference)}
  if(a.pre===b.pre)return 0;if(!a.pre)return 1;if(!b.pre)return-1;return a.pre.localeCompare(b.pre,undefined,{numeric:true,sensitivity:'base'});
}
function allowedUpdateUrl(value='') {
  try{const url=new URL(value);return url.protocol==='https:'&&['github.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`))}catch{return false}
}
async function checkForUpdates(channel='stable') {
  const selected=channel==='beta'?'beta':'stable',branch=updateBranches[selected];
  const manifestUrl=`https://raw.githubusercontent.com/${updateRepository}/${branch}/updates/latest.json?t=${Date.now()}`;
  const response=await net.fetch(manifestUrl,{headers:{Accept:'application/json','User-Agent':`Ignifire/${app.getVersion()}`}});
  if(!response.ok)throw new Error(response.status===404?'This update channel has not been published yet.':`Update server returned ${response.status}.`);
  const manifest=await response.json();
  if(!manifest||typeof manifest.version!=='string')throw new Error('The update manifest is invalid.');
  const available=compareVersions(manifest.version,app.getVersion())>0;
  return{available,channel:selected,branch,currentVersion:app.getVersion(),version:manifest.version,notes:String(manifest.notes||''),publishedAt:manifest.publishedAt||null,downloadUrl:available&&allowedUpdateUrl(manifest.downloadUrl)?manifest.downloadUrl:'',sha256:typeof manifest.sha256==='string'?manifest.sha256.toUpperCase():''};
}
async function downloadUpdate(webContents,channel='stable') {
  const update=await checkForUpdates(channel);
  if(!update.available)throw new Error('Ignifire is already up to date.');
  if(!update.downloadUrl)throw new Error('This update is announced, but its Windows download is not published yet.');
  const response=await net.fetch(update.downloadUrl,{headers:{'User-Agent':`Ignifire/${app.getVersion()}`}});
  if(!response.ok||!response.body)throw new Error(`Update download returned ${response.status}.`);
  await fs.mkdir(updatesDirectory,{recursive:true});
  const finalPath=path.join(updatesDirectory,`Ignifire-${safeFileStem(update.version)}-Setup.exe`),temporaryPath=`${finalPath}.download`;
  const handle=await fs.open(temporaryPath,'w'),reader=response.body.getReader(),hash=crypto.createHash('sha256'),total=Number(response.headers.get('content-length'))||0;let received=0;
  try{while(true){const{done,value}=await reader.read();if(done)break;const chunk=Buffer.from(value);await handle.write(chunk);hash.update(chunk);received+=chunk.length;if(!webContents.isDestroyed())webContents.send('update:progress',{stage:'downloading',received,total,percent:total?Math.round(received/total*100):null})}}catch(error){await handle.close();await fs.rm(temporaryPath,{force:true});throw error}
  await handle.close();
  const digest=hash.digest('hex').toUpperCase();
  if(update.sha256&&digest!==update.sha256){await fs.rm(temporaryPath,{force:true});throw new Error('The update failed its integrity check and was discarded.');}
  await fs.rm(finalPath,{force:true});await fs.rename(temporaryPath,finalPath);
  if(!webContents.isDestroyed())webContents.send('update:progress',{stage:'installing',received,total,percent:100});
  preparedUpdate={...update,fileName:path.basename(finalPath),filePath:finalPath,sha256:digest,installed:true,preparedAt:Date.now()};
  if(!webContents.isDestroyed())webContents.send('update:ready',preparedUpdate);
  return preparedUpdate;
}
function safeFileStem(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'album';
}
async function downloadDynamicFont(font) {
  const filePath = path.join(fontDirectory, `${font.id}.woff2`);
  try {
    const existing = await fs.stat(filePath);
    if (existing.size > 1000) return { ...font, fileUrl: pathToFileURL(filePath).href };
  } catch { /* Download a missing font below. */ }
  const family = encodeURIComponent(font.family).replace(/%20/g, '+');
  const cssResponse = await net.fetch(`https://fonts.googleapis.com/css2?family=${family}&display=swap`, {
    headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36' }
  });
  if (!cssResponse.ok) throw new Error(`Font catalog returned ${cssResponse.status}`);
  const css = await cssResponse.text();
  const fontUrl = [...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].at(-1)?.[1];
  if (!fontUrl) throw new Error(`No WOFF2 asset found for ${font.family}`);
  const fontResponse = await net.fetch(fontUrl);
  if (!fontResponse.ok) throw new Error(`Font asset returned ${fontResponse.status}`);
  const buffer = Buffer.from(await fontResponse.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`Font asset was incomplete for ${font.family}`);
  await writeBufferAtomic(filePath, buffer);
  return { ...font, fileUrl: pathToFileURL(filePath).href };
}
async function ensureDynamicFontLibrary() {
  await fs.mkdir(fontDirectory, { recursive: true });
  const prior = await readJson(fontManifestPath, null);
  if (prior?.fonts?.length >= 20) {
    const verified = [];
    for (const font of prior.fonts) {
      try { if ((await fs.stat(fileURLToPath(font.fileUrl))).size > 1000) verified.push(font); } catch { /* Repair below. */ }
    }
    if (verified.length >= 20) return { ...prior, fonts: verified };
  }
  const results = await Promise.allSettled(dynamicFontCatalog.map(downloadDynamicFont));
  const fonts = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (fonts.length < 20) throw new Error(`Only ${fonts.length} of 24 typefaces could be downloaded. Check your connection and try again.`);
  const manifest = { version: 1, source: 'Google Fonts', downloadedAt: new Date().toISOString(), fonts };
  await writeJsonAtomic(fontManifestPath, manifest);
  return manifest;
}
async function imageSourceAsDataUrl(source) {
  if (typeof source !== 'string' || !source) throw new Error('Add front cover artwork before enabling Dynamic Case Art.');
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(source)) {
    if (Buffer.byteLength(source, 'utf8') > 28 * 1024 * 1024) throw new Error('The front cover is too large. Use an image under 20 MB.');
    return source;
  }
  let buffer, mime = 'image/png';
  if (source.startsWith('file:')) {
    const filePath = fileURLToPath(source);
    buffer = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png';
  } else if (/^https?:\/\//i.test(source)) {
    const response = await net.fetch(source);
    if (!response.ok) throw new Error('The front cover could not be downloaded.');
    buffer = Buffer.from(await response.arrayBuffer());
    mime = response.headers.get('content-type')?.split(';')[0] || mime;
  } else throw new Error('The front cover format is not supported.');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('The front cover is too large. Use an image under 20 MB.');
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
async function generateDynamicCaseArt(options = {}) {
  const savedCredentials = await readJson(credentialsPath, {});
  const apiKey = decryptSecret(savedCredentials.openaiKey);
  if (!apiKey) throw new Error('Connect an OpenAI API key in Settings before enabling Dynamic Case Art.');
  const imageUrl = await imageSourceAsDataUrl(options.frontCover);
  const imageMatch = imageUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i);
  if (!imageMatch) throw new Error('The front cover could not be prepared for image generation.');
  const prompt = `Create professional print-ready back and spine artwork for the album "${String(options.title || '').slice(0, 180)}" by "${String(options.artist || '').slice(0, 180)}". Use the supplied front cover only as the visual reference. Extend its palette, texture, lighting, illustration language, and era into a landscape back-cover composition. Keep a calm, readable negative-space region across the center-left for a tracklist that Ignifire will overlay later. Reserve exactly the far-right 8.33% of the canvas (128 pixels of the 1536-pixel width) as a coordinated vertical spine strip, separated cleanly from the back panel and filled edge-to-edge with continuous artwork. ABSOLUTELY NO text, letters, numbers, logos, track names, barcodes, legal copy, or typography anywhere in the generated image. Do not place a CD, jewel case mockup, hands, room, or product photography in the scene. Output only the flat artwork. Genre context: ${String(options.genre || 'unspecified').slice(0, 100)}.`;
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', new Blob([Buffer.from(imageMatch[2], 'base64')], { type: imageMatch[1] }), `front-cover.${imageMatch[1].includes('jpeg') ? 'jpg' : imageMatch[1].split('/')[1]}`);
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', 'medium');
  form.append('output_format', 'png');
  form.append('background', 'opaque');
  form.append('n', '1');
  const response = await net.fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseBody?.error?.message || `OpenAI image generation failed (${response.status}).`);
  const encoded = responseBody?.data?.[0]?.b64_json;
  if (!encoded) throw new Error('OpenAI returned no case artwork.');
  const filePath = path.join(dynamicArtDirectory, `${safeFileStem(options.albumId || options.title)}.png`);
  await writeBufferAtomic(filePath, Buffer.from(encoded, 'base64'));
  return { backgroundUrl: pathToFileURL(filePath).href, generatedAt: new Date().toISOString(), model: 'gpt-image-2' };
}
async function cacheArtistImage(options = {}) {
  const source = new URL(options.url || '');
  const host = source.hostname.toLowerCase();
  const allowed = host === 'wikimedia.org' || host.endsWith('.wikimedia.org') || host === 'cdn-images.dzcdn.net' || host === 'r2.theaudiodb.com' || host === 'theaudiodb.com' || host.endsWith('.theaudiodb.com') || /^media\d*\.giphy\.com$/.test(host) || host === 'i.giphy.com' || host === 'media.tenor.com';
  if (source.protocol !== 'https:' || !allowed) throw new Error('This artist-image source is not trusted by Ignifire.');
  const response = await net.fetch(source.href);
  if (!response.ok) throw new Error(`Artist image download failed (${response.status}).`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || '';
  if (!['image/jpeg','image/png','image/webp','image/gif'].includes(contentType)) throw new Error('The selected result is not a supported image.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw new Error('Artist images and GIFs must be smaller than 30 MB.');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : contentType === 'image/gif' ? 'gif' : 'jpg';
  const filePath = path.join(artistArtDirectory, `${safeFileStem(options.artist)}.${extension}`);
  await writeBufferAtomic(filePath, buffer);
  return { imageUrl: pathToFileURL(filePath).href, cachedAt: new Date().toISOString(), animated:contentType==='image/gif' };
}
async function fetchArtistJson(url) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await net.fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': `Ignifire/${app.getVersion()}` } });
    if (!response.ok) throw new Error(`Artist source returned ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
function normalizedArtistName(value = '') { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase(); }
async function searchWikimediaAnimatedArtistImages(artist=''){
  const queries=[`"${artist}" gif`,`"${artist}" animated`,`"${artist}" concert`],searches=await Promise.allSettled(queries.map(async query=>{const params=new URLSearchParams({action:'query',generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:'24',prop:'imageinfo',iiprop:'url|mime|size|extmetadata',format:'json',origin:'*'});return fetchArtistJson(`https://commons.wikimedia.org/w/api.php?${params}`)}));
  const pages=searches.flatMap(result=>result.status==='fulfilled'?Object.values(result.value?.query?.pages||{}):[]),seen=new Set();
  return pages.map(page=>{const info=page.imageinfo?.[0];if(info?.mime!=='image/gif'||!info.url||seen.has(info.url))return null;seen.add(info.url);const metadata=info.extmetadata||{},clean=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();return{image:info.url,sourceUrl:info.descriptionurl||`https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ','_'))}`,sourceLabel:'Wikimedia GIF',label:clean(metadata.ObjectName?.value)||page.title.replace(/^File:/,''),description:clean(metadata.ImageDescription?.value)||`Animated artist image for ${artist}`,animated:true,width:info.width||null,height:info.height||null}}).filter(Boolean).slice(0,10);
}
async function fetchArtistPage(url){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);try{const response=await net.fetch(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36','Accept-Language':'en-US,en;q=0.9'}});if(!response.ok)throw new Error(`Animated image source returned ${response.status}.`);return response.text()}finally{clearTimeout(timeout)}}
let giphyFrontendApiKey='',giphyKeyRefreshPromise=null;
async function refreshGiphyFrontendApiKey(){
  if(giphyKeyRefreshPromise)return giphyKeyRefreshPromise;
  giphyKeyRefreshPromise=(async()=>{const html=await fetchArtistPage('https://giphy.com/search/music'),scripts=[...html.matchAll(/<script[^>]+src="([^"]*\/app\/layout-[^"]+\.js)"/gi)].map(match=>new URL(match[1],'https://giphy.com').href);for(const script of scripts){const source=await fetchArtistPage(script),match=source.match(/apiKey:"([A-Za-z0-9]+)"/);if(match?.[1])return(giphyFrontendApiKey=match[1])}throw new Error('GIPHY search credentials could not be refreshed.')})().finally(()=>{giphyKeyRefreshPromise=null});
  return giphyKeyRefreshPromise;
}
async function fetchGiphySearch(query,retry=true){
  if(!giphyFrontendApiKey)await refreshGiphyFrontendApiKey();
  const url=new URL('https://api.giphy.com/v1/gifs/search');url.search=new URLSearchParams({api_key:giphyFrontendApiKey,q:query,limit:'25',offset:'0',rating:'pg-13',lang:'en',bundle:'messaging_non_clips'});
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{const response=await net.fetch(url.href,{signal:controller.signal,headers:{Accept:'application/json','User-Agent':`Ignifire/${app.getVersion()}`}});if((response.status===401||response.status===403)&&retry){await refreshGiphyFrontendApiKey();return fetchGiphySearch(query,false)}if(!response.ok)throw new Error(`GIPHY search returned ${response.status}.`);const body=await response.json();return Array.isArray(body?.data)?body.data:[]}
  finally{clearTimeout(timeout)}
}
async function searchGiphyArtistImages(artist=''){
  const variants=[{query:artist,label:`${artist}`,description:'Exact artist search'},{query:`${artist} Singer`,label:`${artist} Singer`,description:'Singer search'},{query:`${artist} Band`,label:`${artist} Band`,description:'Band search'}],searches=await Promise.allSettled(variants.map(variant=>fetchGiphySearch(variant.query))),seen=new Set(),results=[];
  searches.forEach((search,index)=>{if(search.status!=='fulfilled')return;let added=0;for(const item of search.value){const id=String(item?.id||''),image=item?.images?.fixed_width?.url||item?.images?.downsized_medium?.url||item?.images?.original?.url;if(!id||!image||seen.has(id))continue;seen.add(id);const variant=variants[index];results.push({image,sourceUrl:item.url||`https://giphy.com/gifs/${id}`,sourceLabel:'GIPHY',label:String(item.title||variant.label).trim()||variant.label,description:`${variant.description} · “${variant.query}”`,query:variant.query,animated:true,width:Number(item?.images?.fixed_width?.width)||null,height:Number(item?.images?.fixed_width?.height)||null});added++;if(added>=8)break}});
  return results;
}
async function searchTenorArtistImages(artist=''){
  const slug=String(artist).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||encodeURIComponent(artist),sourceUrl=`https://tenor.com/search/${slug}-gifs`,html=(await fetchArtistPage(sourceUrl)).replace(/\\u002[fF]/g,'/').replace(/&amp;/g,'&'),seen=new Set(),results=[];
  for(const match of html.matchAll(/https:\/\/media\.tenor\.com\/([A-Za-z0-9_-]+)\/[^"'\\\s<>]*?\.gif/gi)){const id=match[1],image=match[0].replace(/\\/g,'');if(seen.has(id))continue;seen.add(id);results.push({image,sourceUrl,sourceLabel:'Tenor',label:`${artist} animation`,description:'Animated search result',animated:true});if(results.length>=10)break}
  return results;
}
async function searchSupplementalArtistImages(artist = '', options = {}) {
  artist = String(artist).trim().slice(0, 160);
  if (!artist) return [];
  const wanted = normalizedArtistName(artist);
  const animatedSources=options.animatedOnly?[searchGiphyArtistImages(artist),searchWikimediaAnimatedArtistImages(artist),searchTenorArtistImages(artist)]:[searchWikimediaAnimatedArtistImages(artist),searchGiphyArtistImages(artist),searchTenorArtistImages(artist)];
  const staticSources=options.animatedOnly?[]:[
    fetchArtistJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artist)}&limit=8`).then(body => {
      const ranked = (body?.data || []).map(item => ({ item, match: normalizedArtistName(item.name) === wanted ? 3 : normalizedArtistName(item.name).startsWith(wanted) ? 2 : normalizedArtistName(item.name).includes(wanted) ? 1 : 0 })).filter(entry => entry.match && entry.item.picture_xl && !/\/artist\/\/\d+x\d+/.test(entry.item.picture_xl)).sort((left, right) => right.match - left.match);
      return ranked.slice(0, 3).map(({ item }) => ({ image: item.picture_xl || item.picture_big, sourceUrl: item.link || `https://www.deezer.com/artist/${item.id}`, sourceLabel: 'Deezer', label: item.name || artist, description: 'Official music-service artist portrait' }));
    }),
    fetchArtistJson(`https://www.theaudiodb.com/api/v1/json/123/search.php?s=${encodeURIComponent(artist)}`).then(body => {
      const matches = (body?.artists || []).filter(item => normalizedArtistName(item.strArtist) === wanted).slice(0, 2), results = [];
      for (const item of matches) {
        const sourceUrl = `https://www.theaudiodb.com/artist/${item.idArtist}`;
        if (item.strArtistThumb) results.push({ image: item.strArtistThumb, sourceUrl, sourceLabel: 'TheAudioDB', label: item.strArtist || artist, description: 'Artist portrait' });
        if (item.strArtistFanart) results.push({ image: item.strArtistFanart, sourceUrl, sourceLabel: 'TheAudioDB', label: item.strArtist || artist, description: 'Artist fan artwork' });
        if (item.strArtistWideThumb) results.push({ image: item.strArtistWideThumb, sourceUrl, sourceLabel: 'TheAudioDB', label: item.strArtist || artist, description: 'Wide artist photograph' });
      }
      return results.slice(0, 6);
    })
  ];
  const sources = await Promise.allSettled([...staticSources,...animatedSources]);
  return sources.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}
function youtubeText(value={}){return String(value?.simpleText||value?.runs?.map(run=>run?.text||'').join('')||'').trim()}
function extractAssignedJson(source='',variable='ytInitialData'){
  const match=new RegExp(`(?:var\\s+)?${variable}\\s*=\\s*`).exec(source);if(!match)return null;
  const start=source.indexOf('{',match.index+match[0].length);if(start<0)return null;
  let depth=0,inString=false,escaped=false;
  for(let index=start;index<source.length;index++){
    const character=source[index];
    if(inString){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')inString=false;continue}
    if(character==='"'){inString=true;continue}if(character==='{')depth++;else if(character==='}'&&--depth===0){try{return JSON.parse(source.slice(start,index+1))}catch{return null}}
  }
  return null;
}
function youtubeVideoResults(initialData){
  const results=[];
  const visit=(value,depth=0)=>{if(!value||depth>35)return;if(Array.isArray(value)){value.forEach(item=>visit(item,depth+1));return}if(typeof value!=='object')return;
    const item=value.videoRenderer;
    if(item?.videoId&&/^[A-Za-z0-9_-]{11}$/.test(item.videoId)){
      const badgeText=[...(item.ownerBadges||[]),...(item.badges||[])].map(badge=>badge?.metadataBadgeRenderer?.tooltip||badge?.metadataBadgeRenderer?.label||'').filter(Boolean),overlays=(item.thumbnailOverlays||[]).map(overlay=>youtubeText(overlay?.thumbnailOverlayTimeStatusRenderer?.text)).filter(Boolean);
      results.push({videoId:item.videoId,title:youtubeText(item.title),channel:youtubeText(item.ownerText)||youtubeText(item.longBylineText)||youtubeText(item.shortBylineText),duration:youtubeText(item.lengthText)||overlays[0]||'',published:youtubeText(item.publishedTimeText),views:youtubeText(item.viewCountText),badges:badgeText,thumbnail:item.thumbnail?.thumbnails?.at(-1)?.url||'',sourceUrl:`https://www.youtube.com/watch?v=${item.videoId}`});return
    }
    Object.values(value).forEach(child=>visit(child,depth+1));
  };visit(initialData);return results;
}
function cleanVideoSearchTerm(value=''){return String(value).replace(/\s*[\[(](?:\d{4}\s+)?(?:re-?master(?:ed)?|deluxe|expanded|anniversary|explicit|clean|stereo|mono|radio edit|album version)[^\])]*[\])]/gi,' ').replace(/\s+/g,' ').trim()}
async function fetchYouTubeSearch(query=''){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const url=`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`,response=await net.fetch(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36','Accept-Language':'en-US,en;q=0.9'}});
    if(!response.ok)throw new Error(`YouTube search returned ${response.status}.`);const html=await response.text(),initialData=extractAssignedJson(html);if(!initialData)throw new Error('YouTube search results could not be read.');return youtubeVideoResults(initialData);
  }finally{clearTimeout(timeout)}
}
async function searchYouTubeMusicVideos(options={}){
  const title=String(options.title||'').trim().slice(0,220),artist=String(options.artist||'').trim().slice(0,180);if(!title||!artist)return[];
  const cleanTitle=cleanVideoSearchTerm(title),leadArtist=artist.split(/\s+(?:feat(?:uring)?|ft\.?|with)\s+/i)[0].trim()||artist;
  const queries=[`${artist} ${title} official music video`,`${leadArtist} ${cleanTitle} official video`,`${artist} ${cleanTitle} music video`].filter((query,index,array)=>query.trim()&&array.indexOf(query)===index);
  const searches=await Promise.allSettled(queries.map(fetchYouTubeSearch));if(searches.every(result=>result.status==='rejected'))throw new Error(searches[0].reason?.message||'YouTube search is unavailable.');
  const seen=new Set(),results=[];searches.forEach((search,queryIndex)=>{if(search.status!=='fulfilled')return;search.value.forEach((video,resultIndex)=>{if(seen.has(video.videoId))return;seen.add(video.videoId);results.push({...video,query:queries[queryIndex],queryIndex,resultIndex})})});return results.slice(0,45);
}
async function apiPassRequest(resource, options = {}) {
  const savedCredentials = await readJson(credentialsPath, {});
  const apiKey = decryptSecret(savedCredentials.sunoToken);
  if (!apiKey) throw new Error('Connect an ApiPass API key before using Suno Studio.');
  const response = await net.fetch(`${apiPassBaseUrl}${resource}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403 || body?.code === 401 || body?.code === 403) throw new Error('ApiPass rejected this API key. Check the key and try again.');
  if (!response.ok) throw new Error(body?.message || body?.msg || `ApiPass returned ${response.status}.`);
  return body;
}
async function testSunoConnection() {
  const savedCredentials = await readJson(credentialsPath, {});
  const apiKey = decryptSecret(savedCredentials.sunoToken);
  if (!apiKey) throw new Error('Enter an ApiPass API key.');
  const response = await net.fetch(`${apiPassBaseUrl}/api/v1/jobs/recordInfo?taskId=ignifire_connection_check`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403 || body?.code === 401 || body?.code === 403) throw new Error('ApiPass rejected this API key. Check the key and try again.');
  if (response.status >= 500) throw new Error('ApiPass is temporarily unavailable. Try again shortly.');
  return { connected: true, provider: 'ApiPass', baseUrl: apiPassBaseUrl };
}
function boundedNumber(value, fallback = 0.5) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, Math.round(number * 100) / 100)) : fallback;
}
async function createSunoTask(options = {}) {
  const customMode = Boolean(options.customMode), instrumental = Boolean(options.instrumental);
  const modelVersion = ['V5_5','V5','V4_5PLUS','V4_5ALL','V4_5','V4'].includes(options.modelVersion) ? options.modelVersion : 'V5_5';
  const channel = ['auto','starter','regular','official'].includes(options.channel) ? options.channel : 'auto';
  let prompt = String(options.prompt || '').trim(), title = String(options.title || '').trim(), style = String(options.style || '').trim();
  if (!customMode) {
    if (!prompt) throw new Error('Describe the song you want to generate.');
    prompt = prompt.slice(0, 500); title = ''; style = '';
  } else {
    if (!title || !style) throw new Error('Custom mode requires a title and style.');
    if (!instrumental && !prompt) throw new Error('Custom vocal mode requires lyrics or a lyric prompt.');
    if (instrumental) prompt = '';
    prompt = prompt.slice(0, modelVersion === 'V4' ? 3000 : 5000);
    title = title.slice(0, 80); style = style.slice(0, modelVersion === 'V4' ? 200 : 1000);
  }
  const input = { model_version: modelVersion, prompt, title, style, customMode, instrumental };
  if (customMode) {
    if (['m','f'].includes(options.vocalGender) && !instrumental) input.vocalGender = options.vocalGender;
    const negativeTags = String(options.negativeTags || '').trim();
    if (negativeTags) input.negativeTags = negativeTags.slice(0, 1000);
    input.styleWeight = boundedNumber(options.styleWeight, 0.5);
    input.weirdnessConstraint = boundedNumber(options.weirdnessConstraint, 0.3);
    input.audioWeight = boundedNumber(options.audioWeight, 0.5);
  }
  const body = await apiPassRequest('/api/v1/jobs/createTask', { method: 'POST', body: JSON.stringify({ model: 'suno/generate', input, channel }) });
  if (Number(body?.code) !== 200) throw new Error(body?.message || body?.msg || 'ApiPass could not create this generation task.');
  const taskId = body?.data?.taskId || body?.taskId;
  if (!taskId) throw new Error('ApiPass returned no task ID.');
  return { taskId: String(taskId), state: 'queuing', model: 'suno/generate', input, channel, createdAt: new Date().toISOString() };
}
function normalizedSunoResults(resultJson) {
  if (typeof resultJson === 'string') { try { resultJson = JSON.parse(resultJson); } catch { resultJson = {}; } }
  const items = Array.isArray(resultJson?.data) ? resultJson.data : Array.isArray(resultJson) ? resultJson : [];
  return items.map((item, index) => ({
    id: String(item.id || item.audio_id || `variant-${index + 1}`),
    audioUrl: String(item.audio_url || item.audioUrl || item.stream_audio_url || ''),
    imageUrl: String(item.image_url || item.imageUrl || item.cover_url || ''),
    videoUrl: String(item.video_url || item.videoUrl || ''),
    duration: Number(item.duration) || null,
    title: String(item.title || ''),
    style: String(item.style || item.tags || ''),
    status: String(item.status || 'complete')
  })).filter(item => item.audioUrl);
}
async function querySunoTask(taskId = '') {
  taskId = String(taskId).trim();
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(taskId)) throw new Error('The ApiPass task ID is invalid.');
  const body = await apiPassRequest(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  if (Number(body?.code) !== 200) throw new Error(body?.message || body?.msg || 'ApiPass could not find this generation task.');
  const data = body?.data || {}, state = String(data.state || body.status || 'queuing').toLowerCase();
  const completedDate = data.completeTime ? new Date(Number(data.completeTime)) : null;
  return {
    taskId,
    state,
    failCode: String(data.failCode || ''),
    failMsg: String(data.failMsg || body?.message || body?.msg || ''),
    completedAt: completedDate && !Number.isNaN(completedDate.getTime()) ? completedDate.toISOString() : null,
    results: state === 'success' ? normalizedSunoResults(data.resultJson) : []
  };
}
function safeSunoAssetUrl(value = '') {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('ApiPass returned an unsafe asset URL.');
  return url.href;
}
async function downloadSunoAsset(source, filePath, maximumBytes) {
  const response = await net.fetch(safeSunoAssetUrl(source));
  if (!response.ok) throw new Error(`Generated asset download returned ${response.status}.`);
  const announced = Number(response.headers.get('content-length')) || 0;
  if (announced > maximumBytes) throw new Error('The generated asset is too large to import.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maximumBytes) throw new Error('The generated asset is empty or too large to import.');
  await writeBufferAtomic(filePath, buffer);
  return pathToFileURL(filePath).href;
}
async function importSunoTrack(options = {}) {
  const taskStem = safeFileStem(options.taskId || 'generation'), resultStem = safeFileStem(options.resultId || options.title || 'track');
  const folder = path.join(sunoDirectory, taskStem);
  const audioPath = path.join(folder, `${resultStem}.mp3`);
  const audioUrl = await downloadSunoAsset(options.audioUrl, audioPath, 150 * 1024 * 1024);
  let imageUrl = '';
  if (options.imageUrl) {
    try { imageUrl = await downloadSunoAsset(options.imageUrl, path.join(folder, `${resultStem}.jpg`), 20 * 1024 * 1024); }
    catch { imageUrl = ''; }
  }
  return { audioUrl, audioPath, imageUrl, importedAt: new Date().toISOString() };
}
async function lookupLyrics(options = {}) {
  const title = String(options.title || '').trim();
  const artist = String(options.artist || '').trim();
  const album = String(options.album || '').trim();
  const duration = Math.max(0, Math.round(Number(options.duration) || 0));
  if (!title || !artist) throw new Error('A song title and artist are required to find lyrics.');
  const headers = { Accept: 'application/json', 'User-Agent': `Ignifire/${app.getVersion()} (https://github.com/FennXWeb/firefly-music-player)` };
  const exact = new URL('https://lrclib.net/api/get');
  exact.searchParams.set('track_name', title);
  exact.searchParams.set('artist_name', artist);
  if (album) exact.searchParams.set('album_name', album);
  if (duration) exact.searchParams.set('duration', String(duration));
  let record = null;
  try {
    const response = await net.fetch(exact.href, { headers, signal: AbortSignal.timeout(12000) });
    if (response.ok) record = await response.json();
    else if (response.status !== 404) throw new Error(`Lyrics service returned ${response.status}.`);
  } catch (error) {
    if (!/404/.test(error?.message || '')) console.warn('Exact lyrics lookup failed', error);
  }
  if (!record?.plainLyrics && !record?.syncedLyrics) {
    const search = new URL('https://lrclib.net/api/search');
    search.searchParams.set('track_name', title);
    search.searchParams.set('artist_name', artist);
    if (album) search.searchParams.set('album_name', album);
    const response = await net.fetch(search.href, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Lyrics search returned ${response.status}.`);
    const records = await response.json();
    const normalized = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const targetTitle = normalized(title), targetArtist = normalized(artist), targetAlbum = normalized(album);
    record = (Array.isArray(records) ? records : []).sort((left, right) => {
      const score = item => Number(normalized(item.trackName) === targetTitle) * 100 + Number(normalized(item.artistName) === targetArtist) * 80 + Number(targetAlbum && normalized(item.albumName) === targetAlbum) * 30 + Number(Boolean(item.syncedLyrics)) * 12 - (duration && item.duration ? Math.min(25, Math.abs(Number(item.duration) - duration)) : 0);
      return score(right) - score(left);
    })[0] || null;
  }
  if (!record?.plainLyrics && !record?.syncedLyrics) return null;
  return {
    plain: String(record.plainLyrics || '').trim(),
    synced: String(record.syncedLyrics || '').trim(),
    instrumental: Boolean(record.instrumental),
    source: 'LRCLIB',
    sourceId: record.id || null,
    fetchedAt: Date.now()
  };
}
function encryptSecret(value = '') {
  if (!value) return '';
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value).toString('base64')
    : Buffer.from(value, 'utf8').toString('base64');
}
function decryptSecret(value = '') {
  if (!value) return '';
  try {
    const buffer = Buffer.from(value, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString('utf8');
  } catch { return ''; }
}
async function entryFor(filePath, root = '') {
  const extension = path.extname(filePath).toLowerCase();
  const entry = {
    name: path.basename(filePath),
    path: filePath,
    url: pathToFileURL(filePath).href,
    relativePath: root ? path.relative(root, filePath).replaceAll('\\','/') : path.basename(filePath),
    kind: audioExtensions.has(extension) ? 'audio' : 'image'
  };
  if (entry.kind === 'audio') {
    try {
      metadataModule ||= import('music-metadata');
      const { parseFile } = await metadataModule;
      const parsed = await parseFile(filePath, { duration: true, skipPostHeaders: true });
      const common = parsed.common || {}, picture = common.picture?.[0];
      const embeddedLyrics = common.lyrics?.find(item => item?.syncText?.length) || common.lyrics?.find(item => item?.text) || null;
      entry.metadata = {
        title: common.title || '',
        artist: common.artist || common.albumartist || '',
        albumArtist: common.albumartist || common.artist || '',
        album: common.album || '',
        year: common.year || null,
        genre: common.genre?.[0] || '',
        track: common.track?.no || null,
        disc: common.disk?.no || null,
        duration: parsed.format?.duration || null,
        artwork: picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : null,
        lyrics: embeddedLyrics ? {
          plain: String(embeddedLyrics.text || embeddedLyrics.syncText?.map(line => line.text).join('\n') || '').trim(),
          syncedLines: (embeddedLyrics.syncText || []).filter(line => Number.isFinite(Number(line.timestamp))).map(line => ({ time: Number(line.timestamp) / 1000, text: String(line.text || '') })),
          source: 'Embedded metadata',
          fetchedAt: Date.now()
        } : null
      };
    } catch (error) {
      entry.metadata = null;
      entry.metadataError = String(error?.code || error?.message || 'Metadata unavailable').slice(0, 180);
    }
  }
  return entry;
}

async function scanFolder(root, options = {}) {
  const results = [];
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) await walk(fullPath);
      else if (audioExtensions.has(path.extname(item.name).toLowerCase()) || imageExtensions.has(path.extname(item.name).toLowerCase())) {
        if (!options.live) { results.push(await entryFor(fullPath, root));continue; }
        const stats=await fs.stat(fullPath),cacheKey=path.normalize(fullPath).toLowerCase(),cached=liveEntryCache.get(cacheKey),retryFailedMetadata=cached?.entry?.kind==='audio'&&cached.entry.metadataError&&Date.now()-(cached.checkedAt||0)>5*60*1000;
        let entry;
        if(cached&&cached.modifiedAt===stats.mtimeMs&&cached.size===stats.size&&!retryFailedMetadata)entry={...cached.entry};
        else{entry=await entryFor(fullPath,root);entry.modifiedAt=stats.mtimeMs;entry.size=stats.size;liveEntryCache.set(cacheKey,{modifiedAt:stats.mtimeMs,size:stats.size,checkedAt:Date.now(),entry})}
        results.push(entry);
      }
    }
  }
  await walk(root);
  return results;
}

function liveFolderId(root=''){return`live-${crypto.createHash('sha1').update(path.normalize(root).toLowerCase()).digest('hex').slice(0,16)}`}
function normalizedLiveFolder(folder={}){
  const root=path.resolve(String(folder.path||folder.root||''));
  return{id:String(folder.id||liveFolderId(root)),path:root,name:String(folder.name||path.basename(root)||'Live folder'),kind:'live',addedAt:Number(folder.addedAt)||Date.now()};
}
async function liveFolderSnapshot(folder={}){
  const normalized=normalizedLiveFolder(folder),scannedAt=Date.now();
  try{
    const stats=await fs.stat(normalized.path);if(!stats.isDirectory())throw new Error('The saved path is not a folder.');
    const entries=await scanFolder(normalized.path,{live:true});
    entries.forEach(entry=>{entry.liveFolderId=normalized.id;entry.liveTrackId=`live-track-${crypto.createHash('sha1').update(`${normalized.id}\0${String(entry.relativePath||entry.name).toLowerCase()}`).digest('hex').slice(0,20)}`});
    const audioEntries=entries.filter(entry=>entry.kind==='audio');
    return{ok:true,folder:{...normalized,status:'synced',lastSyncedAt:scannedAt,trackCount:audioEntries.length,metadataPending:audioEntries.filter(entry=>entry.metadataError).length},entries,scannedAt};
  }catch(error){return{ok:false,folder:{...normalized,status:'offline',lastCheckedAt:scannedAt},entries:[],scannedAt,error:error?.message||'The folder could not be scanned.'}}
}
function closeLiveFolderWatcher(id){
  const record=liveFolderWatchers.get(id);if(!record)return;
  clearTimeout(record.debounceTimer);clearInterval(record.pollTimer);try{record.watcher?.close()}catch{/* Already closed. */}liveFolderWatchers.delete(id);
}
function attachLiveFolderWatcher(record){
  if(record.watcher)return;
  try{
    record.watcher=fsNative.watch(record.folder.path,{recursive:true},(_event,fileName)=>{
      if(fileName){const extension=path.extname(String(fileName)).toLowerCase();if(extension&&!audioExtensions.has(extension)&&!imageExtensions.has(extension))return}
      scheduleLiveFolderScan(record);
    });
    record.watcher.on('error',()=>{try{record.watcher?.close()}catch{/* Watcher already failed. */}record.watcher=null;scheduleLiveFolderScan(record,800)});
    record.watcher.unref?.();
  }catch{record.watcher=null}
}
function scheduleLiveFolderScan(record,delay=1200){
  clearTimeout(record.debounceTimer);record.debounceTimer=setTimeout(async()=>{
    if(record.scanning){record.rescanQueued=true;return}record.scanning=true;
    try{const snapshot=await liveFolderSnapshot(record.folder);if(snapshot.ok)attachLiveFolderWatcher(record);if(!record.webContents.isDestroyed())record.webContents.send('library:live-folder-snapshot',snapshot)}
    finally{record.scanning=false;if(record.rescanQueued){record.rescanQueued=false;scheduleLiveFolderScan(record,250)}}
  },delay);record.debounceTimer.unref?.();
}
function registerLiveFolder(folder,webContents){
  const normalized=normalizedLiveFolder(folder),existing=liveFolderWatchers.get(normalized.id);
  if(existing&&existing.folder.path===normalized.path){existing.folder=normalized;existing.webContents=webContents;attachLiveFolderWatcher(existing);return existing}
  if(existing)closeLiveFolderWatcher(normalized.id);
  const record={folder:normalized,webContents,watcher:null,debounceTimer:null,pollTimer:null,scanning:false,rescanQueued:false};
  liveFolderWatchers.set(normalized.id,record);attachLiveFolderWatcher(record);
  record.pollTimer=setInterval(()=>scheduleLiveFolderScan(record,50),60000);record.pollTimer.unref?.();return record;
}
async function syncLiveFolders(folders=[],webContents){
  const normalized=(Array.isArray(folders)?folders:[]).filter(folder=>folder?.path||folder?.root).map(normalizedLiveFolder),activeIds=new Set(normalized.map(folder=>folder.id));
  for(const id of liveFolderWatchers.keys())if(!activeIds.has(id))closeLiveFolderWatcher(id);
  normalized.forEach(folder=>registerLiveFolder(folder,webContents));
  return Promise.all(normalized.map(liveFolderSnapshot));
}

async function importZipArchive(archivePath) {
  const archive=new AdmZip(archivePath),entries=archive.getEntries();
  const usable=entries.filter(entry=>!entry.isDirectory&&(audioExtensions.has(path.extname(entry.entryName).toLowerCase())||imageExtensions.has(path.extname(entry.entryName).toLowerCase())));
  if(!usable.length)throw new Error('This ZIP does not contain supported music files.');
  if(usable.some(entry=>(Number(entry.header?.size)||0)>2*1024*1024*1024))throw new Error('A file inside this ZIP exceeds Ignifire’s 2 GB per-file import limit.');
  const totalBytes=usable.reduce((sum,entry)=>sum+(Number(entry.header?.size)||0),0);
  if(totalBytes>8*1024*1024*1024)throw new Error('This ZIP expands beyond Ignifire’s 8 GB import limit.');
  const archiveName=path.basename(archivePath,path.extname(archivePath));
  const safeName=archiveName.replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,70)||'music';
  const root=path.join(zipImportDirectory,`${safeName}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(root,{recursive:true});
  for(const entry of usable){
    const normalized=path.posix.normalize(String(entry.entryName).replaceAll('\\','/')).replace(/^\/+/, '');
    if(!normalized||normalized==='.'||normalized.startsWith('../')||normalized.includes('/../'))continue;
    const destination=path.resolve(root,...normalized.split('/'));
    if(destination!==root&&!destination.startsWith(`${path.resolve(root)}${path.sep}`))continue;
    await writeBufferAtomic(destination,entry.getData());
  }
  const imported=await scanFolder(root);
  if(!imported.some(entry=>entry.kind==='audio'))throw new Error('No supported music could be extracted from this ZIP.');
  return {root,name:archiveName,entries:imported,source:'zip',archiveName:path.basename(archivePath)};
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, 'assets', 'ignifire.ico'),
    backgroundColor: '#090909',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09090900', symbolColor: '#8f8b86', height: 42 },
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
  });
  primaryWindow = win;
  updateTaskbarControls(win);
  win.on('closed', () => { if (primaryWindow === win) primaryWindow = null; });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
    try {
      const host = new URL(params.src).hostname.replace(/^www\./, '').toLowerCase();
      if (!['youtube.com','player.vimeo.com','dailymotion.com'].some(allowed => host === allowed || host.endsWith(`.${allowed}`))) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  });
  win.loadFile('index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Retain the original Windows identity so the Ignifire installer upgrades
  // the existing application instead of creating a second installation.
  if (process.platform === 'win32') app.setAppUserModelId('com.firefly.music');
  registerMediaHotkeys();
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/embed/*'] },
    (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://ignifire.local/' } })
  );
  ipcMain.handle('state:load', async () => ({
    state: await readJson(statePath, null),
    dataDirectory
  }));
  ipcMain.handle('state:save', async (_event, state) => {
    await writeJsonAtomic(statePath, { ...state, schemaVersion: 3, savedAt: new Date().toISOString() });
    scheduleCloudBackup(state);
    return true;
  });
  ipcMain.handle('credentials:load', async () => {
    const saved = await readJson(credentialsPath, {});
    return {
      openaiKey: decryptSecret(saved.openaiKey),
      sunoToken: decryptSecret(saved.sunoToken)
    };
  });
  ipcMain.handle('credentials:save', async (_event, credentials) => {
    const saved = await readJson(credentialsPath, {});
    await writeJsonAtomic(credentialsPath, { ...saved, openaiKey: encryptSecret(credentials?.openaiKey), sunoToken: encryptSecret(credentials?.sunoToken) });
    return true;
  });
  ipcMain.handle('state:open-directory', async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    return shell.openPath(dataDirectory);
  });
  ipcMain.on('media:playback-state', (event, state = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    nativePlaybackState = {
      playing: Boolean(state.playing),
      hasTrack: Boolean(state.hasTrack),
      title: String(state.title || '').slice(0, 180),
      artist: String(state.artist || '').slice(0, 180),
      album: String(state.album || '').slice(0, 180),
      durationSeconds: Math.max(0, Number(state.durationSeconds) || 0),
      positionSeconds: Math.max(0, Number(state.positionSeconds) || 0),
      artworkUrl: String(state.artworkUrl || '').slice(0, 2048)
    };
    primaryWindow = win;
    updateTaskbarControls(win);
    updateDiscordPresence();
  });
  ipcMain.handle('discord:configure', async (event, config) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) primaryWindow = win;
    return connectDiscord(config);
  });
  ipcMain.handle('account:status', async () => accountStatus());
  ipcMain.handle('account:open', async (_event, options = {}) => {
    const mode = ['signin','signup','passkeys'].includes(options.mode) ? options.mode : 'signin';
    await shell.openExternal(`${ignifireAccountEndpoint}/account?desktop=1&mode=${mode}`);return true;
  });
  ipcMain.handle('account:claim', async (_event, options = {}) => {
    const code = String(options.code || '').trim();
    if (!/^[A-Za-z0-9_-]{24,80}$/.test(code)) throw new Error('Enter the connection code shown in your browser.');
    const response = await accountRequest('/v1/desktop/claim', { method: 'POST', token: '', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: process.env.COMPUTERNAME || 'Windows PC' }) });
    const result = await response.json();await updateAccountCredentials({ token: result.token });
    let cloud = null;try { cloud = await downloadCloudSnapshot(); } catch (error) { if (error.status !== 404) result.syncError = error.message; }
    return { account: await accountStatus(), cloud };
  });
  ipcMain.handle('account:sign-out', async () => {try{await accountRequest('/v1/desktop/session',{method:'DELETE'})}catch{/* Always remove the local credential, even while offline. */}await updateAccountCredentials({ token: '' });return true});
  ipcMain.handle('account:sync-now', async (_event, state) => uploadCloudSnapshot(state, { manual: true }));
  ipcMain.handle('account:restore', async () => downloadCloudSnapshot());
  ipcMain.handle('library:choose-files', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import music',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Music', extensions: [...audioExtensions].map(x => x.slice(1)) }]
    });
    return result.canceled ? [] : await Promise.all(result.filePaths.map(filePath => entryFor(filePath)));
  });
  ipcMain.handle('library:choose-folder', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import music folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    return { root, name: path.basename(root), entries: await scanFolder(root) };
  });
  ipcMain.handle('library:add-live-folder', async event => {
    const result=await dialog.showOpenDialog({title:'Add a live music folder',properties:['openDirectory']});
    if(result.canceled||!result.filePaths[0])return null;
    const folder=normalizedLiveFolder({path:result.filePaths[0],addedAt:Date.now()});registerLiveFolder(folder,event.sender);return liveFolderSnapshot(folder);
  });
  ipcMain.handle('library:sync-live-folders', async (event, folders) => syncLiveFolders(folders,event.sender));
  ipcMain.handle('library:rescan-live-folder', async (event, folder) => {const record=registerLiveFolder(folder,event.sender);return liveFolderSnapshot(record.folder)});
  ipcMain.handle('library:remove-live-folder', async (_event,id) => {closeLiveFolderWatcher(String(id||''));return true});
  ipcMain.handle('library:choose-zip', async () => {
    const result=await dialog.showOpenDialog({title:'Import music from ZIP',properties:['openFile'],filters:[{name:'ZIP archives',extensions:['zip']}]});
    if(result.canceled||!result.filePaths[0])return null;
    return importZipArchive(result.filePaths[0]);
  });
  ipcMain.handle('dynamic-case:ensure-fonts', async () => ensureDynamicFontLibrary());
  ipcMain.handle('dynamic-case:generate', async (_event, options) => generateDynamicCaseArt(options));
  ipcMain.handle('artist:image-search', async (_event, artist, options) => searchSupplementalArtistImages(artist, options));
  ipcMain.handle('artist:image-cache', async (_event, options) => cacheArtistImage(options));
  ipcMain.handle('video:search-youtube', async (_event, options) => searchYouTubeMusicVideos(options));
  ipcMain.handle('lyrics:lookup', async (_event, options) => lookupLyrics(options));
  ipcMain.handle('suno:test', async () => testSunoConnection());
  ipcMain.handle('suno:create', async (_event, options) => createSunoTask(options));
  ipcMain.handle('suno:query', async (_event, taskId) => querySunoTask(taskId));
  ipcMain.handle('suno:import-track', async (_event, options) => importSunoTrack(options));
  ipcMain.handle('update:check', async (_event, channel) => checkForUpdates(channel));
  ipcMain.handle('update:download', async (event, channel) => downloadUpdate(event.sender,channel));
  ipcMain.handle('update:launch', async () => {
    if(!preparedUpdate?.installed)throw new Error('Finish preparing the update first.');
    try{if((await fs.stat(preparedUpdate.filePath)).size<1024)throw new Error('The prepared update is incomplete.')}catch(error){preparedUpdate=null;throw error}
    await new Promise((resolve,reject)=>{const installer=spawn(preparedUpdate.filePath,['/S','--updated','--force-run'],{detached:true,windowsHide:true,stdio:'ignore'});installer.once('error',error=>reject(new Error(`The silent updater could not start: ${error.message}`)));installer.once('spawn',()=>{installer.unref();resolve()})});
    setTimeout(()=>app.exit(0),220);return true;
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('before-quit',()=>{clearTimeout(cloudSyncTimer);destroyDiscordClient('disabled');for(const accelerator of mediaAccelerators.keys())globalShortcut.unregister(accelerator);for(const id of [...liveFolderWatchers.keys()])closeLiveFolderWatcher(id)});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
