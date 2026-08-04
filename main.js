const { app, BrowserWindow, shell, dialog, ipcMain, safeStorage, session, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

// Keep user content completely separate from the portable executable and its
// temporary extraction directory. This path is stable across Firefly upgrades.
// Retain the original profile directory so the first durable-data build can
// migrate the user's existing localStorage library in place.
const persistentRoot = path.join(app.getPath('appData'), 'firefly-music');
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
const apiPassBaseUrl = 'https://api.apipass.dev';
const updateRepository = 'FennXWeb/firefly-music-player';
const updateBranches = { stable: 'main', beta: 'beta' };
let downloadedUpdatePath = '';

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
  const response=await net.fetch(manifestUrl,{headers:{Accept:'application/json','User-Agent':`Firefly/${app.getVersion()}`}});
  if(!response.ok)throw new Error(response.status===404?'This update channel has not been published yet.':`Update server returned ${response.status}.`);
  const manifest=await response.json();
  if(!manifest||typeof manifest.version!=='string')throw new Error('The update manifest is invalid.');
  const available=compareVersions(manifest.version,app.getVersion())>0;
  return{available,channel:selected,branch,currentVersion:app.getVersion(),version:manifest.version,notes:String(manifest.notes||''),publishedAt:manifest.publishedAt||null,downloadUrl:available&&allowedUpdateUrl(manifest.downloadUrl)?manifest.downloadUrl:'',sha256:typeof manifest.sha256==='string'?manifest.sha256.toUpperCase():''};
}
async function downloadUpdate(webContents,channel='stable') {
  const update=await checkForUpdates(channel);
  if(!update.available)throw new Error('Firefly is already up to date.');
  if(!update.downloadUrl)throw new Error('This update is announced, but its Windows download is not published yet.');
  const response=await net.fetch(update.downloadUrl,{headers:{'User-Agent':`Firefly/${app.getVersion()}`}});
  if(!response.ok||!response.body)throw new Error(`Update download returned ${response.status}.`);
  await fs.mkdir(updatesDirectory,{recursive:true});
  const finalPath=path.join(updatesDirectory,`Firefly-${safeFileStem(update.version)}-Setup.exe`),temporaryPath=`${finalPath}.download`;
  const handle=await fs.open(temporaryPath,'w'),reader=response.body.getReader(),hash=crypto.createHash('sha256'),total=Number(response.headers.get('content-length'))||0;let received=0;
  try{while(true){const{done,value}=await reader.read();if(done)break;const chunk=Buffer.from(value);await handle.write(chunk);hash.update(chunk);received+=chunk.length;webContents.send('update:progress',{received,total,percent:total?Math.round(received/total*100):null})}}catch(error){await handle.close();await fs.rm(temporaryPath,{force:true});throw error}
  await handle.close();
  const digest=hash.digest('hex').toUpperCase();
  if(update.sha256&&digest!==update.sha256){await fs.rm(temporaryPath,{force:true});throw new Error('The update failed its integrity check and was discarded.');}
  await fs.rm(finalPath,{force:true});await fs.rename(temporaryPath,finalPath);downloadedUpdatePath=finalPath;
  return{...update,fileName:path.basename(finalPath),sha256:digest};
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
  const prompt = `Create professional print-ready back and spine artwork for the album "${String(options.title || '').slice(0, 180)}" by "${String(options.artist || '').slice(0, 180)}". Use the supplied front cover only as the visual reference. Extend its palette, texture, lighting, illustration language, and era into a landscape back-cover composition. Keep a calm, readable negative-space region across the center-left for a tracklist that Firefly will overlay later. Reserve exactly the far-right 8.33% of the canvas (128 pixels of the 1536-pixel width) as a coordinated vertical spine strip, separated cleanly from the back panel and filled edge-to-edge with continuous artwork. ABSOLUTELY NO text, letters, numbers, logos, track names, barcodes, legal copy, or typography anywhere in the generated image. Do not place a CD, jewel case mockup, hands, room, or product photography in the scene. Output only the flat artwork. Genre context: ${String(options.genre || 'unspecified').slice(0, 100)}.`;
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
  const allowed = host === 'wikimedia.org' || host.endsWith('.wikimedia.org') || host === 'cdn-images.dzcdn.net' || host === 'r2.theaudiodb.com' || host === 'theaudiodb.com' || host.endsWith('.theaudiodb.com');
  if (source.protocol !== 'https:' || !allowed) throw new Error('This artist-image source is not trusted by Firefly.');
  const response = await net.fetch(source.href);
  if (!response.ok) throw new Error(`Artist image download failed (${response.status}).`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || '';
  if (!['image/jpeg','image/png','image/webp'].includes(contentType)) throw new Error('The selected result is not a supported image.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error('Artist images must be smaller than 15 MB.');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const filePath = path.join(artistArtDirectory, `${safeFileStem(options.artist)}.${extension}`);
  await writeBufferAtomic(filePath, buffer);
  return { imageUrl: pathToFileURL(filePath).href, cachedAt: new Date().toISOString() };
}
async function fetchArtistJson(url) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await net.fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': `Firefly/${app.getVersion()}` } });
    if (!response.ok) throw new Error(`Artist source returned ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
function normalizedArtistName(value = '') { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase(); }
async function searchSupplementalArtistImages(artist = '') {
  artist = String(artist).trim().slice(0, 160);
  if (!artist) return [];
  const wanted = normalizedArtistName(artist);
  const sources = await Promise.allSettled([
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
  ]);
  return sources.flatMap(result => result.status === 'fulfilled' ? result.value : []);
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
  const response = await net.fetch(`${apiPassBaseUrl}/api/v1/jobs/recordInfo?taskId=firefly_connection_check`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
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
  const headers = { Accept: 'application/json', 'User-Agent': 'Firefly Music Player/0.1.20 (https://github.com/FennXWeb/firefly-music-player)' };
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
    } catch { entry.metadata = null; }
  }
  return entry;
}

async function scanFolder(root) {
  const results = [];
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) await walk(fullPath);
      else if (audioExtensions.has(path.extname(item.name).toLowerCase()) || imageExtensions.has(path.extname(item.name).toLowerCase())) results.push(await entryFor(fullPath, root));
    }
  }
  await walk(root);
  return results;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#090909',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09090900', symbolColor: '#8f8b86', height: 42 },
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
  });
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
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/embed/*'] },
    (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://firefly.local/' } })
  );
  ipcMain.handle('state:load', async () => ({
    state: await readJson(statePath, null),
    dataDirectory
  }));
  ipcMain.handle('state:save', async (_event, state) => {
    await writeJsonAtomic(statePath, { ...state, schemaVersion: 3, savedAt: new Date().toISOString() });
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
    await writeJsonAtomic(credentialsPath, {
      openaiKey: encryptSecret(credentials?.openaiKey),
      sunoToken: encryptSecret(credentials?.sunoToken)
    });
    return true;
  });
  ipcMain.handle('state:open-directory', async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    return shell.openPath(dataDirectory);
  });
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
  ipcMain.handle('dynamic-case:ensure-fonts', async () => ensureDynamicFontLibrary());
  ipcMain.handle('dynamic-case:generate', async (_event, options) => generateDynamicCaseArt(options));
  ipcMain.handle('artist:image-search', async (_event, artist) => searchSupplementalArtistImages(artist));
  ipcMain.handle('artist:image-cache', async (_event, options) => cacheArtistImage(options));
  ipcMain.handle('lyrics:lookup', async (_event, options) => lookupLyrics(options));
  ipcMain.handle('suno:test', async () => testSunoConnection());
  ipcMain.handle('suno:create', async (_event, options) => createSunoTask(options));
  ipcMain.handle('suno:query', async (_event, taskId) => querySunoTask(taskId));
  ipcMain.handle('suno:import-track', async (_event, options) => importSunoTrack(options));
  ipcMain.handle('update:check', async (_event, channel) => checkForUpdates(channel));
  ipcMain.handle('update:download', async (event, channel) => downloadUpdate(event.sender,channel));
  ipcMain.handle('update:launch', async () => {
    if(!downloadedUpdatePath)throw new Error('Download an update first.');
    try{if((await fs.stat(downloadedUpdatePath)).size<1024)throw new Error('The downloaded update is incomplete.')}catch(error){downloadedUpdatePath='';throw error}
    const result=await shell.openPath(downloadedUpdatePath);if(result)throw new Error(result);
    setTimeout(()=>app.quit(),600);return true;
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
