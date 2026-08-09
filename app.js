const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

let albums = [];
let customPlaylists = [];
let shelves = [];
let artistProfiles = {};
let sunoConnected = false;
let sunoJobs = [];
let playHistory = [];
let liveFolders = [];
let sunoTab = 'create';
let sunoPolling = false;
let sunoPollTimer = null;
const defaultSettings = {
  accent: '#f55f45', accentRgb: '245,95,69', ambient: true,
  reducedMotion: false, glassEffects:true, highContrast:false, theme:'midnight', uiScale:100, density:'comfortable', cornerStyle:'rounded', albumCardSize:'medium', sidebarWidth:'default', showSidebarPlaylists:true,
  gapless: true, crossfade: 4, volume: 72, playbackRate:1, preservePitch:true, autoplayNext:true, preloadAudio:true, stopAfterCurrent:false,
  muted: false, shuffle: false, repeatMode: 'off', songSort: 'added-desc', albumView:'grid', albumFilter:'all', playlistDefaultSort:'manual', confirmDeletes:true, showPendingTracks:true, dynamicArtByDefault: false,
  onlineMetadata:true, onlineLyrics:true, onlineArtistImages:true, onlineMusicVideos:true,
  sunoEndpoint: 'https://api.apipass.dev', sunoModel: 'V5_5', sunoChannel: 'auto', updateChannel: 'stable', visualizerStyle:'waves',
  discordRichPresence:false, discordShowTrack:true, discordShowAlbum:true, discordShowPaused:true, discordTimeDisplay:'elapsed', discordShareArtwork:true, discordShowButton:false,
  cloudSyncEnabled:false, autoDownloadCloudLibrary:false
};
let settings = { ...defaultSettings };
let credentials = { openaiKey: '', sunoToken: '' };
let dataDirectory = '';
let persistenceReady = false;
let persistenceTimer = null;
let legacySaved = {};
try {
  legacySaved = JSON.parse(localStorage.getItem('firefly-library-v1') || '{}');
} catch { /* Start with a clean library if saved data is invalid. */ }

let currentView = 'home';
let viewBackStack = [];
let viewForwardStack = [];
const openedAlbumCases = new Set();
let currentTrack = null;
let playbackQueue = [];
let playbackQueueExplicit = false;
let playbackOriginalQueue = [];
let playbackContext = null;
let shuffleEnabled = false;
let repeatMode = 'off';
let lastAudibleVolume = 72;
let draggedQueueTrack = null;
let pendingPlayCountTrackId = null;
let isPlaying = false;
let simProgress = 38;
let simTimer = null;
let draggedPlaylist = null;
let draggedPlaylistTrack = null;
let draggedAlbum = null;
let settingsTab = 'appearance';
const selectedTrackIds = new Set();
const selectedAlbumIds = new Set();
let trackSelectionAnchor = null;
let albumSelectionAnchor = null;
let screenshotData = null;
let playlistImportTarget = null;
let videoLookupToken = 0;
let fullscreenMode = 'visualizer';
let visualizerStyle = 'waves';
let activeLyricIndex = -1;
let updateState = { status:'idle', channel:'stable', available:false, progress:null };
let currentRelease = { version:'', audience:'internal', notes:'', highlights:[] };
let cloudQuotaAlertShown = false;
let updateCheckTimer = null;
let updateRestartPromptedVersion = '';
let pendingUpdateRestartPrompt = false;
let volumePersistenceTimer = null;
let dynamicDefaultQueue = Promise.resolve();
let libraryRevision = 0;
let renderedLibraryRevision = 0;
let dynamicViewRefreshTimer = null;
let discordPresenceState = { status:'disabled', error:'' };
let lastDiscordProgressSync = 0;
const ACCOUNT_STORAGE_LIMIT_BYTES = 256 * 1024 * 1024 * 1024;
let accountState = { signedIn:false, configured:false, status:'idle', storageUsed:0, storageLimit:ACCOUNT_STORAGE_LIMIT_BYTES };
let accountSyncState = { status:'idle' };
let localStateSavedAt = 0;
let cloudMarkerPersistenceTimer = null;
let legacyCacheRetired = false;
const VIDEO_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;

const view = $('#view');
const audio = $('#audio');
const modalLayer = $('#modalLayer');
document.documentElement.classList.toggle('windows-app',window.firefly?.platform==='win32');
new MutationObserver(()=>{renderedLibraryRevision=libraryRevision}).observe(view,{childList:true});

function allTracks() { return albums.flatMap(a => a.tracks); }
function albumById(id) { return albums.find(a => a.id === id); }
function isCloudTrack(track){return Boolean(track?.cloudFile?.hash)}
function isCloudDownloaded(track){return isCloudTrack(track)&&Boolean(track?.path)}
function cloudTrackBadge(track){return isCloudTrack(track)?`<span class="cloud-track-badges"><i class="cloud-badge" title="Stored in your cloud">CLOUD</i>${isCloudDownloaded(track)?'<i class="downloaded-badge" title="Downloaded on this PC">DOWNLOADED</i>':''}</span>`:''}
function albumCloudState(album){const tracks=(album?.tracks||[]).filter(track=>!track.pending),cloudCount=tracks.filter(isCloudTrack).length;return{cloud:tracks.length>0&&cloudCount===tracks.length,partial:cloudCount>0&&cloudCount<tracks.length,cloudCount,total:tracks.length,downloaded:tracks.length>0&&tracks.every(isCloudDownloaded)}}
function albumCloudBadge(album){const state=albumCloudState(album);return state.cloud?`<span class="album-cloud-badges"><i>CLOUD</i>${state.downloaded?'<i>DOWNLOADED</i>':''}</span>`:state.partial?`<span class="album-cloud-badges"><i title="${state.cloudCount} of ${state.total} tracks stored">${accountSyncState.status==='syncing'?'SYNCING':'PARTIAL CLOUD'}</i></span>`:''}
async function setCloudDownload(tracks,download=true){
  let eligible=(tracks||[]).filter(track=>isCloudTrack(track)&&(download?!isCloudDownloaded(track):isCloudDownloaded(track)));if(!download&&eligible.length){const hashes=new Set(eligible.map(track=>track.cloudFile.hash));eligible=allTracks().filter(track=>hashes.has(track.cloudFile?.hash)&&isCloudDownloaded(track))}if(!eligible.length){toast(download?'Already downloaded':'No cloud downloads to remove');return}
  try{
    const results=download?await window.firefly.downloadCloudTracks(eligible):await window.firefly.removeCloudDownloads(eligible),byId=new Map(results.map(result=>[result.id,result]));
    eligible.forEach(track=>{const result=byId.get(track.id);if(!result)return;track.path=result.path||null;track.url=result.url||`ignifire-cloud://track/${track.cloudFile.hash}/${encodeURIComponent(track.cloudFile.name||'track.audio')}`;track.managedFile=Boolean(result.path)});
    saveLibrary();refreshLibraryView();toast(download?'Download complete':'Download removed',`${results.length} cloud track${results.length===1?'':'s'} updated.`);
  }catch(error){toast(download?'Could not download tracks':'Could not remove downloads',error.message)}
}
const OLD_BANGER_AGE_MS = 90 * 24 * 60 * 60 * 1000;
function isOldBanger(track) { const lastPlayed=Number(track.lastPlayed)||0;return Number(track.plays)>45&&lastPlayed>0&&Date.now()-lastPlayed>=OLD_BANGER_AGE_MS; }
function pruneEmptyAlbums() {
  const before=albums.length;
  albums=albums.filter(album=>Array.isArray(album.tracks)&&album.tracks.length>0);
  return before-albums.length;
}
function syncShelves() {
  if(!shelves.length)shelves=[{id:'shelf-main',name:'Main Shelf',albumIds:[]}];
  const valid=new Set(albums.map(a=>a.id));
  shelves.forEach(shelf=>shelf.albumIds=(shelf.albumIds||[]).filter(id=>valid.has(id)));
  const placed=new Set(shelves.flatMap(s=>s.albumIds));
  albums.forEach(album=>{if(!placed.has(album.id))shelves[0].albumIds.push(album.id)});
}
function playlistTracks(playlist) {
  if (!playlist) return [];
  if (playlist.children) return [...new Map(playlist.children.flatMap(child => sortedPlaylistTracks(child)).map(track=>[track.id,track])).values()];
  const ids = playlist.trackIds || [];
  return ids.map(id => allTracks().find(t => t.id === id)).filter(Boolean);
}
function setTrackFavorite(track,value=!track?.favorite){if(!track)return;track.favorite=Boolean(value);saveLibrary();updateFavoriteControl();toast(track.favorite?'Added to favorites':'Removed from favorites',track.title)}
function updateFavoriteControl(){const button=$('#favoriteTrack');if(!button)return;const active=Boolean(currentTrack?.favorite);button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.title=active?'Remove from favorites':'Add to favorites'}
const playlistSortLabels={manual:'Manual order','title-asc':'Title · A–Z','artist-asc':'Artist · A–Z','album-asc':'Album · A–Z','added-desc':'Recently added','plays-desc':'Most played','duration-asc':'Shortest first'};
function playlistSortMode(playlist){return playlist?.sortMode||settings.playlistDefaultSort||'manual'}
function sortedPlaylistTracks(playlist){
  const tracks=[...playlistTracks(playlist)],mode=playlistSortMode(playlist),collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});
  const sorters={'title-asc':(a,b)=>collator.compare(a.title,b.title)||collator.compare(a.artist,b.artist),'artist-asc':(a,b)=>collator.compare(a.artist,b.artist)||collator.compare(a.title,b.title),'album-asc':(a,b)=>collator.compare(a.album,b.album)||collator.compare(a.title,b.title),'added-desc':(a,b)=>(Number(b.added)||0)-(Number(a.added)||0),'plays-desc':(a,b)=>(Number(b.plays)||0)-(Number(a.plays)||0),'duration-asc':(a,b)=>(Number(a.durationSeconds)||0)-(Number(b.durationSeconds)||0)};
  return sorters[mode]?tracks.sort(sorters[mode]):tracks;
}
function flattenPlaylists(collection=customPlaylists){return collection.flatMap(playlist=>[playlist,...flattenPlaylists(playlist.children||[])])}
function findPlaylistById(id){return flattenPlaylists().find(playlist=>playlist.id===id)}
function leafPlaylists(){return flattenPlaylists().filter(playlist=>!playlist.children)}
function playlistParentById(id,collection=customPlaylists){for(const playlist of collection){if((playlist.children||[]).some(child=>child.id===id))return playlist;const parent=playlistParentById(id,playlist.children||[]);if(parent)return parent}return null}
function clearBulkSelection(renderBar=true){selectedTrackIds.clear();selectedAlbumIds.clear();trackSelectionAnchor=null;albumSelectionAnchor=null;if(renderBar){applySelectionClasses();renderBulkSelectionBar()}}
function selectedBulkTracks(){
  const tracks=new Map();
  selectedAlbumIds.forEach(id=>albumById(id)?.tracks.forEach(track=>tracks.set(track.id,track)));
  selectedTrackIds.forEach(id=>{const track=allTracks().find(item=>item.id===id);if(track)tracks.set(track.id,track)});
  return [...tracks.values()];
}
function applySelectionClasses(){
  $$('.album-card[data-album],.album-list-row[data-album]',view).forEach(card=>card.classList.toggle('bulk-selected',selectedAlbumIds.has(card.dataset.album)));
  $$('tr[data-track]',view).forEach(row=>row.classList.toggle('bulk-selected',selectedTrackIds.has(row.dataset.track)));
}
function renderBulkSelectionBar(){
  const bar=$('#bulkSelectionBar'),albumCount=selectedAlbumIds.size,trackCount=selectedTrackIds.size,count=albumCount||trackCount;
  if(!count){bar.classList.remove('open');bar.setAttribute('aria-hidden','true');bar.innerHTML='';return}
  const kind=albumCount?'album':'track';
  bar.innerHTML=`<span class="bulk-count"><b>${count}</b><small>${kind}${count===1?'':'s'} selected</small></span><span class="bulk-key-hint">Ctrl-click to toggle · Shift-click for range</span><button data-bulk-action="play">${icon('play')} Play</button><button data-bulk-action="playlist">${icon('playlist')} Add to playlist</button><button class="danger" data-bulk-action="delete">${icon('close')} Delete</button><button class="bulk-clear" data-bulk-action="clear" aria-label="Clear selection">${icon('close')}</button>`;
  bar.classList.add('open');bar.setAttribute('aria-hidden','false');
}
function handleBulkSelection(type,id,event){
  const isAlbum=type==='album',selection=isAlbum?selectedAlbumIds:selectedTrackIds,other=isAlbum?selectedTrackIds:selectedAlbumIds;
  const elements=isAlbum?$$('.album-card[data-album]',view):$$('tr[data-track]',view),ids=elements.map(element=>isAlbum?element.dataset.album:element.dataset.track);
  let anchor=isAlbum?albumSelectionAnchor:trackSelectionAnchor;
  other.clear();
  if(event.shiftKey&&anchor&&ids.includes(anchor)){
    if(!(event.ctrlKey||event.metaKey))selection.clear();
    const start=ids.indexOf(anchor),end=ids.indexOf(id);ids.slice(Math.min(start,end),Math.max(start,end)+1).forEach(item=>selection.add(item));
  }else if(event.ctrlKey||event.metaKey){selection.has(id)?selection.delete(id):selection.add(id);anchor=id}
  else{selection.clear();selection.add(id);anchor=id}
  if(isAlbum)albumSelectionAnchor=anchor;else trackSelectionAnchor=anchor;
  applySelectionClasses();renderBulkSelectionBar();
}
function addBulkSelectionToPlaylist(){
  const tracks=selectedBulkTracks(),destinations=leafPlaylists();
  if(!tracks.length)return;if(!destinations.length){toast('Create a playlist first');return}
  openModal(`<div class="modal-head"><h2>Add selection to playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">Add ${tracks.length} selected track${tracks.length===1?'':'s'} to:</p><div class="detected-list">${destinations.map(playlist=>`<button class="detected-track" data-add-bulk-to-playlist="${playlist.id}" style="background:transparent;color:inherit;text-align:left"><i class="status-dot"></i><span><b>${esc(playlist.title)}</b><small>${playlistTracks(playlist).length} songs</small></span><em>ADD</em></button>`).join('')}</div></div>`,true);
  $$('[data-add-bulk-to-playlist]',modalLayer).forEach(button=>button.onclick=()=>{const playlist=findPlaylistById(button.dataset.addBulkToPlaylist);playlist.trackIds=playlist.trackIds||[];let added=0;tracks.forEach(track=>{if(!playlist.trackIds.includes(track.id)){playlist.trackIds.push(track.id);added++}});saveLibrary();closeModal();toast(added?'Selection added to playlist':'Selection already in playlist',added?`${added} tracks added to ${playlist.title}`:playlist.title)});
}
function removePlaylistTrackReferences(playlist,ids){if(Array.isArray(playlist.trackIds))playlist.trackIds=playlist.trackIds.filter(id=>!ids.has(id));(playlist.children||[]).forEach(child=>removePlaylistTrackReferences(child,ids))}
function deleteBulkSelection(){
  const albumCount=selectedAlbumIds.size,tracks=selectedBulkTracks(),trackIds=new Set(tracks.map(track=>track.id));
  const detail=albumCount?`${albumCount} album${albumCount===1?'':'s'} and ${tracks.length} track${tracks.length===1?'':'s'} will be removed from Ignifire.`:`${tracks.length} selected track${tracks.length===1?'':'s'} will be removed from Ignifire.`;
  confirmRemove('Delete selected items?',`${detail} Source files stay untouched.`,()=>{if(albumCount)albums=albums.filter(album=>!selectedAlbumIds.has(album.id));else albums.forEach(album=>album.tracks=album.tracks.filter(track=>!trackIds.has(track.id)));customPlaylists.forEach(playlist=>removePlaylistTrackReferences(playlist,trackIds));clearBulkSelection(false);saveLibrary();render();renderBulkSelectionBar();toast('Selection removed')});
}
function runBulkAction(action){
  if(action==='clear'){clearBulkSelection();return}
  if(action==='play'){playTrackQueue(selectedBulkTracks());return}
  if(action==='playlist'){addBulkSelectionToPlaylist();return}
  if(action==='delete')deleteBulkSelection();
}
function currentLibraryState(){return { albums, playlists:customPlaylists, shelves, artistProfiles, sunoConnected, sunoJobs, playHistory, liveFolders, settings }}
function adoptExternalArtworkReferences(saved){
  const current=currentLibraryState();
  const visit=(local,normalized)=>{
    if(!local||!normalized||typeof local!=='object'||typeof normalized!=='object')return;
    if(Array.isArray(local)&&Array.isArray(normalized)){const byId=new Map(normalized.filter(item=>item&&typeof item==='object'&&item.id!=null).map(item=>[String(item.id),item]));local.forEach((item,index)=>visit(item,item?.id!=null?byId.get(String(item.id)):normalized[index]));return}
    for(const[key,value]of Object.entries(local)){const next=normalized[key];if(typeof value==='string'&&value.startsWith('data:image/')&&typeof next==='string'&&next.startsWith('file:'))local[key]=next;else if(value&&next&&typeof value==='object'&&typeof next==='object')visit(value,next)}
  };
  visit(current,saved);
}
function saveLibrary() {
  pruneEmptyAlbums();
  syncShelves();
  libraryRevision++;
  localStateSavedAt=Date.now();
  const state = currentLibraryState();
  if (!window.firefly?.saveState) {
    try { localStorage.setItem('firefly-library-v1', JSON.stringify(state)); }
    catch { toast('Browser storage is full','Sign in and enable cloud sync to keep this library protected.'); }
  }
  if (persistenceReady && window.firefly?.saveState) {
    clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => window.firefly.saveState(state).then(result=>{if(result?.state)adoptExternalArtworkReferences(result.state);if(!legacyCacheRetired){try{localStorage.removeItem('firefly-library-v1');legacyCacheRetired=true}catch{}}}).catch(() => toast('Could not save library','Ignifire will retry after the next change.')), 120);
  }
  renderSidebarPlaylists();
  scheduleDynamicViewRefresh();
}
function scheduleDynamicViewRefresh(delay=90) {
  const targetRevision=libraryRevision;clearTimeout(dynamicViewRefreshTimer);
  dynamicViewRefreshTimer=setTimeout(()=>{
    if(renderedLibraryRevision>=targetRevision)return;
    const active=document.activeElement,editing=active&&view.contains(active)&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName);
    if(editing){scheduleDynamicViewRefresh(350);return}
    const content=$('#content'),scrollTop=content?.scrollTop||0;
    render();
    requestAnimationFrame(()=>{if(content)content.scrollTop=scrollTop});
  },delay);
}
function refreshLibraryView({preserveScroll=true}={}) {
  clearTimeout(dynamicViewRefreshTimer);
  const content=$('#content'),scrollTop=content?.scrollTop||0;
  render();
  if(preserveScroll)requestAnimationFrame(()=>{if(content)content.scrollTop=scrollTop});
}
function saveCredentials() {
  if (persistenceReady && window.firefly?.saveCredentials) return window.firefly.saveCredentials(credentials).catch(() => { toast('Could not save connection credentials'); return false; });
  return Promise.resolve(false);
}
function applySavedState(saved = {}) {
  if (Array.isArray(saved.albums)) { albums = saved.albums;albums.forEach(album=>(album.tracks||[]).forEach(track=>{track.plays=Math.max(0,Number(track.plays)||0);if(track.lastPlayed!=null&&!Number.isFinite(Number(track.lastPlayed)))track.lastPlayed=null})); }
  if (Array.isArray(saved.playlists)) customPlaylists = saved.playlists;
  if (Array.isArray(saved.shelves)) shelves = saved.shelves;
  if (saved.artistProfiles && typeof saved.artistProfiles === 'object' && !Array.isArray(saved.artistProfiles)) artistProfiles = saved.artistProfiles;
  if (Array.isArray(saved.sunoJobs)) sunoJobs = saved.sunoJobs;
  if (Array.isArray(saved.playHistory)) playHistory = saved.playHistory.filter(event=>event&&typeof event.trackId==='string'&&Number.isFinite(Number(event.playedAt))).slice(-2500);
  if (Array.isArray(saved.liveFolders)) liveFolders = saved.liveFolders.filter(folder=>folder&&folder.kind!=='cloud'&&typeof folder.id==='string'&&typeof folder.path==='string').map(folder=>({...folder,kind:'live',status:folder.status||'pending'}));
  sunoConnected = Boolean(saved.sunoConnected);
  settings = { ...defaultSettings, ...(saved.settings || {}) };
  delete settings.cloudServerUrl;
  delete settings.discordApplicationId;
  delete settings.discordLargeImageKey;
  settings.sunoEndpoint = defaultSettings.sunoEndpoint;
  if(Number(settings.crossfade)>12)settings.crossfade=4;
  settings.uiScale=Math.max(85,Math.min(120,Number(settings.uiScale)||100));
  settings.repeatMode = ['off','all','one'].includes(settings.repeatMode) ? settings.repeatMode : 'off';
  settings.visualizerStyle=['waves','orbit','spectrum'].includes(settings.visualizerStyle)?settings.visualizerStyle:'waves';
  visualizerStyle=settings.visualizerStyle;
  shuffleEnabled = Boolean(settings.shuffle);
  repeatMode = settings.repeatMode;
  lastAudibleVolume = settings.volume>0?settings.volume:72;
}
function applySettings() {
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--accent-rgb', settings.accentRgb);
  document.documentElement.style.setProperty('--ui-scale',String(settings.uiScale/100));
  document.documentElement.style.setProperty('--window-controls-offset',`${Math.ceil(168/(settings.uiScale/100))}px`);
  document.documentElement.dataset.theme=settings.theme;
  document.documentElement.dataset.density=settings.density;
  document.documentElement.dataset.corners=settings.cornerStyle;
  document.documentElement.dataset.albumSize=settings.albumCardSize;
  document.documentElement.dataset.sidebarWidth=settings.sidebarWidth;
  document.body.style.zoom=String(settings.uiScale/100);
  $('.ambient').style.display = settings.ambient ? '' : 'none';
  document.documentElement.style.scrollBehavior = settings.reducedMotion ? 'auto' : '';
  document.documentElement.classList.toggle('reduced-motion',Boolean(settings.reducedMotion));
  document.documentElement.classList.toggle('no-glass',!settings.glassEffects);
  document.documentElement.classList.toggle('high-contrast',Boolean(settings.highContrast));
  document.documentElement.classList.toggle('hide-sidebar-playlists',!settings.showSidebarPlaylists);
  audio.volume = settings.muted ? 0 : settings.volume / 100;
  audio.playbackRate=Math.max(.5,Math.min(2,Number(settings.playbackRate)||1));
  audio.preservesPitch=Boolean(settings.preservePitch);
  audio.preload=settings.preloadAudio?'auto':'metadata';
  updatePlaybackModeControls();
  updateVolumeControls();
  updateVisualizerControls();
}
async function initializePersistence() {
  let durableState = null;
  if (window.firefly?.loadState) {
    try {
      const loaded = await window.firefly.loadState();
      durableState = loaded?.state;
      localStateSavedAt=Date.parse(durableState?.savedAt||'')||0;
      dataDirectory = loaded?.dataDirectory || '';
      credentials = { ...credentials, ...(await window.firefly.loadCredentials()) };
    } catch { /* The browser fallback continues to use local storage. */ }
  }
  const hasLibraryContent = state => Boolean(
    state && ((Array.isArray(state.albums) && state.albums.length) ||
      (Array.isArray(state.playlists) && state.playlists.length) ||
      (Array.isArray(state.shelves) && state.shelves.some(shelf => shelf?.albumIds?.length)))
  );
  const migrateLegacy = hasLibraryContent(legacySaved) && !hasLibraryContent(durableState);
  applySavedState(migrateLegacy ? legacySaved : (durableState || legacySaved));
  albums.forEach(activateDynamicFont);
  const removedEmptyAlbums=pruneEmptyAlbums();
  persistenceReady = true;
  if(durableState&&!migrateLegacy){try{localStorage.removeItem('firefly-library-v1');legacyCacheRetired=true}catch{}}
  applySettings();
  setRange($('#progress'), 0);
  setRange($('#volume'), settings.volume);
  render();
  if (!durableState || migrateLegacy || removedEmptyAlbums) saveLibrary();
  initializeLiveFolderSync();
  initializeUpdater();
  initializeSunoPolling();
  configureDiscordPresence();
  initializeAccount();
}
function formatStorage(bytes=0){const value=Math.max(0,Number(bytes)||0);return value>=1024**4?`${(value/1024**4).toFixed(value>=100*1024**4?0:1)} TB`:value>=1024**3?`${(value/1024**3).toFixed(value>=100*1024**3?0:1)} GB`:value>=1024**2?`${(value/1024**2).toFixed(value>=100*1024**2?0:1)} MB`:`${Math.ceil(value/1024)} KB`}
function applyCloudState(payload,{notify=true}={}){
  const cloud=payload?.state;if(!cloud)return false;
  const localFolders=liveFolders,syncEnabled=settings.cloudSyncEnabled;
  applySavedState(cloud);liveFolders=localFolders;delete settings.cloudServerUrl;settings.cloudSyncEnabled=syncEnabled;pruneEmptyAlbums();syncShelves();applySettings();saveLibrary();render();
  if(notify)toast('Cloud library restored',`${allTracks().length} tracks and ${customPlaylists.length} playlists are ready on this PC.`);return true;
}
function applyCloudSyncResult(result,{persist=true}={}){
  const files=new Map((result?.trackFiles||[]).map(item=>[item.id,item.cloudFile]));
  const removed=new Set(result?.removedLocalTrackIds||[]);let changed=false;
  allTracks().forEach(track=>{if(files.has(track.id)){track.cloudFile=files.get(track.id);changed=true}if(removed.has(track.id)){track.path=null;track.url=`ignifire-cloud://track/${track.cloudFile.hash}/${encodeURIComponent(track.cloudFile.name||'track.audio')}`;track.managedFile=false;changed=true}});
  if(changed&&persist){clearTimeout(cloudMarkerPersistenceTimer);saveLibrary()}
  else if(changed){libraryRevision++;renderSidebarPlaylists();scheduleDynamicViewRefresh(60);clearTimeout(cloudMarkerPersistenceTimer);cloudMarkerPersistenceTimer=setTimeout(()=>saveLibrary(),12000)}
  return changed;
}
async function initializeAccount(){
  if(!window.firefly?.getAccountStatus)return;
  try{const status=await window.firefly.getAccountStatus();accountState={...accountState,...status,status:'ready'};if(status.signedIn&&settings.cloudSyncEnabled){const payload=await window.firefly.restoreAccountCloud().catch(()=>null),cloudTime=Date.parse(payload?.syncedAt||payload?.state?.cloudSnapshot?.createdAt||'')||0;if(payload&&cloudTime>localStateSavedAt)applyCloudState(payload,{notify:false});else if(localStateSavedAt>cloudTime+1000)window.firefly.syncAccountNow(currentLibraryState()).then(result=>applyCloudSyncResult(result)).catch(()=>{})}}
  catch(error){accountState={...accountState,status:'offline',error:error.message}}
  updateAccountControl();
  if(currentView==='settings'&&settingsTab==='account')renderSettings();
}
function toast(title, detail = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3400);
}
function updateChannelLabel(channel=settings.updateChannel){return channel==='beta'?'Test · beta':'Stable · main'}
function releaseHighlights(){const source=updateState.available?updateState:currentRelease,items=Array.isArray(source.highlights)?source.highlights.filter(Boolean):[];if(items.length)return items.slice(0,5);if(source.audience==='user'&&source.notes)return[String(source.notes)];return['Polish, reliability, and behind-the-scenes improvements.']}
function renderWhatsNewWidget(){const widget=$('#whatsNewWidget');if(!widget)return;const highlights=releaseHighlights(),version=(updateState.available?updateState.version:currentRelease.version)||'';widget.innerHTML=`<span class="whats-new-orb">✦</span><span><b>What’s new${version?` · ${esc(version)}`:''}</b><small>${esc(highlights[0])}</small></span>`}
function openWhatsNew(){const highlights=releaseHighlights(),version=(updateState.available?updateState.version:currentRelease.version)||'';openModal(`<div class="modal-head"><h2>What’s new${version?` in ${esc(version)}`:''}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="whats-new-modal-mark">✦</div><div class="whats-new-list">${highlights.map(item=>`<article><i></i><p>${esc(item)}</p></article>`).join('')}</div></div><div class="modal-actions"><button class="primary close-modal">Done</button></div>`) }
function renderUpdateWidget(){
  const widget=$('#updateWidget');if(!widget)return;
  const labels={idle:'Updates',checking:'Checking for updates',current:'Ignifire is up to date',available:`Version ${updateState.version} available`,downloading:updateState.progress==null?'Downloading update':`Downloading · ${updateState.progress}%`,installing:'Preparing update',ready:'Restart to apply update',error:'Update check unavailable'};
  widget.className=`update-widget ${updateState.status}`;widget.innerHTML=`${icon(updateState.status==='available'||updateState.status==='ready'?'spark':'upload')}<span><b>${labels[updateState.status]||labels.idle}</b><small>${updateChannelLabel(updateState.channel)}</small></span><i></i>`;
  widget.setAttribute('aria-label',`${labels[updateState.status]||labels.idle}. ${updateChannelLabel(updateState.channel)}`);
  renderWhatsNewWidget();
}
async function checkForUpdates(manual=false){
  if(['downloading','installing','ready'].includes(updateState.status)){if(manual)openUpdateModal();return}
  if(!window.firefly?.checkForUpdates){updateState={status:'error',channel:settings.updateChannel,error:'Updates are available in the Windows app.'};renderUpdateWidget();return}
  updateState={...updateState,status:'checking',channel:settings.updateChannel,progress:null};renderUpdateWidget();
  try{const result=await window.firefly.checkForUpdates(settings.updateChannel);updateState={...result,status:result.available?'available':'current',progress:null};renderUpdateWidget();if(currentView==='settings')renderSettings();if(manual)toast(result.available?`Ignifire ${result.version} is available`:'Ignifire is up to date',updateChannelLabel(result.channel))}
  catch(error){updateState={status:'error',channel:settings.updateChannel,available:false,error:error?.message||'Update check failed.'};renderUpdateWidget();if(currentView==='settings')renderSettings();if(manual)toast('Could not check for updates',updateState.error)}
}
function updateModalMarkup(){
  const status=updateState.status,available=status==='available',downloading=status==='downloading',installing=status==='installing',ready=status==='ready';
  const title=available?`Ignifire ${esc(updateState.version)} is available`:ready?'Restart to finish updating':installing?'Preparing update':downloading?'Downloading update':status==='current'?'You’re up to date':'Ignifire updates';
  const detail=available?(updateState.notes||`A new ${updateChannelLabel(updateState.channel).toLowerCase()} build is ready.`):ready?`Ignifire ${updateState.version||''} downloaded and passed its integrity check. Restart whenever you’re ready; installation is silent and the updated app reopens automatically.`:installing?'Ignifire is verifying the download and preparing its silent installer. Music and library activity can continue while this finishes.':downloading?'The update is downloading in the background. You can close this window and keep listening.':status==='error'?updateState.error:`Ignifire checks the ${updateChannelLabel(updateState.channel)} channel automatically.`;
  return `<div class="modal-head"><h2>${title}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="update-modal-hero ${status}">${icon(available||ready?'spark':'upload')}<div><span>${updateChannelLabel(updateState.channel)}</span><p>${esc(detail)}</p></div></div>${downloading?`<div class="update-progress"><span><i style="width:${updateState.progress||0}%"></i></span><small>${updateState.progress==null?'Preparing download…':`${updateState.progress}% downloaded`}</small></div>`:''}</div><div class="modal-actions"><button class="ghost close-modal">${ready?'Later':'Close'}</button>${available?`<button class="primary" id="downloadUpdate">${icon('upload')} Download & install</button>`:''}${ready?`<button class="primary" id="launchUpdate">Restart Ignifire</button>`:''}${['current','error','idle'].includes(status)?`<button class="primary" id="modalCheckUpdate">Check now</button>`:''}</div>`;
}
function openUpdateModal(){openModal(updateModalMarkup(),true);if($('#downloadUpdate'))$('#downloadUpdate').onclick=downloadAvailableUpdate;if($('#launchUpdate'))$('#launchUpdate').onclick=launchDownloadedUpdate;if($('#modalCheckUpdate'))$('#modalCheckUpdate').onclick=()=>{closeModal();checkForUpdates(true)}}
async function downloadAvailableUpdate(){
  updateState={...updateState,status:'downloading',progress:null};renderUpdateWidget();closeModal();toast('Update started','Ignifire will download and install it in the background.');
  try{const result=await window.firefly.downloadUpdate(updateState.channel);markUpdateReady(result)}
  catch(error){updateState={...updateState,status:'error',error:error?.message||'The update could not be prepared.'};renderUpdateWidget();toast('Background update failed',updateState.error)}
}
function markUpdateReady(result={}){updateState={...updateState,...result,status:'ready',progress:100};renderUpdateWidget();if(updateRestartPromptedVersion===updateState.version)return;updateRestartPromptedVersion=updateState.version||'ready';if(modalLayer.classList.contains('open'))pendingUpdateRestartPrompt=true;else openUpdateModal();toast('Update ready','Restart Ignifire whenever you’re ready to apply it.')}
async function launchDownloadedUpdate(){const button=$('#launchUpdate');if(button){button.disabled=true;button.textContent='Restarting…'}try{await window.firefly.launchUpdate()}catch(error){if(button)button.disabled=false;toast('Could not restart Ignifire',error?.message||'Try again from the update widget.')}}
function initializeUpdater(){
  updateState.channel=settings.updateChannel==='beta'?'beta':'stable';renderUpdateWidget();
  window.firefly?.getCurrentRelease?.().then(release=>{currentRelease={...currentRelease,...release};renderWhatsNewWidget()}).catch(()=>{});
  if(window.firefly?.onUpdateProgress)window.firefly.onUpdateProgress(progress=>{const installing=progress.stage==='installing';updateState={...updateState,status:installing?'installing':'downloading',progress:progress.percent};renderUpdateWidget();if($('#modalLayer').classList.contains('open')&&$('.update-progress')){const fill=$('.update-progress i'),label=$('.update-progress small');if(fill&&progress.percent!=null)fill.style.width=`${progress.percent}%`;if(label)label.textContent=installing?'Installing silently…':progress.percent==null?'Downloading update…':`${progress.percent}% downloaded`}});
  if(window.firefly?.onUpdateReady)window.firefly.onUpdateReady(markUpdateReady);
  checkForUpdates(false);clearInterval(updateCheckTimer);updateCheckTimer=setInterval(()=>checkForUpdates(false),30*60*1000);
}
function setRange(el, value) { el.value = value; el.style.setProperty('--range', `${value}%`); }

const playlistCoverChoices = {
  backgrounds:['aurora','sunset','ocean','prism','noir','vinyl','custom'],
  fonts:['modern','serif','condensed','mono','handwritten'],
  layouts:['center','bottom-left','editorial','vertical'],
  overlays:['none','shimmer','particles','orbit','waves']
};
const playlistCoverPalettes = [
  ['#7755ff','#ff6689'],['#ff704d','#ffc35c'],['#027d92','#63ead7'],
  ['#4056d8','#db58b7'],['#e8d7bd','#392d52'],['#a8ff78','#315b91']
];
function playlistCoverHash(value='') { return [...String(value)].reduce((sum,char)=>sum+char.charCodeAt(0),0); }
function safeCoverChoice(group,value,fallback) { return playlistCoverChoices[group].includes(value)?value:fallback; }
function defaultPlaylistCover(playlist={}) {
  const hash=playlistCoverHash(playlist.id||playlist.title),palette=playlistCoverPalettes[hash%playlistCoverPalettes.length];
  return {background:playlistCoverChoices.backgrounds[hash%6],colorA:playlist.color||palette[0],colorB:palette[1],image:null,font:'modern',layout:['center','bottom-left','editorial'][hash%3],overlay:['shimmer','particles','orbit','waves'][hash%4],title:'',subtitle:''};
}
function playlistCoverDesign(playlist={}) {
  const design={...defaultPlaylistCover(playlist),...(playlist.coverDesign||{})};
  design.background=safeCoverChoice('backgrounds',design.background,'aurora');
  design.font=safeCoverChoice('fonts',design.font,'modern');
  design.layout=safeCoverChoice('layouts',design.layout,'center');
  design.overlay=safeCoverChoice('overlays',design.overlay,'none');
  design.colorA=/^#[0-9a-f]{6}$/i.test(design.colorA||'')?design.colorA:'#7755ff';
  design.colorB=/^#[0-9a-f]{6}$/i.test(design.colorB||'')?design.colorB:'#ff6689';
  return design;
}
function playlistCoverMarkup(playlist,extra='',override=null) {
  const design=override?playlistCoverDesign({...playlist,coverDesign:override}):playlistCoverDesign(playlist);
  const count=playlistTracks(playlist).length,title=design.title?.trim()||playlist.title||'Untitled playlist';
  const subtitle=design.subtitle?.trim()||`${count} song${count===1?'':'s'}`;
  const image=design.image?`--playlist-image:url(&quot;${esc(design.image)}&quot;);`:'';
  return `<div class="playlist-cover playlist-bg-${design.background} playlist-font-${design.font} playlist-layout-${design.layout} playlist-overlay-${design.overlay} ${extra}" style="--cover-a:${design.colorA};--cover-b:${design.colorB};${image}"><span class="playlist-cover-text"><small>${playlist.children?'MASTER PLAYLIST':'PLAYLIST'}</small><b>${esc(title)}</b><em>${esc(subtitle)}</em></span><span class="playlist-cover-motion" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div>`;
}

function playlistPlaybackContext(playlist) {
  return playlist ? { type:'playlist', id:playlist.id } : null;
}
function updatePlayerPlaybackContext() {
  const player=$('#player'),art=$('#playerPlaylistArt'),source=$('#nowPlaylistSource'),link=$('#nowPlaylistLink');
  const playlist=playbackContext?.type==='playlist'?findPlaylistById(playbackContext.id):null;
  const active=Boolean(currentTrack&&playlist);
  player?.classList.toggle('playlist-themed',active);
  if(!active){
    if(art){art.innerHTML='';delete art.dataset.themeSignature}
    if(source)source.hidden=true;
    player?.style.removeProperty('--player-playlist-a');
    player?.style.removeProperty('--player-playlist-b');
    if(playbackContext?.type==='playlist'&&!playlist)playbackContext=null;
    return;
  }
  const design=playlistCoverDesign(playlist);
  player.style.setProperty('--player-playlist-a',design.colorA);
  player.style.setProperty('--player-playlist-b',design.colorB);
  const signature=JSON.stringify([playlist.id,playlist.title,playlistTracks(playlist).length,design]);
  if(art.dataset.themeSignature!==signature){art.innerHTML=playlistCoverMarkup(playlist,'player-playlist-cover');art.dataset.themeSignature=signature}
  source.hidden=false;
  link.textContent=playlist.title;
  link.dataset.playlistId=playlist.id;
  link.title=`Open ${playlist.title}`;
}

function renderSidebarPlaylists() {
  const host = $('#miniPlaylists');
  if (!host) return;
  host.innerHTML = customPlaylists.length ? customPlaylists.slice(0,6).map(p => `<button data-sidebar-playlist="${p.id}">${playlistCoverMarkup(p,'playlist-cover-mini')}<span><b>${esc(p.title)}</b><small>${playlistTracks(p).length} songs</small></span></button>`).join('') : `<div class="sidebar-empty">No playlists yet.<br>Use + to create one.</div>`;
}

function accountDisplayName(){return String(accountState.user?.name||accountIdentity()).trim()||'Ignifire listener'}
function accountInitials(name=accountDisplayName()){
  const words=String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length>1?`${words[0][0]}${words.at(-1)[0]}`:words[0]?.slice(0,1)||'I').toLocaleUpperCase();
}
function updateAccountControl(){
  const button=$('#accountControl');if(!button)return;
  if(accountState.signedIn){const name=accountDisplayName();button.className='avatar account-control';button.textContent=accountInitials(name);button.title=`${name} · Account settings`;button.setAttribute('aria-label',`Open account settings for ${name}`)}
  else{button.className='avatar account-control account-sign-in';button.innerHTML='<span>Sign in</span>';button.title='Sign in to Ignifire';button.setAttribute('aria-label','Open sign-in settings')}
}

function pageHead(eyebrow, title, description, tools = '') {
  return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${tools ? `<div class="head-tools">${tools}</div>`:''}</div>`;
}

function render() {
  // Only the replaceable library view is rebuilt. The audio element, transport,
  // active queue, and playback clock live outside it and continue uninterrupted.
  renderSidebarPlaylists();
  updateAccountControl();
  view.style.animation = 'none';
  requestAnimationFrame(() => { view.style.animation = ''; });
  if (currentView === 'home') renderHome();
  else if (currentView === 'albums') renderAlbums();
  else if (currentView === 'artists') renderArtists();
  else if (currentView.startsWith('album:')) renderAlbumDetail(decodeURIComponent(currentView.slice(6)));
  else if (currentView.startsWith('artist:')) renderArtistDetail(decodeURIComponent(currentView.slice(7)));
  else if (currentView.startsWith('playlist:')) openPlaylist(currentView.slice(9),false);
  else if (currentView === 'songs') renderSongs();
  else if (currentView === 'playlists') renderPlaylists();
  else if (currentView === 'settings') renderSettings();
  else if (currentView === 'suno') renderSuno();
  else if (currentView === 'shelf') renderShelf();
  $('#albumCount').textContent = albums.length;
  $('#songCount').textContent = allTracks().length;
  updateHistoryControls();
  applySelectionClasses();renderBulkSelectionBar();renderQueue();updatePlayingTrackRows();updatePlayerPlaybackContext();
  renderedLibraryRevision=libraryRevision;
}

function albumCover(a, extra = '') {
  const style = a.customCover ? `style="background-image:url('${a.customCover}');background-size:cover;background-position:center"` : '';
  return `<div class="cover ${a.cover || ''} ${extra}" ${style}></div>`;
}
function artistProfileKey(name=''){return String(name).trim().toLocaleLowerCase()}
function artistProfile(name){return artistProfiles[artistProfileKey(name)]||{}}
function artistPortraitClass(name){const score=[...String(name)].reduce((sum,char)=>sum+char.charCodeAt(0),0);return`portrait-${score%6+1}`}
function artistPortraitMarkup(name,extra=''){
  const profile=artistProfile(name),style=profile.image?`style="background-image:url(&quot;${esc(profile.image)}&quot;)"`:'';
  return `<div class="artist-portrait ${profile.image?'has-artist-image':artistPortraitClass(name)} ${profile.animated?'animated-artist-image':''} ${extra}" ${style}></div>`;
}
async function applyArtistDetailTheme(name){
  const root=$('.artist-detail[data-artist-detail]',view),source=artistProfile(name).image;if(!root||!source)return;
  try{
    const image=await new Promise((resolve,reject)=>{const element=new Image();if(/^https?:/i.test(source))element.crossOrigin='anonymous';element.onload=()=>resolve(element);element.onerror=reject;element.src=source});
    const canvas=document.createElement('canvas');canvas.width=48;canvas.height=48;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,48,48);const pixels=context.getImageData(0,0,48,48).data,buckets=new Map();
    for(let index=0;index<pixels.length;index+=16){if(pixels[index+3]<180)continue;const r=pixels[index],g=pixels[index+1],b=pixels[index+2],max=Math.max(r,g,b),min=Math.min(r,g,b),light=(max+min)/510,sat=max===min?0:(max-min)/(255-Math.abs(max+min-255));if(light<.06||light>.92)continue;const key=[r,g,b].map(value=>Math.round(value/32)*32).join(',');buckets.set(key,(buckets.get(key)||0)+.45+sat*2.2)}
    const colors=[...buckets].sort((a,b)=>b[1]-a[1]).map(([key])=>key.split(',').map(Number));if(!colors.length)return;const primary=colors[0],secondary=colors.find(color=>Math.hypot(color[0]-primary[0],color[1]-primary[1],color[2]-primary[2])>90)||colors[1]||primary,toHex=color=>`#${color.map(value=>Math.max(0,Math.min(255,value)).toString(16).padStart(2,'0')).join('')}`;root.style.setProperty('--artist-primary',toHex(primary));root.style.setProperty('--artist-secondary',toHex(secondary));
  }catch{/* The deterministic fallback remains when a remote image blocks sampling. */}
}

function dynamicCaseReady(album) {
  return Boolean(album?.dynamicCaseArt?.enabled && album.dynamicCaseArt?.backgroundUrl && album.dynamicCaseArt?.font?.fileUrl);
}
function applyNewAlbumDefaults(album) {
  if(settings.dynamicArtByDefault&&album?.id!=='loose-files')album.dynamicCaseArt={...(album.dynamicCaseArt||{}),enabled:true,autoGenerate:true,status:album.customCover?(credentials.openaiKey?'queued':'waiting-key'):'waiting-cover'};
  return album;
}
function queueDefaultDynamicCase(album) {
  if(!album?.dynamicCaseArt?.autoGenerate||!album.customCover||!credentials.openaiKey||album.dynamicCaseArt.backgroundUrl)return;
  dynamicDefaultQueue=dynamicDefaultQueue.then(()=>generateDynamicCaseFor(album,{quiet:true})).catch(error=>console.warn('Default Dynamic Case Art failed',error));
}
function dynamicFontName(font) { return font?.id ? `Ignifire Dynamic ${font.id}` : 'Inter'; }
async function activateDynamicFont(album) {
  const font=album?.dynamicCaseArt?.font;
  if(!font?.fileUrl || !('FontFace' in window))return;
  const family=dynamicFontName(font);
  if([...document.fonts].some(face=>face.family===family))return;
  try{const face=new FontFace(family,`url("${font.fileUrl}")`,{weight:'400'});await face.load();document.fonts.add(face)}catch(error){console.warn('Could not activate dynamic case font',error)}
}
async function analyzeCoverVisual(source) {
  if(!source)return{luminance:.5,saturation:.5};
  try{
    const image=await new Promise((resolve,reject)=>{const element=new Image();if(/^https?:/i.test(source))element.crossOrigin='anonymous';element.onload=()=>resolve(element);element.onerror=reject;element.src=source});
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,32,32);
    const pixels=context.getImageData(0,0,32,32).data;let luminance=0,saturation=0;
    for(let index=0;index<pixels.length;index+=4){const r=pixels[index]/255,g=pixels[index+1]/255,b=pixels[index+2]/255,max=Math.max(r,g,b),min=Math.min(r,g,b);luminance+=(r*.2126+g*.7152+b*.0722);saturation+=max?((max-min)/max):0}
    const samples=pixels.length/4;return{luminance:luminance/samples,saturation:saturation/samples};
  }catch{return{luminance:.5,saturation:.5}}
}
function chooseDynamicFont(album,fonts=[],visual={luminance:.5,saturation:.5}) {
  const context=`${album.genre||''} ${album.title||''} ${album.artist||''}`.toLowerCase();
  let preferred='sans';
  if(/classical|jazz|soul|folk|acoustic|blues|orchestra/.test(context))preferred='serif';
  else if(/metal|rock|punk|garage|hardcore/.test(context))preferred='display';
  else if(/electronic|techno|house|ambient|industrial|synth|experimental/.test(context))preferred='mono';
  else if(/singer|songwriter|intimate/.test(context))preferred='handwriting';
  const hash=[...context].reduce((sum,char)=>sum+char.charCodeAt(0),0);
  return [...fonts].sort((left,right)=>{
    const score=font=>Number(font.category===preferred)*100+(font.moods||[]).reduce((total,mood)=>total+Number(context.includes(mood))*25,0)+Number(visual.saturation>.55&&['display','sans'].includes(font.category))*18+Number(visual.luminance<.32&&['serif','mono'].includes(font.category))*14+Number(visual.saturation<.22&&font.category==='serif')*12+((hash+Number(font.id?.slice(-2)||0)*17)%19);
    return score(right)-score(left);
  })[0];
}
function dynamicTrackList(album) {
  return `<ol style="--track-rows:${Math.max(1,Math.ceil(album.tracks.length/2))}">${album.tracks.map((track,index)=>`<li><span>${String(index+1).padStart(2,'0')}</span><b>${esc(track.title)}</b><small>${esc(track.duration||'')}</small></li>`).join('')}</ol>`;
}
function dynamicCaseSectionMarkup(album) {
  const art=album.dynamicCaseArt||{},enabled=Boolean(art.enabled);
  const status={downloading:'Downloading the 24-font studio library…',generating:'GPT Image 2 is painting the back and spine…',ready:'Ready · tracklist stays synchronized automatically',stale:'Front cover changed · regenerate to refresh the case',error:art.error||'Generation failed · try again'}[art.status]||(art.backgroundUrl?'Generated art is cached and ready to enable':'Uses the front cover to create a matching back and spine');
  const background=art.backgroundUrl||album.customCover||'';
  const family=dynamicFontName(art.font);
  return `<section class="dynamic-case-section ${enabled?'enabled':''}" id="dynamicCaseSection" data-album-id="${album.id}"><div class="dynamic-case-heading"><div><span class="dynamic-kicker">AI CASE STUDIO</span><h3>Dynamic Case Art</h3><p>${esc(status)}</p></div><button type="button" class="switch ${enabled?'on':''}" id="dynamicCaseToggle" aria-pressed="${enabled}" ${['downloading','generating'].includes(art.status)?'disabled':''}></button></div>${enabled?`<div class="dynamic-case-preview" style="font-family:'${family}'"><div class="dynamic-back-art" ${background?`style="background-image:url(&quot;${esc(background)}&quot;)"`:''}><span class="dynamic-back-title">${esc(album.artist)}<b>${esc(album.title)}</b></span>${dynamicTrackList(album)}</div><div class="dynamic-spine-art" ${background?`style="background-image:url(&quot;${esc(background)}&quot;)"`:''}><span>${esc(album.artist)} — ${esc(album.title)}</span></div>${albumCover(album,'dynamic-front-art')}</div><div class="dynamic-case-footer"><span>${art.font?`Selected typeface: <b>${esc(art.font.family)}</b> · matched to cover palette and genre`:'Typeface selection begins after the font library downloads.'}</span>${art.backgroundUrl||art.status==='error'?`<button type="button" class="ghost" id="regenerateDynamicCase" ${['downloading','generating'].includes(art.status)?'disabled':''}>${icon('spark')} ${art.status==='error'?'Try again':'Regenerate with AI'}</button>`:''}</div>`:''}</section>`;
}
function refreshDynamicCaseSection(album){const current=$('#dynamicCaseSection');if(!current||current.dataset.albumId!==album.id)return;current.outerHTML=dynamicCaseSectionMarkup(album);bindDynamicCaseControls(album)}
function markDynamicCaseStale(album){if(album.dynamicCaseArt?.enabled&&album.dynamicCaseArt?.backgroundUrl){album.dynamicCaseArt.status='stale';saveLibrary();refreshDynamicCaseSection(album)}}
async function generateDynamicCaseFor(album,{quiet=false}={}) {
  if(!album.customCover){if(!quiet)toast('Add front cover art first','Dynamic Case Art needs an existing cover to extend.');return}
  if(!credentials.openaiKey){if(!quiet)toast('Connect OpenAI first','Save an API key in Settings, then try again.');return}
  if(!window.firefly?.ensureDynamicFonts||!window.firefly?.generateDynamicCaseArt){if(!quiet)toast('Dynamic Case Art requires the Windows app');return}
  album.dynamicCaseArt={...(album.dynamicCaseArt||{}),enabled:true,status:'downloading',error:null};saveLibrary();refreshDynamicCaseSection(album);
  try{
    const library=await window.firefly.ensureDynamicFonts();
    const draft={...album,title:$('#editTitle')?.value.trim()||album.title,artist:$('#editArtist')?.value.trim()||album.artist,genre:$('#editGenre')?.value.trim()||album.genre};
    const visualProfile=await analyzeCoverVisual(album.customCover);
    const font=chooseDynamicFont(draft,library.fonts,visualProfile);
    if(!font)throw new Error('The font studio could not choose a typeface.');
    album.dynamicCaseArt={...album.dynamicCaseArt,font,visualProfile,status:'generating',fontLibrarySize:library.fonts.length};
    await activateDynamicFont(album);saveLibrary();refreshDynamicCaseSection(album);
    const result=await window.firefly.generateDynamicCaseArt({albumId:album.id,title:draft.title,artist:draft.artist,genre:draft.genre,year:album.year,frontCover:album.customCover});
    album.dynamicCaseArt={...album.dynamicCaseArt,...result,enabled:true,status:'ready',error:null};
    await activateDynamicFont(album);saveLibrary();refreshDynamicCaseSection(album);renderSidebarPlaylists();
    if(!quiet)toast('Dynamic Case Art ready',`${font.family} was selected from ${library.fonts.length} downloaded typefaces.`);
  }catch(error){album.dynamicCaseArt={...album.dynamicCaseArt,enabled:true,status:'error',error:error?.message||'Generation failed.'};saveLibrary();refreshDynamicCaseSection(album);if(!quiet)toast('Dynamic Case Art could not be created',album.dynamicCaseArt.error);else throw error}
}
function bindDynamicCaseControls(album){
  const toggle=$('#dynamicCaseToggle');if(!toggle)return;
  toggle.onclick=()=>{if(album.dynamicCaseArt?.enabled){album.dynamicCaseArt.enabled=false;saveLibrary();refreshDynamicCaseSection(album);toast('Dynamic Case Art disabled','Generated files remain cached for later.')}else if(album.dynamicCaseArt?.backgroundUrl&&album.dynamicCaseArt?.font){album.dynamicCaseArt.enabled=true;album.dynamicCaseArt.status=album.dynamicCaseArt.status==='stale'?'stale':'ready';activateDynamicFont(album);saveLibrary();refreshDynamicCaseSection(album)}else generateDynamicCaseFor(album)};
  const regenerate=$('#regenerateDynamicCase');if(regenerate)regenerate.onclick=()=>generateDynamicCaseFor(album);
}

function genreForTrack(track){return String(albumById(track?.albumId)?.genre||'Uncategorized').trim()||'Uncategorized'}
function uniqueTrackList(tracks){return [...new Map(tracks.filter(Boolean).map(track=>[track.id,track])).values()]}
function seededDailyShuffle(items,salt='ignifire'){
  const date=new Date(),key=`${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}-${salt}`;let seed=[...key].reduce((value,char)=>(value*31+char.charCodeAt(0))>>>0,2166136261);
  const random=()=>{seed+=0x6D2B79F5;let result=seed;result=Math.imul(result^result>>>15,result|1);result^=result+Math.imul(result^result>>>7,result|61);return((result^result>>>14)>>>0)/4294967296};
  const output=[...items];for(let index=output.length-1;index>0;index--){const swap=Math.floor(random()*(index+1));[output[index],output[swap]]=[output[swap],output[index]]}return output;
}
function listeningHistoryByTrack(){const grouped=new Map();playHistory.forEach(event=>{if(!grouped.has(event.trackId))grouped.set(event.trackId,[]);grouped.get(event.trackId).push(Number(event.playedAt))});return grouped}
function frequentlyReturnedTracks(tracks=allTracks()){
  const history=listeningHistoryByTrack();return [...tracks].filter(track=>!track.pending).map(track=>{
    const events=(history.get(track.id)||[]).sort((a,b)=>a-b),days=new Set(events.map(time=>new Date(time).toDateString())).size;
    let sessions=events.length?1:0;for(let index=1;index<events.length;index++)if(events[index]-events[index-1]>4*60*60*1000)sessions++;
    return{track,sessions,score:days*35+sessions*18+events.length*4+(Number(track.plays)||0)*2+(track.lastPlayed?Math.max(0,14-(Date.now()-track.lastPlayed)/86400000):0)};
  }).filter(item=>item.sessions>=2||(Number(item.track.plays)||0)>=3).sort((a,b)=>b.score-a.score).map(item=>item.track);
}
function recentlyPlayedTracks(limit=8){
  const library=new Map(allTracks().filter(track=>!track.pending).map(track=>[track.id,track])),recent=[];
  for(let index=playHistory.length-1;index>=0&&recent.length<limit;index--){const track=library.get(playHistory[index].trackId);if(track&&!recent.some(item=>item.id===track.id))recent.push(track)}
  return uniqueTrackList([...recent,...allTracks().filter(track=>!track.pending&&track.lastPlayed).sort((a,b)=>(b.lastPlayed||0)-(a.lastPlayed||0))]).slice(0,limit);
}
function todaysMix(){
  const playable=allTracks().filter(track=>!track.pending);if(!playable.length)return{tracks:[],topGenres:[]};
  const genreStats=new Map();playable.forEach(track=>{const genre=genreForTrack(track),stat=genreStats.get(genre)||{genre,plays:0,count:0};stat.plays+=Number(track.plays)||0;stat.count++;genreStats.set(genre,stat)});
  const hasPlays=[...genreStats.values()].some(stat=>stat.plays>0),topGenres=[...genreStats.values()].sort((a,b)=>(hasPlays?b.plays-a.plays:b.count-a.count)||a.genre.localeCompare(b.genre)).slice(0,3).map(stat=>stat.genre),preferred=new Set(topGenres);
  const least=seededDailyShuffle(playable.filter(track=>preferred.has(genreForTrack(track))).sort((a,b)=>(Number(a.plays)||0)-(Number(b.plays)||0)||(Number(a.lastPlayed)||0)-(Number(b.lastPlayed)||0)).slice(0,Math.max(10,Math.ceil(playable.length*.45))),'least');
  const top=seededDailyShuffle([...playable].sort((a,b)=>(Number(b.plays)||0)-(Number(a.plays)||0)||(Number(b.lastPlayed)||0)-(Number(a.lastPlayed)||0)).slice(0,Math.max(8,Math.ceil(playable.length*.35))),'top');
  const returns=seededDailyShuffle(frequentlyReturnedTracks(playable).slice(0,Math.max(6,Math.ceil(playable.length*.3))),'returns');
  const buckets={least,top,returns},pattern=['least','top','least','returns','top','least','returns'],positions={least:0,top:0,returns:0},mixed=[],target=Math.min(30,playable.length);
  for(let cycle=0;mixed.length<target&&cycle<playable.length*4;cycle++){const key=pattern[cycle%pattern.length],bucket=buckets[key];while(positions[key]<bucket.length&&mixed.some(track=>track.id===bucket[positions[key]].id))positions[key]++;if(positions[key]<bucket.length)mixed.push(bucket[positions[key]++])}
  seededDailyShuffle(playable,'fill').forEach(track=>{if(mixed.length<target&&!mixed.some(item=>item.id===track.id))mixed.push(track)});
  return{tracks:mixed,topGenres};
}
function homeArtwork(track,className=''){
  const album=albumById(track?.albumId),style=album?.customCover?`style="background-image:url(&quot;${esc(album.customCover)}&quot;)"`:'';
  return `<span class="home-art ${album?.cover||'cover-8'} ${className}" ${style}></span>`;
}
function homeTrackCard(track,index=0){return `<button class="home-track-card liquid-reactive" data-home-track="${track.id}" style="--delay:${index*45}ms">${homeArtwork(track)}<span class="home-card-play">${icon('play')}</span><span class="home-track-copy"><b>${esc(track.title)}</b><small>${esc(track.artist)}</small></span></button>`}
function homeTrackRows(tracks){return tracks.map((track,index)=>`<button class="home-list-track" data-home-track="${track.id}"><span class="home-list-number">${String(index+1).padStart(2,'0')}</span>${homeArtwork(track)}<span><b>${esc(track.title)}</b><small>${esc(track.artist)} · ${esc(track.album)}</small></span><em>${track.duration||''}</em></button>`).join('')}
function bindHomeTrackCollection(selector,tracks){const root=$(selector);if(!root)return;$$('[data-home-track]',root).forEach(button=>button.onclick=()=>{const selected=tracks.find(track=>track.id===button.dataset.homeTrack);if(!selected)return;const rest=tracks.filter(track=>track.id!==selected.id);playbackOriginalQueue=[selected,...rest];playbackQueue=[selected,...(shuffleEnabled?shuffledTracks(rest):rest)];playbackQueueExplicit=true;playTrack(selected,true)})}
function bindLiquidReaction(){
  $$('.liquid-reactive',view).forEach(element=>{element.onpointermove=event=>{const rect=element.getBoundingClientRect();element.style.setProperty('--mx',`${(event.clientX-rect.left)/rect.width*100}%`);element.style.setProperty('--my',`${(event.clientY-rect.top)/rect.height*100}%`)};element.onpointerleave=()=>{element.style.removeProperty('--mx');element.style.removeProperty('--my')}});
}
function renderHome(){
  const playable=allTracks().filter(track=>!track.pending),mix=todaysMix(),recent=recentlyPlayedTracks(6),added=[...playable].sort((a,b)=>(Number(b.added)||0)-(Number(a.added)||0)).slice(0,8),backlog=playable.filter(track=>!track.lastPlayed).sort((a,b)=>(Number(a.added)||0)-(Number(b.added)||0)).slice(0,20),returns=frequentlyReturnedTracks(playable).slice(0,6);
  const date=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date()),hour=new Date().getHours(),greeting=hour<12?'Good morning':hour<18?'Good afternoon':'Good evening';
  const mixAlbums=uniqueTrackList(mix.tracks).map(track=>albumById(track.albumId)).filter((album,index,array)=>album&&array.findIndex(item=>item?.id===album.id)===index).slice(0,4);
  const artistStats=new Map();playable.forEach(track=>{const current=artistStats.get(track.artist)||{name:track.artist,plays:0,tracks:0};current.plays+=Number(track.plays)||0;current.tracks++;artistStats.set(track.artist,current)});const topArtists=[...artistStats.values()].sort((a,b)=>b.plays-a.plays||b.tracks-a.tracks).slice(0,4);
  const totalPlays=playable.reduce((sum,track)=>sum+(Number(track.plays)||0),0),heard=playable.filter(track=>track.lastPlayed).length,genreCount=new Set(playable.map(genreForTrack)).size;
  const heroArt=mixAlbums.length?`<div class="today-art-stack">${mixAlbums.map((album,index)=>`<span class="today-cover cover ${album.cover||'cover-8'}" ${album.customCover?`style="background-image:url(&quot;${esc(album.customCover)}&quot;);--cover-index:${index}"`:`style="--cover-index:${index}"`}></span>`).join('')}<span class="today-disc"><i></i></span></div>`:`<div class="today-empty-art"><img class="ignifire-logo-static" src="assets/ignifire-logo.png" alt=""></div>`;
  view.innerHTML=`<section class="home-view"><header class="home-welcome"><div><span class="eyebrow">${esc(date.toUpperCase())}</span><h1>${greeting}.</h1><p>${playable.length?'Your library has been listening. Here is what it found for you.':'Let’s illuminate your music library.'}</p></div></header>
  <section class="today-mix liquid-reactive ${playable.length?'':'empty'}"><div class="today-aurora"><i></i><i></i><i></i></div><div class="today-copy"><span class="today-label">${icon('spark')} MADE FRESH TODAY</span><h2>Today’s Mix</h2><p>${playable.length?`A fluid blend of overlooked ${esc(mix.topGenres.slice(0,2).join(' and ')||'favorites')}, your most-played songs, and the tracks you keep finding your way back to.`:'Import music and Ignifire will build a new personal mix from your listening patterns every day.'}</p><div class="today-actions">${playable.length?`<button class="today-play" id="playTodayMix">${icon('play')} Play mix</button><button class="today-shuffle" id="shuffleTodayMix">${icon('shuffle')} Shuffle</button>`:`<button class="today-play" data-import="files">${icon('upload')} Import music</button><button class="today-shuffle" data-import="folder">${icon('albums')} Import folder</button>`}</div><div class="today-meta"><span>${mix.tracks.length||'—'} tracks</span><i></i><span>${mix.topGenres.length?esc(mix.topGenres.join(' · ')):'Learns entirely on-device'}</span><i></i><span>Refreshes daily</span></div></div>${heroArt}</section>
  ${playable.length?`<section class="home-section"><div class="home-section-head"><div><span class="eyebrow">JUST IN</span><h2>Recently added</h2></div><button data-home-see="added">See all <span>›</span></button></div><div class="home-track-rail" id="homeRecentlyAdded">${added.map(homeTrackCard).join('')}</div></section>
  <div class="home-bento"><section class="home-glass-panel home-recent liquid-reactive"><header><div><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Recently played</h2></div>${icon('song')}</header><div id="homeRecentlyPlayed">${recent.length?homeTrackRows(recent):'<div class="home-panel-empty"><b>Your listening trail starts here</b><span>Played songs will collect in this space.</span></div>'}</div>${recent.length?'<button class="home-panel-link" data-home-see="recent">Open listening history <span>›</span></button>':''}</section>
  <section class="home-glass-panel home-pulse liquid-reactive"><header><div><span class="eyebrow">YOUR LIBRARY</span><h2>Listening pulse</h2></div>${icon('spark')}</header><div class="pulse-metrics"><article><b>${playable.length}</b><span>songs</span></article><article><b>${totalPlays}</b><span>plays</span></article><article><b>${heard}</b><span>heard</span></article><article><b>${genreCount}</b><span>genres</span></article></div><div class="home-top-artists"><span>TOP ARTISTS</span>${topArtists.map((artist,index)=>`<button data-home-artist="${esc(artist.name)}"><i>${index+1}</i><b>${esc(artist.name)}</b><small>${artist.plays} plays</small></button>`).join('')}</div></section>
  <section class="home-glass-panel home-rediscover liquid-reactive"><span class="rediscover-orbit"><i></i><i></i><i></i></span><div><span class="eyebrow">REDISCOVER</span><h2>${backlog.length?'Something unheard is waiting.':'Keep the favorites glowing.'}</h2><p>${backlog.length?`${backlog.length} track${backlog.length===1?' has':'s have'} never been played. Start somewhere unexpected.`:returns.length?'Return to the songs that keep pulling you back.':'Every play makes tomorrow’s recommendations more personal.'}</p></div><button id="playRediscover">${icon('shuffle')} ${backlog.length?'Explore the backlog':'Play return favorites'}</button></section></div>
  ${returns.length?`<section class="home-section"><div class="home-section-head"><div><span class="eyebrow">MAGNETIC</span><h2>You always come back to these</h2></div></div><div class="home-track-rail return-rail" id="homeReturns">${returns.map(homeTrackCard).join('')}</div></section>`:''}`:`<div class="home-empty-grid"><article class="home-glass-panel liquid-reactive">${icon('spark')}<h3>Personal mixes</h3><p>Today’s Mix evolves from plays, genres, and the songs you revisit.</p></article><article class="home-glass-panel liquid-reactive">${icon('albums')}<h3>Your collection, alive</h3><p>Recently added and recently played music will surface automatically.</p></article><article class="home-glass-panel liquid-reactive">${icon('shelf')}<h3>Built around you</h3><p>Everything is calculated locally from your own library.</p></article></div>`}</section>`;
  if($('#playTodayMix'))$('#playTodayMix').onclick=()=>playTrackQueue(mix.tracks);if($('#shuffleTodayMix'))$('#shuffleTodayMix').onclick=()=>playTrackQueue(mix.tracks,true);
  bindHomeTrackCollection('#homeRecentlyAdded',added);bindHomeTrackCollection('#homeRecentlyPlayed',recent);bindHomeTrackCollection('#homeReturns',returns);
  $$('[data-home-see]',view).forEach(button=>button.onclick=()=>openTrackCollection(button.dataset.homeSee==='recent'?'Recently played':'Recently added',button.dataset.homeSee==='recent'?recent:added));
  $$('[data-home-artist]',view).forEach(button=>button.onclick=()=>navigate(`artist:${encodeURIComponent(button.dataset.homeArtist)}`));
  if($('#playRediscover'))$('#playRediscover').onclick=()=>playTrackQueue(backlog.length?backlog:returns,true);bindLiquidReaction();
}

function renderAlbums(filter = '') {
  currentView = 'albums';
  const q = filter.trim().toLowerCase(),mode=settings.albumFilter||'all',viewMode=settings.albumView||'grid',recentCutoff=Date.now()-90*24*60*60*1000;
  let shown = albums.filter(a => `${a.title} ${a.artist} ${a.genre}`.toLowerCase().includes(q));
  if(mode==='recent')shown=shown.filter(album=>Math.max(...album.tracks.map(track=>Number(track.added)||0),0)>=recentCutoff).sort((a,b)=>Math.max(...b.tracks.map(track=>Number(track.added)||0),0)-Math.max(...a.tracks.map(track=>Number(track.added)||0),0));
  if(mode==='downloaded')shown=shown.filter(album=>album.tracks.some(track=>Boolean(track.path)&&!track.pending));
  if(mode==='favorites')shown=shown.filter(album=>album.favorite||album.tracks.some(track=>track.favorite));
  const gridMarkup=`<div class="album-grid">${shown.map((a,i)=>`<article class="album-card" data-album="${a.id}" style="animation-delay:${i*35}ms"><div class="album-art-wrap">${albumCover(a)}${albumCloudBadge(a)}${a.favorite?'<span class="album-favorite-badge">♥</span>':''}<button class="quick-play" data-play-album="${a.id}" aria-label="Play ${esc(a.title)}">${icon('play')}</button></div><h3>${esc(a.title)}</h3><p>${esc(a.artist)} · ${a.year}</p><button class="more" data-edit-album="${a.id}" aria-label="Edit album">${icon('more')}</button></article>`).join('')}</div>`;
  const listMarkup=`<div class="album-list-view">${shown.map(a=>`<article class="album-list-row" data-album="${a.id}">${albumCover(a,'album-list-cover')}<span class="album-list-copy"><b>${esc(a.title)}</b><small>${esc(a.artist)} · ${a.year}</small></span>${albumCloudBadge(a)}<span>${a.tracks.length} tracks</span><span>${esc(a.genre||'Uncategorized')}</span><button class="quick-play" data-play-album="${a.id}" aria-label="Play ${esc(a.title)}">${icon('play')}</button><button class="row-action" data-edit-album="${a.id}" aria-label="Edit album">${icon('more')}</button></article>`).join('')}</div>`;
  view.innerHTML = pageHead('YOUR LIBRARY','Albums',`${albums.length} albums · ${allTracks().length} songs`,
    `<button class="icon-button ${viewMode==='grid'?'active':''}" data-album-view="grid" title="Grid view">${icon('grid')}</button><button class="icon-button ${viewMode==='list'?'active':''}" data-album-view="list" title="Album list">${icon('list')}</button>`) +
    `<div class="filter-row"><button class="chip ${mode==='all'?'active':''}" data-album-filter="all">All albums</button><button class="chip ${mode==='recent'?'active':''}" data-album-filter="recent">Recently added</button><button class="chip ${mode==='downloaded'?'active':''}" data-album-filter="downloaded">Downloaded</button><button class="chip ${mode==='favorites'?'active':''}" data-album-filter="favorites">Favorites</button></div>` +
    (shown.length ? (viewMode==='list'?listMarkup:gridMarkup) : `<div class="empty-state">${icon('albums')}<h2>${q?'No albums found':mode==='favorites'?'No favorite albums yet':mode==='recent'?'Nothing added recently':'No albums in this view'}</h2><p>${q?'Try another title, artist, or genre.':mode==='favorites'?'Right-click an album or favorite one of its tracks to collect it here.':mode==='recent'?'Albums imported in the last 90 days appear here.':'Try another filter or import more music.'}</p>${!q&&mode==='all'?`<div class="empty-actions"><button class="primary" data-import="files">${icon('upload')} Import files</button><button class="ghost" data-import="folder">${icon('albums')} Import folder</button></div>`:''}</div>`);
  $$('[data-album-view]',view).forEach(button=>button.onclick=()=>{settings.albumView=button.dataset.albumView;saveLibrary();renderAlbums(filter)});
  $$('[data-album-filter]',view).forEach(button=>button.onclick=()=>{settings.albumFilter=button.dataset.albumFilter;saveLibrary();renderAlbums(filter)});
  applySelectionClasses();renderBulkSelectionBar();
}

function renderArtists(filter = '') {
  const seen = new Map();
  albums.forEach(a => seen.set(a.artist,{name:a.artist,albums:albums.filter(x=>x.artist===a.artist).length}));
  const artists = [...seen.values()].filter(a=>a.name.toLowerCase().includes(filter.toLowerCase()));
  view.innerHTML = pageHead('YOUR LIBRARY','Artists',`${artists.length} artists in your collection`) + (artists.length ? `<div class="artist-grid">${artists.map(a=>`<button class="artist-card" data-artist="${esc(a.name)}">${artistPortraitMarkup(a.name)}<h3>${esc(a.name)}</h3><p>${a.albums} album${a.albums===1?'':'s'} · Followed</p></button>`).join('')}</div>` : `<div class="empty-state">${icon('artist')}<h2>No artists yet</h2><p>Artists appear automatically when you import music.</p></div>`);
  $$('.artist-card',view).forEach(el=>el.onclick=()=>openArtistDetail(el.dataset.artist));
}

function openAlbumDetail(id){navigate(`album:${encodeURIComponent(id)}`)}
function openArtistDetail(name){navigate(`artist:${encodeURIComponent(name)}`)}
const albumDetailPalettes=[['#7b3457','#e76c58'],['#213a66','#6e65d9'],['#174b49','#5cc3a5'],['#5c3425','#d89358'],['#3d315f','#ca6eac'],['#353535','#a49078']];
function albumDetailFallbackPalette(album){return albumDetailPalettes[playlistCoverHash(album.id||album.title)%albumDetailPalettes.length]}
async function applyAlbumDetailTheme(album){
  const root=$(`.album-detail[data-album="${CSS.escape(album.id)}"]`,view);if(!root)return;
  const source=album.customCover||album.fullArtParts?.front||'';if(!source)return;
  try{
    const image=await new Promise((resolve,reject)=>{const element=new Image();if(/^https?:/i.test(source))element.crossOrigin='anonymous';element.onload=()=>resolve(element);element.onerror=reject;element.src=source});
    const canvas=document.createElement('canvas');canvas.width=48;canvas.height=48;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,48,48);
    const pixels=context.getImageData(0,0,48,48).data,buckets=new Map();
    for(let index=0;index<pixels.length;index+=16){if(pixels[index+3]<180)continue;const r=pixels[index],g=pixels[index+1],b=pixels[index+2],max=Math.max(r,g,b),min=Math.min(r,g,b),light=(max+min)/510,sat=max===min?0:(max-min)/(255-Math.abs(max+min-255));if(light<.08||light>.9)continue;const key=[r,g,b].map(value=>Math.round(value/32)*32).join(',');buckets.set(key,(buckets.get(key)||0)+.5+sat*2)}
    const colors=[...buckets].sort((a,b)=>b[1]-a[1]).map(([key])=>key.split(',').map(Number));if(!colors.length)return;
    const primary=colors[0],secondary=colors.find(color=>Math.hypot(color[0]-primary[0],color[1]-primary[1],color[2]-primary[2])>105)||colors[1]||primary;
    const toHex=color=>`#${color.map(value=>Math.max(0,Math.min(255,value)).toString(16).padStart(2,'0')).join('')}`;root.style.setProperty('--album-primary',toHex(primary));root.style.setProperty('--album-secondary',toHex(secondary));
  }catch{/* The fallback palette still styles remote art that blocks canvas sampling. */}
}
function renderAlbumDetail(id){
  const album=albumById(id);if(!album){navigate('albums',{record:false});return}
  const isOpen=openedAlbumCases.has(id),dynamic=dynamicCaseReady(album)?album.dynamicCaseArt:null;
  const backArt=album.fullArtParts?.back||album.customFullArt||dynamic?.backgroundUrl||album.customCover||'';
  const discArt=album.customCover||album.fullArtParts?.front||'';
  const themeArt=album.customCover||album.fullArtParts?.front||'',palette=albumDetailFallbackPalette(album),themeStyle=`--album-primary:${palette[0]};--album-secondary:${palette[1]};${themeArt?`--album-art:url(&quot;${esc(themeArt)}&quot;);`:''}`;
  view.innerHTML=`<section class="entity-detail album-detail ${themeArt?'has-album-art-theme':'generated-album-theme'}" data-album="${album.id}" style="${themeStyle}"><span class="album-detail-atmosphere" aria-hidden="true"></span><button class="detail-back" data-detail-back>${icon('prev')} All albums</button><div class="album-detail-hero"><div class="detail-case-stage"><button class="album-detail-case ${isOpen?'open':''}" data-detail-case aria-expanded="${isOpen}" aria-label="${isOpen?'Close':'Open'} ${esc(album.title)} jewel case"><span class="album-detail-case-back" ${backArt?`style="background-image:linear-gradient(#08080830,#08080830),url(&quot;${esc(backArt)}&quot;)"`:''}>${dynamic?`<span class="detail-back-copy" style="font-family:'${dynamicFontName(dynamic.font)}'">${dynamicTrackList(album)}</span>`:''}<i class="detail-disc" ${discArt?`style="--detail-disc:url(&quot;${esc(discArt)}&quot;)"`:''}></i></span><span class="album-detail-lid"><span class="detail-lid-front">${albumCover(album,'detail-cover')}</span><span class="detail-lid-inside"><b>${esc(album.title)}</b><small>${esc(album.artist)} · ${album.year}</small><ol>${album.tracks.slice(0,18).map(t=>`<li>${esc(t.title)}</li>`).join('')}</ol></span></span></button><p class="case-toggle-hint">Click the jewel case to ${isOpen?'close':'open'} it</p></div><div class="album-detail-copy"><div class="eyebrow">ALBUM · ${esc(album.genre||'UNCATEGORIZED')}</div><h1>${esc(album.title)}</h1><button class="artist-byline" data-open-artist="${esc(album.artist)}">${esc(album.artist)}</button><p>${album.year} · ${album.tracks.length} track${album.tracks.length===1?'':'s'} · ${album.tracks.reduce((sum,t)=>sum+(parseInt(t.duration)||0),0)}+ minutes</p><div class="detail-actions"><button class="primary" data-detail-play>${icon('play')} Play album</button><button class="ghost" data-detail-shuffle>${icon('shuffle')} Shuffle</button><button class="ghost" data-detail-add-playlist>${icon('playlist')} Add to playlist</button><button class="icon-button" data-detail-edit title="Edit album">${icon('settings')}</button></div></div></div><div class="detail-track-section album-themed-tracklist"><div><div class="eyebrow">TRACK LIST</div><h2>On this album</h2></div>${songTable(album.tracks)}</div></section>`;
  applyAlbumDetailTheme(album);
  const albumCloud=albumCloudState(album);
  if(albumCloud.cloud){$('[data-detail-edit]').insertAdjacentHTML('beforebegin',`<button class="ghost" data-detail-cloud-download>${icon(albumCloud.downloaded?'close':'download')} ${albumCloud.downloaded?'Remove download':'Download album'}</button>`);$('[data-detail-cloud-download]').onclick=()=>setCloudDownload(album.tracks,!albumCloud.downloaded)}
  $('[data-detail-back]').onclick=()=>navigate('albums');
  $('[data-open-artist]').onclick=()=>openArtistDetail(album.artist);
  $('[data-detail-case]').onclick=()=>{openedAlbumCases.has(id)?openedAlbumCases.delete(id):openedAlbumCases.add(id);const caseElement=$('[data-detail-case]'),opened=openedAlbumCases.has(id);caseElement.classList.toggle('open',opened);caseElement.setAttribute('aria-expanded',String(opened));caseElement.setAttribute('aria-label',`${opened?'Close':'Open'} ${album.title} jewel case`);$('.case-toggle-hint').textContent=`Click the jewel case to ${opened?'close':'open'} it`};
  $('[data-detail-play]').onclick=()=>playTrackQueue(album.tracks);
  $('[data-detail-shuffle]').onclick=()=>playTrackQueue(album.tracks,true);
  $('[data-detail-add-playlist]').onclick=()=>addAlbumToPlaylist(album);
  $('[data-detail-edit]').onclick=()=>editAlbum(id);
}
function renderArtistDetail(name){
  const artistAlbums=albums.filter(album=>album.artist===name);if(!artistAlbums.length){navigate('artists',{record:false});return}
  const tracks=artistAlbums.flatMap(album=>album.tracks),profile=artistProfile(name),fallback=albumDetailPalettes[playlistCoverHash(name)%albumDetailPalettes.length];
  view.innerHTML=`<section class="entity-detail artist-detail ${profile.image?'has-artist-theme':'generated-artist-theme'}" data-artist-detail="${esc(name)}" style="--artist-primary:${fallback[0]};--artist-secondary:${fallback[1]};${profile.image?`--artist-page-image:url(&quot;${esc(profile.image)}&quot;);`:''}"><span class="artist-detail-atmosphere" aria-hidden="true"></span><button class="detail-back" data-detail-back>${icon('prev')} All artists</button><div class="artist-detail-hero" data-artist="${esc(name)}" ${profile.image?`style="--artist-hero:url(&quot;${esc(profile.image)}&quot;)"`:''}><div class="artist-hero-glow"></div>${artistPortraitMarkup(name,'artist-portrait-large')}<div class="artist-detail-copy"><div class="eyebrow">ARTIST</div><h1>${esc(name)}</h1><p>${artistAlbums.length} album${artistAlbums.length===1?'':'s'} · ${tracks.length} song${tracks.length===1?'':'s'}${profile.sourceUrl?` · <a href="${esc(profile.sourceUrl)}" target="_blank" rel="noreferrer">Image source</a>`:''}</p><div class="detail-actions"><button class="primary" data-artist-play>${icon('play')} Play</button><button class="ghost" data-artist-shuffle>${icon('shuffle')} Shuffle</button><button class="ghost" data-artist-image>${icon('image')} ${profile.image?'Change image':'Add image'}</button></div></div></div><section class="artist-albums"><div class="section-heading"><div><div class="eyebrow">DISCOGRAPHY</div><h2>Albums</h2></div></div><div class="album-grid">${artistAlbums.map((album,index)=>`<article class="album-card" data-album="${album.id}" style="animation-delay:${index*35}ms"><div class="album-art-wrap">${albumCover(album)}${albumCloudBadge(album)}<button class="quick-play" data-play-album="${album.id}" aria-label="Play ${esc(album.title)}">${icon('play')}</button></div><h3>${esc(album.title)}</h3><p>${album.year} · ${album.tracks.length} tracks</p><button class="more" data-edit-album="${album.id}" aria-label="Edit album">${icon('more')}</button></article>`).join('')}</div></section><section class="detail-track-section artist-themed-tracklist"><div><div class="eyebrow">ALL SONGS</div><h2>Popular tracks</h2></div>${songTable([...tracks].sort((a,b)=>(b.plays||0)-(a.plays||0)))}</section></section>`;
  applyArtistDetailTheme(name);
  $('[data-detail-back]').onclick=()=>navigate('artists');
  $('[data-artist-play]').onclick=()=>playTrackQueue(tracks);
  $('[data-artist-shuffle]').onclick=()=>playTrackQueue(tracks,true);
  $('[data-artist-image]').onclick=()=>editArtistImage(name);
}

function renderSongs(filter = '') {
  const q=filter.toLowerCase(),collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});
  const tracks = allTracks().filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  const sorters={
    'plays-desc':(a,b)=>(Number(b.plays)||0)-(Number(a.plays)||0)||collator.compare(a.title,b.title),
    'plays-asc':(a,b)=>(Number(a.plays)||0)-(Number(b.plays)||0)||collator.compare(a.title,b.title),
    'added-desc':(a,b)=>(Number(b.added)||0)-(Number(a.added)||0)||collator.compare(a.title,b.title),
    'added-asc':(a,b)=>(Number(a.added)||0)-(Number(b.added)||0)||collator.compare(a.title,b.title),
    'title-asc':(a,b)=>collator.compare(a.title,b.title)||collator.compare(a.artist,b.artist),
    'artist-asc':(a,b)=>collator.compare(a.artist,b.artist)||collator.compare(a.title,b.title)
  };
  tracks.sort(sorters[settings.songSort]||sorters['added-desc']);
  const sortOptions=[['plays-desc','Most played'],['plays-asc','Least played'],['added-desc','Last added'],['added-asc','First added'],['title-asc','Song A–Z'],['artist-asc','Artist A–Z']];
  view.innerHTML = pageHead('YOUR LIBRARY','Songs',`${tracks.length} tracks · ${Math.round(tracks.length*3.8/60)} hr ${Math.round(tracks.length*3.8%60)} min`,`<label class="song-sort"><span>Sort by</span><select id="songSort">${sortOptions.map(([value,label])=>`<option value="${value}" ${settings.songSort===value?'selected':''}>${label}</option>`).join('')}</select></label>`) + (tracks.length ? songTable(tracks) : `<div class="empty-state">${icon('song')}<h2>No songs yet</h2><p>Import files or a music folder to add your first tracks.</p><div class="empty-actions"><button class="primary" data-import="files">${icon('upload')} Import files</button><button class="ghost" data-import="folder">${icon('albums')} Import folder</button></div></div>`);
  if($('#songSort'))$('#songSort').onchange=e=>{settings.songSort=e.target.value;saveLibrary();renderSongs(filter)};
  applySelectionClasses();renderBulkSelectionBar();
}
function songTable(tracks,{draggable=false,playlistId=''}={}) {
  tracks=settings.showPendingTracks?tracks:tracks.filter(track=>!track.pending);
  return `<table class="song-table"><thead><tr><th>#</th><th>TITLE</th><th>ALBUM</th><th>PLAYS</th><th>TIME</th><th></th></tr></thead><tbody>${tracks.map((t,i)=>{
    const a=albumById(t.albumId)||{cover:'cover-8'},active=!t.pending&&currentTrack?.id===t.id;
    return `<tr class="${t.pending?'pending-row':''} ${draggable?'playlist-draggable-track':''} ${active?'current-playing-track':''} ${active&&isPlaying?'is-playing':''}" data-track="${t.id}" ${draggable?`draggable="true" data-playlist-track="${t.id}" data-playlist-id="${playlistId}"`:''}><td class="track-index-cell">${draggable?`<span class="playlist-track-grip" title="Drag to reorder">⋮⋮</span>`:''}${t.pending?'—':`<span class="track-list-number">${i+1}</span><span class="playing-now-equalizer" role="img" aria-label="${active&&isPlaying?'Playing now':'Current track'}"><i></i><i></i><i></i><i></i></span>`}</td><td><div class="song-title"><div class="thumb ${a.cover}" ${a.customCover?`style="background-image:url('${a.customCover}');background-size:cover"`:''}></div><span><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span>${cloudTrackBadge(t)}${t.pending?'<i class="pending-badge">PENDING</i>':''}</div></td><td>${esc(t.album)}</td><td>${t.pending?'—':t.plays}</td><td>${t.pending?'—':t.duration}</td><td><button class="row-action" data-row-action="${t.id}">${icon('more')}</button></td></tr>`;
  }).join('')}</tbody></table>`;
}
function updatePlayingTrackRows(){
  $$('tr[data-track]').forEach(row=>{
    const active=Boolean(currentTrack&&row.dataset.track===currentTrack.id&&!row.classList.contains('pending-row'));
    row.classList.toggle('current-playing-track',active);
    row.classList.toggle('is-playing',active&&isPlaying);
    const equalizer=row.querySelector('.playing-now-equalizer');
    if(equalizer)equalizer.setAttribute('aria-label',active&&isPlaying?'Playing now':active?'Current track':'');
  });
}

function renderPlaylists() {
  view.innerHTML = pageHead('LISTEN YOUR WAY','Playlists','Drag one playlist onto another to create a master playlist.',`<button class="ghost" data-action="new-playlist">${icon('plus')} New playlist</button>`) +
  `<div class="playlist-layout"><div>${customPlaylists.length?`<div class="playlist-grid">${customPlaylists.map(p=>`<button class="playlist-card" draggable="true" data-playlist-card="${p.id}" style="--card-color:${p.color}">${playlistCoverMarkup(p,'playlist-card-cover')}<span class="playlist-card-copy"><small>${p.children?'MASTER PLAYLIST':'PLAYLIST'}</small><h3>${esc(p.title)}</h3><p>${p.children?`${p.children.length} sub-playlists · `:''}${playlistTracks(p).length} songs</p></span><span class="stack">${p.children?'◫':'♫'}</span></button>`).join('')}</div>`:`<div class="empty-state">${icon('playlist')}<h2>No playlists yet</h2><p>Create one, or import a screenshot to get started.</p><div class="empty-actions"><button class="primary" data-action="new-playlist">${icon('plus')} New playlist</button></div></div>`}</div>
  <aside><h2 class="side-heading">SMART PLAYLISTS</h2><div class="smart-list">
    <button class="smart-card todays-smart" data-smart="today"><span class="smart-icon">✦</span><span><h3>Today’s Mix</h3><p>Your daily personal blend</p></span><b>${todaysMix().tracks.length}</b></button>
    <button class="smart-card" data-smart="backlog"><span class="smart-icon">◌</span><span><h3>The Backlog</h3><p>Added, but never played</p></span><b>${allTracks().filter(t=>!t.lastPlayed).length}</b></button>
    <button class="smart-card" data-smart="old"><span class="smart-icon">↶</span><span><h3>The Old Bangers</h3><p>Old favorites due a replay</p></span><b>${allTracks().filter(isOldBanger).length}</b></button>
    <button class="smart-card" data-smart="hits"><span class="smart-icon">↗</span><span><h3>The Hits</h3><p>Your top 50 tracks</p></span><b>${Math.min(50,allTracks().length)}</b></button>
  </div><div class="screenshot-cta">${icon('camera')}<h3>Screenshot to playlist</h3><p>Drop in a playlist screenshot. Ignifire identifies every track.</p><button class="primary" id="screenshotTrigger">Choose screenshot</button></div></aside></div>`;
  bindPlaylistDrag();
  $('#screenshotTrigger').onclick = () => $('#screenshotInput').click();
  $$('.smart-card',view).forEach(btn => btn.onclick = () => {
    const type=btn.dataset.smart; let tracks=allTracks();
    if(type==='today')tracks=todaysMix().tracks;if(type==='backlog') tracks=tracks.filter(t=>!t.lastPlayed); if(type==='old') tracks=tracks.filter(isOldBanger); if(type==='hits') tracks=tracks.sort((a,b)=>(Number(b.plays)||0)-(Number(a.plays)||0)).slice(0,50);
    openTrackCollection(btn.querySelector('h3').textContent, tracks);
  });
}

function bindPlaylistDrag() {
  $$('[data-playlist-card]',view).forEach(card=>{
    card.addEventListener('dragstart',()=>{draggedPlaylist=card.dataset.playlistCard;card.style.opacity='.4'});
    card.addEventListener('dragend',()=>{card.style.opacity='';$$('.drag-over').forEach(x=>x.classList.remove('drag-over'))});
    card.addEventListener('dragover',e=>{e.preventDefault();card.classList.add('drag-over')});
    card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
    card.addEventListener('drop',e=>{e.preventDefault();const target=card.dataset.playlistCard;if(draggedPlaylist&&target!==draggedPlaylist) openMasterPlaylistModal(draggedPlaylist,target)});
    card.addEventListener('click',()=>openPlaylist(card.dataset.playlistCard));
  });
}

function openPlaylist(id,record=true) {
  const playlist = findPlaylistById(id);
  if (!playlist) return;
  const parent = playlistParentById(id);
  if(record&&currentView!==`playlist:${id}`){viewBackStack.push(currentView);viewForwardStack=[];clearBulkSelection()}
  currentView = `playlist:${id}`;
  $$('#primaryNav button,.sidebar-bottom button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view==='playlists'));
  const tracks = sortedPlaylistTracks(playlist),sortMode=playlistSortMode(playlist);
  const subPlaylistList=playlist.children?`<section class="master-subplaylists"><div class="section-heading"><div><span class="eyebrow">INSIDE THIS MASTER</span><h2>Sub-playlists</h2></div><small>${playlist.children.length} collection${playlist.children.length===1?'':'s'}</small></div><div class="master-subplaylist-list">${playlist.children.map((child,index)=>{const childTracks=playlistTracks(child),playable=childTracks.some(track=>!track.pending);return `<article class="master-subplaylist" style="--sub-color:${child.color||playlist.color||'var(--accent)'}"><button class="subplaylist-main" data-open-subplaylist="${child.id}"><span class="subplaylist-number">${String(index+1).padStart(2,'0')}</span><span class="subplaylist-icon">${child.children?'◫':'♫'}</span><span><b>${esc(child.title)}</b><small>${childTracks.length} songs${child.children?` · ${child.children.length} nested playlists`:''}</small></span></button><button class="subplaylist-play" data-play-subplaylist="${child.id}" aria-label="Play ${esc(child.title)}" ${playable?'':'disabled'}>${icon('play')}</button></article>`}).join('')}</div></section>`:'';
  const trackList=tracks.length?`${playlist.children?`<div class="master-track-heading"><span class="eyebrow">COMPLETE MASTER PLAYLIST</span><h2>All tracks</h2></div>`:''}${songTable(tracks,{draggable:!playlist.children,playlistId:id})}`:`<div class="empty-state">${icon('song')}<h2>This playlist is empty</h2><p>Import tracks directly into a sub-playlist, or add tracks from their right-click menu.</p></div>`;
  view.innerHTML = `<button class="ghost" id="backToPlaylists" style="margin-bottom:18px">‹ ${parent?esc(parent.title):'All playlists'}</button><div class="playlist-detail-head">${playlistCoverMarkup(playlist,'playlist-detail-cover')}<div><div class="eyebrow">${playlist.children?'MASTER PLAYLIST':'PLAYLIST'}</div><h1>${esc(playlist.title)}</h1><p>${tracks.length} songs${playlist.children?` · ${playlist.children.length} sub-playlists`:''}</p></div></div><div class="playlist-detail-actions"><button class="primary" id="playPlaylist">${icon('play')} ${playlist.children?'Play All':'Play'}</button><button class="ghost" id="shufflePlaylist">${icon('shuffle')} Shuffle</button><label class="playlist-sort-control"><span>Sort</span><select id="playlistSort">${Object.entries(playlistSortLabels).map(([value,label])=>`<option value="${value}" ${sortMode===value?'selected':''}>${label}</option>`).join('')}</select></label><button class="ghost" id="customizePlaylistCover">${icon('image')} Customize cover</button>${playlist.children?'':`<button class="ghost" id="addPlaylistTracks">${icon('plus')} Add imported tracks</button>`}</div>${subPlaylistList}${trackList}`;
  $('#backToPlaylists').onclick=()=>parent?historyBack():navigate('playlists');
  $('#playPlaylist').onclick=()=>playTrackQueue(tracks,false,playlistPlaybackContext(playlist));
  $('#shufflePlaylist').onclick=()=>playTrackQueue(tracks,true,playlistPlaybackContext(playlist));
  $('#playlistSort').onchange=event=>{playlist.sortMode=event.target.value;saveLibrary();openPlaylist(id,false);toast('Playlist sorted',playlistSortLabels[playlist.sortMode])};
  $('#customizePlaylistCover').onclick=()=>playlistCoverStudio(id);
  $$('[data-open-subplaylist]',view).forEach(button=>button.onclick=()=>openPlaylist(button.dataset.openSubplaylist));
  $$('[data-play-subplaylist]',view).forEach(button=>button.onclick=event=>{event.stopPropagation();const child=findPlaylistById(button.dataset.playSubplaylist);playTrackQueue(sortedPlaylistTracks(child),false,playlistPlaybackContext(child))});
  if($('#addPlaylistTracks'))$('#addPlaylistTracks').onclick=()=>{playlistImportTarget=id;chooseFiles()};
  if(!playlist.children)bindPlaylistTrackDrag(playlist,tracks);
  applySelectionClasses();renderBulkSelectionBar();
  updateHistoryControls();
}
function bindPlaylistTrackDrag(playlist,visibleTracks){
  $$('[data-playlist-track]',view).forEach(row=>{
    row.addEventListener('dragstart',event=>{draggedPlaylistTrack=row.dataset.playlistTrack;row.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedPlaylistTrack)});
    row.addEventListener('dragend',()=>{draggedPlaylistTrack=null;row.classList.remove('dragging');$$('.playlist-track-drop-target',view).forEach(item=>item.classList.remove('playlist-track-drop-target'))});
    row.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';if(row.dataset.playlistTrack!==draggedPlaylistTrack)row.classList.add('playlist-track-drop-target')});
    row.addEventListener('dragleave',()=>row.classList.remove('playlist-track-drop-target'));
    row.addEventListener('drop',event=>{event.preventDefault();const targetId=row.dataset.playlistTrack;if(!draggedPlaylistTrack||draggedPlaylistTrack===targetId)return;const currentMode=playlistSortMode(playlist);if(currentMode!=='manual'){const visibleIds=visibleTracks.map(track=>track.id),remaining=(playlist.trackIds||[]).filter(id=>!visibleIds.includes(id));playlist.trackIds=[...visibleIds,...remaining];playlist.sortMode='manual'}const from=playlist.trackIds.indexOf(draggedPlaylistTrack),to=playlist.trackIds.indexOf(targetId);if(from<0||to<0)return;const[moved]=playlist.trackIds.splice(from,1);playlist.trackIds.splice(to,0,moved);saveLibrary();openPlaylist(playlist.id,false);toast('Playlist order updated',currentMode==='manual'?'Manual order saved':'Switched to manual order')});
  });
}

function renamePlaylist(id) {
  const playlist=findPlaylistById(id);if(!playlist)return;
  openModal(`<div class="modal-head"><h2>Edit playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>PLAYLIST NAME</label><input id="renamePlaylistInput" value="${esc(playlist.title)}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="savePlaylistName">Save</button></div>`,true);
  $('#savePlaylistName').onclick=()=>{playlist.title=$('#renamePlaylistInput').value.trim()||playlist.title;saveLibrary();closeModal();currentView.startsWith('playlist:')?openPlaylist(id):render();toast('Playlist updated')};
}

function playlistCoverStudio(id) {
  const playlist=findPlaylistById(id);if(!playlist)return;
  let draft={...playlistCoverDesign(playlist)};
  const backgroundLabels={aurora:'Aurora',sunset:'Sunset',ocean:'Ocean',prism:'Prism',noir:'Noir',vinyl:'Vinyl',custom:'Your image'};
  const fontLabels={modern:'Modern',serif:'Editorial',condensed:'Condensed',mono:'Mono',handwritten:'Handwritten'};
  const layoutLabels={center:'Centered', 'bottom-left':'Lower left',editorial:'Editorial',vertical:'Vertical'};
  const overlayLabels={none:'Still',shimmer:'Shimmer',particles:'Particles',orbit:'Orbit',waves:'Waves'};
  openModal(`<div class="modal-head cover-studio-head"><div><span class="eyebrow">PLAYLIST COVER CREATOR</span><h2>Design “${esc(playlist.title)}”</h2></div><button class="close-modal">${icon('close')}</button></div><div class="modal-body cover-studio-body"><section class="cover-studio-stage"><div id="coverStudioPreview"></div><div class="cover-studio-stage-tools"><button class="ghost" id="randomizePlaylistCover">${icon('spark')} Surprise me</button><span>Animations play anywhere this cover appears.</span></div></section><section class="cover-studio-controls">
    <div class="cover-control-group"><label>BACKGROUND</label><div class="cover-choice-grid cover-background-choices">${playlistCoverChoices.backgrounds.map(value=>`<button data-cover-background="${value}"><i class="playlist-bg-${value}" style="--cover-a:${draft.colorA};--cover-b:${draft.colorB};${value==='custom'&&draft.image?`--playlist-image:url(&quot;${esc(draft.image)}&quot;)`:''}"></i><span>${backgroundLabels[value]}</span></button>`).join('')}</div></div>
    <div class="cover-control-group cover-color-row"><label><span>PRIMARY COLOR</span><input type="color" id="playlistCoverColorA" value="${draft.colorA}"></label><label><span>SECONDARY COLOR</span><input type="color" id="playlistCoverColorB" value="${draft.colorB}"></label><label class="cover-upload-button">${icon('upload')} Upload artwork<input type="file" id="playlistCoverUpload" accept="image/*"></label><button class="ghost" id="removePlaylistCoverImage" ${draft.image?'':'disabled'}>Remove image</button></div>
    <div class="cover-control-group"><label>TYPEFACE</label><div class="cover-pill-grid">${playlistCoverChoices.fonts.map(value=>`<button class="playlist-font-${value}" data-cover-font="${value}">${fontLabels[value]}</button>`).join('')}</div></div>
    <div class="cover-control-group"><label>TEXT LAYOUT</label><div class="cover-pill-grid cover-layout-grid">${playlistCoverChoices.layouts.map(value=>`<button data-cover-layout="${value}"><i class="layout-symbol layout-symbol-${value}"></i>${layoutLabels[value]}</button>`).join('')}</div></div>
    <div class="cover-control-group"><label>ANIMATED OVERLAY</label><div class="cover-pill-grid">${playlistCoverChoices.overlays.map(value=>`<button data-cover-overlay="${value}">${overlayLabels[value]}</button>`).join('')}</div></div>
    <div class="cover-text-fields"><div class="field"><label>COVER TITLE <small>Leave blank to follow the playlist name</small></label><input id="playlistCoverTitle" value="${esc(draft.title||'')}" placeholder="${esc(playlist.title)}"></div><div class="field"><label>SUBTITLE <small>Leave blank for the song count</small></label><input id="playlistCoverSubtitle" value="${esc(draft.subtitle||'')}" placeholder="${playlistTracks(playlist).length} songs"></div></div>
  </section></div><div class="modal-actions cover-studio-actions"><button class="ghost" id="resetPlaylistCover">Reset design</button><span></span><button class="ghost close-modal">Cancel</button><button class="primary" id="savePlaylistCover">Save cover</button></div>`);
  $('.modal',modalLayer)?.classList.add('cover-studio-modal');
  const updatePreview=()=>{
    $('#coverStudioPreview').innerHTML=playlistCoverMarkup(playlist,'playlist-cover-studio-preview',draft);
    $$('[data-cover-background]',modalLayer).forEach(button=>button.classList.toggle('selected',button.dataset.coverBackground===draft.background));
    $$('[data-cover-font]',modalLayer).forEach(button=>button.classList.toggle('selected',button.dataset.coverFont===draft.font));
    $$('[data-cover-layout]',modalLayer).forEach(button=>button.classList.toggle('selected',button.dataset.coverLayout===draft.layout));
    $$('[data-cover-overlay]',modalLayer).forEach(button=>button.classList.toggle('selected',button.dataset.coverOverlay===draft.overlay));
    $$('.cover-background-choices i',modalLayer).forEach(swatch=>{swatch.style.setProperty('--cover-a',draft.colorA);swatch.style.setProperty('--cover-b',draft.colorB)});
    const customSwatch=$('[data-cover-background="custom"] i',modalLayer);if(draft.image)customSwatch.style.setProperty('--playlist-image',`url("${String(draft.image).replace(/["\\]/g,'\\$&')}")`);else customSwatch.style.removeProperty('--playlist-image');
    $('#removePlaylistCoverImage').disabled=!draft.image;
  };
  $$('[data-cover-background]',modalLayer).forEach(button=>button.onclick=()=>{draft.background=button.dataset.coverBackground;if(draft.background==='custom'&&!draft.image)$('#playlistCoverUpload').click();updatePreview()});
  $$('[data-cover-font]',modalLayer).forEach(button=>button.onclick=()=>{draft.font=button.dataset.coverFont;updatePreview()});
  $$('[data-cover-layout]',modalLayer).forEach(button=>button.onclick=()=>{draft.layout=button.dataset.coverLayout;updatePreview()});
  $$('[data-cover-overlay]',modalLayer).forEach(button=>button.onclick=()=>{draft.overlay=button.dataset.coverOverlay;updatePreview()});
  $('#playlistCoverColorA').oninput=event=>{draft.colorA=event.target.value;updatePreview()};
  $('#playlistCoverColorB').oninput=event=>{draft.colorB=event.target.value;updatePreview()};
  $('#playlistCoverTitle').oninput=event=>{draft.title=event.target.value;updatePreview()};
  $('#playlistCoverSubtitle').oninput=event=>{draft.subtitle=event.target.value;updatePreview()};
  $('#playlistCoverUpload').onchange=event=>{const file=event.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{draft.image=reader.result;draft.background='custom';updatePreview()};reader.readAsDataURL(file)};
  $('#removePlaylistCoverImage').onclick=()=>{draft.image=null;if(draft.background==='custom')draft.background='aurora';updatePreview()};
  $('#randomizePlaylistCover').onclick=()=>{const palette=playlistCoverPalettes[Math.floor(Math.random()*playlistCoverPalettes.length)];draft={...draft,background:playlistCoverChoices.backgrounds[Math.floor(Math.random()*6)],colorA:palette[0],colorB:palette[1],font:playlistCoverChoices.fonts[Math.floor(Math.random()*playlistCoverChoices.fonts.length)],layout:playlistCoverChoices.layouts[Math.floor(Math.random()*playlistCoverChoices.layouts.length)],overlay:playlistCoverChoices.overlays.slice(1)[Math.floor(Math.random()*4)]};$('#playlistCoverColorA').value=draft.colorA;$('#playlistCoverColorB').value=draft.colorB;updatePreview()};
  $('#resetPlaylistCover').onclick=()=>{draft={...defaultPlaylistCover(playlist)};$('#playlistCoverColorA').value=draft.colorA;$('#playlistCoverColorB').value=draft.colorB;$('#playlistCoverTitle').value='';$('#playlistCoverSubtitle').value='';updatePreview()};
  $('#savePlaylistCover').onclick=()=>{playlist.coverDesign={...draft,title:draft.title?.trim()||'',subtitle:draft.subtitle?.trim()||''};playlist.color=draft.colorA;saveLibrary();closeModal();currentView===`playlist:${id}`?openPlaylist(id,false):render();toast('Playlist cover saved',`${backgroundLabels[draft.background]} · ${overlayLabels[draft.overlay]}`)};
  updatePreview();
}

function confirmRemove(title, detail, action) {
  if(!settings.confirmDeletes){action();return}
  openModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p style="color:#98938d;margin:0">${esc(detail)}</p></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="confirmRemove" style="background:#e55f4c;color:white">Remove</button></div>`,true);
  $('#confirmRemove').onclick=()=>{action();closeModal()};
}

function showContextMenu(items, x, y) {
  const menu=$('#contextMenu');
  menu.innerHTML=items.map((item,i)=>item.separator?'<hr>':`<button role="menuitem" class="${item.danger?'danger':''}" data-context-item="${i}">${item.icon?icon(item.icon):''}${esc(item.label)}</button>`).join('');
  menu.classList.add('open');menu.setAttribute('aria-hidden','false');
  const width=215,height=items.length*39+14;
  menu.style.left=`${Math.max(8,Math.min(x,innerWidth-width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-height-8))}px`;
  $$('[data-context-item]',menu).forEach(btn=>btn.onclick=()=>{const item=items[Number(btn.dataset.contextItem)];hideContextMenu();item.action?.()});
}
function hideContextMenu(){const menu=$('#contextMenu');menu.classList.remove('open');menu.setAttribute('aria-hidden','true')}

function playlistContext(id, x, y) {
  const playlist=findPlaylistById(id);if(!playlist)return;
  showContextMenu([
    {label:'Open playlist',icon:'playlist',action:()=>openPlaylist(id)},
    {label:'Play',icon:'play',action:()=>playTrackQueue(sortedPlaylistTracks(playlist),false,playlistPlaybackContext(playlist))},
    {label:'Customize cover',icon:'image',action:()=>playlistCoverStudio(id)},
    {label:'Rename',icon:'settings',action:()=>renamePlaylist(id)},
    {separator:true},
    {label:'Delete playlist',icon:'close',danger:true,action:()=>confirmRemove('Delete playlist?',`“${playlist.title}” will be removed. Your music files will not be deleted.`,()=>{customPlaylists=customPlaylists.filter(p=>p.id!==id);saveLibrary();navigate('playlists');toast('Playlist removed')})}
  ],x,y);
}

function albumContext(id,x,y) {
  const album=albumById(id);if(!album)return;const cloud=albumCloudState(album);
  showContextMenu([
    {label:'Open album',icon:'albums',action:()=>openAlbumDetail(id)},
    {label:'Play album',icon:'play',action:()=>playTrackQueue(album.tracks)},
    {label:'Play next',icon:'next',action:()=>queueTracksNext(album.tracks,album.title)},
    {label:'Add album to playlist',icon:'playlist',action:()=>addAlbumToPlaylist(album)},
    {label:album.favorite?'Remove album favorite':'Favorite album',icon:'spark',action:()=>{album.favorite=!album.favorite;saveLibrary();render();toast(album.favorite?'Album favorited':'Album unfavorited',album.title)}},
    {label:'Edit album',icon:'settings',action:()=>editAlbum(id)},
    {label:'Pull metadata & art',icon:'spark',action:()=>metadataLookup(album)},
    {label:'Find full case art',icon:'image',action:()=>caseArtLookup(album)},
    ...(cloud.cloud?[{label:cloud.downloaded?'Remove cloud download':'Download cloud album',icon:cloud.downloaded?'close':'download',action:()=>setCloudDownload(album.tracks,!cloud.downloaded)}]:[]),
    {separator:true},
    {label:'Remove from library',icon:'close',danger:true,action:()=>confirmRemove('Remove album?',`“${album.title}” and its tracks will be removed from Ignifire. Source files stay untouched.`,()=>{const ids=new Set(album.tracks.map(t=>t.id));albums=albums.filter(a=>a.id!==id);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,ids));saveLibrary();render();toast('Album removed')})}
  ],x,y);
}

function artistContext(name,x,y) {
  const artistAlbums=albums.filter(a=>a.artist===name),tracks=artistAlbums.flatMap(a=>a.tracks);
  showContextMenu([
    {label:'Open artist',icon:'artist',action:()=>openArtistDetail(name)},
    {label:'Play artist',icon:'play',action:()=>playTrackQueue(tracks)},
    {label:'Edit artist image',icon:'image',action:()=>editArtistImage(name)},
    {label:'Rename artist',icon:'settings',action:()=>{openModal(`<div class="modal-head"><h2>Rename artist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>ARTIST NAME</label><input id="artistName" value="${esc(name)}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="saveArtist">Save</button></div>`,true);$('#saveArtist').onclick=()=>{const next=$('#artistName').value.trim()||name,oldKey=artistProfileKey(name),nextKey=artistProfileKey(next);artistAlbums.forEach(a=>{a.artist=next;a.tracks.forEach(t=>t.artist=next)});if(oldKey!==nextKey&&artistProfiles[oldKey]){artistProfiles[nextKey]={...artistProfiles[oldKey],...(artistProfiles[nextKey]||{})};delete artistProfiles[oldKey]}saveLibrary();closeModal();currentView=`artist:${encodeURIComponent(next)}`;renderArtistDetail(next);toast('Artist updated')}}},
    {separator:true},
    {label:'Remove artist',icon:'close',danger:true,action:()=>confirmRemove('Remove artist?',`All ${artistAlbums.length} albums by “${name}” will be removed from Ignifire. Source files stay untouched.`,()=>{const ids=new Set(tracks.map(t=>t.id));albums=albums.filter(a=>a.artist!==name);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,ids));delete artistProfiles[artistProfileKey(name)];saveLibrary();navigate('artists');toast('Artist removed')})}
  ],x,y);
}

function addAlbumToPlaylist(album) {
  const destinations=leafPlaylists();
  if(!destinations.length){toast('Create a playlist first');return}
  openModal(`<div class="modal-head"><h2>Add album to playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">Add all ${album.tracks.length} tracks from <b>${esc(album.title)}</b>.</p><div class="detected-list">${destinations.map(playlist=>`<button class="detected-track" data-add-album-to-playlist="${playlist.id}" style="background:transparent;color:inherit;text-align:left"><i class="status-dot"></i><span><b>${esc(playlist.title)}</b><small>${playlistTracks(playlist).length} songs</small></span><em>ADD ALBUM</em></button>`).join('')}</div></div>`,true);
  $$('[data-add-album-to-playlist]',modalLayer).forEach(button=>button.onclick=()=>{const playlist=findPlaylistById(button.dataset.addAlbumToPlaylist);playlist.trackIds=playlist.trackIds||[];let added=0;album.tracks.forEach(track=>{if(!playlist.trackIds.includes(track.id)){playlist.trackIds.push(track.id);added++}});saveLibrary();closeModal();toast(added?'Album added to playlist':'Album already in playlist',added?`${added} tracks added to ${playlist.title}`:playlist.title)});
}

function editArtistImage(name){
  const profile=artistProfile(name);
  openModal(`<div class="modal-head"><h2>Artist image</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="artist-image-editor"><label class="artist-image-slot ${profile.image?'has-image':''}">${profile.image?`<img src="${profile.image}" alt="${esc(name)}">`:artistPortraitMarkup(name,'artist-editor-fallback')}<span>${icon('upload')} Choose an image or GIF</span><input type="file" id="artistImageUpload" accept="image/*,.gif"></label><div><div class="eyebrow">${esc(name)}${profile.animated?' · ANIMATED':''}</div><h3>Artist portrait</h3><p>Use a still image or animated GIF. Ignifire crops it responsively throughout the artist library and fullscreen player.</p><button class="primary" id="findArtistImage">${icon('spark')} Find images</button><button class="ghost" id="findAnimatedArtistImage">${icon('image')} Find animated GIFs</button>${profile.image?`<button class="ghost" id="removeArtistImage">Remove image</button>`:''}</div></div></div><div class="modal-actions"><button class="ghost close-modal">Done</button></div>`);
  bindArtUpload('#artistImageUpload',data=>{artistProfiles[artistProfileKey(name)]={...profile,image:data,animated:/^data:image\/gif/i.test(data),sourceUrl:null,sourceLabel:/^data:image\/gif/i.test(data)?'Custom GIF':'Custom upload'};saveLibrary();closeModal();render();toast('Artist image updated',name)});
  $('#findArtistImage').onclick=()=>artistImageLookup(name);
  $('#findAnimatedArtistImage').onclick=()=>artistImageLookup(name,true);
  if($('#removeArtistImage'))$('#removeArtistImage').onclick=()=>{delete artistProfiles[artistProfileKey(name)];saveLibrary();closeModal();render();toast('Artist image removed',name)};
}
async function searchWikimediaArtistImages(name){
    const searchParams=new URLSearchParams({action:'wbsearchentities',search:name,language:'en',limit:'12',format:'json',origin:'*'});
    const searchResponse=await fetch(`https://www.wikidata.org/w/api.php?${searchParams}`);if(!searchResponse.ok)throw new Error('Wikidata search is unavailable.');
    const search=(await searchResponse.json()).search||[];
    const likely=search.filter(item=>/singer|musician|band|rapper|composer|artist|duo|group|producer|songwriter|performer/i.test(item.description||''));
    const candidates=(likely.length?likely:search).slice(0,8);if(!candidates.length)throw new Error('No matching artists were found.');
    const entityParams=new URLSearchParams({action:'wbgetentities',ids:candidates.map(item=>item.id).join('|'),props:'claims|labels|descriptions',languages:'en',format:'json',origin:'*'});
    const entityResponse=await fetch(`https://www.wikidata.org/w/api.php?${entityParams}`);if(!entityResponse.ok)throw new Error('Artist details could not be loaded.');
    const entities=(await entityResponse.json()).entities||{};
    const pictured=candidates.map(item=>{const entity=entities[item.id],file=entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;return file?{id:item.id,file,label:entity.labels?.en?.value||item.label||name,description:entity.descriptions?.en?.value||item.description||'Wikimedia Commons'}:null}).filter(Boolean);
    if(!pictured.length)throw new Error('No reusable artist photos were found for this search.');
    const commonsParams=new URLSearchParams({action:'query',titles:pictured.map(item=>`File:${item.file}`).join('|'),prop:'imageinfo',iiprop:'url',iiurlwidth:'900',format:'json',origin:'*'});
    const commonsResponse=await fetch(`https://commons.wikimedia.org/w/api.php?${commonsParams}`);if(!commonsResponse.ok)throw new Error('Wikimedia images could not be loaded.');
    const pages=Object.values((await commonsResponse.json()).query?.pages||{});
    const byFile=new Map(pages.map(page=>[String(page.title||'').replace(/^File:/i,'').replaceAll('_',' '),page.imageinfo?.[0]]));
    return pictured.map(item=>{const info=byFile.get(item.file.replaceAll('_',' '));return info?{...item,image:info.thumburl||info.url,sourceUrl:info.descriptionurl||`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(item.file.replaceAll(' ','_'))}`,sourceLabel:'Wikimedia Commons'} : null}).filter(item=>item?.image).slice(0,6);
}
async function artistImageLookup(name,animatedOnly=false){
  if(!settings.onlineArtistImages){toast('Artist-image lookup is disabled','Enable it under Settings · Privacy & control.');return}
  openModal(`<div class="modal-head"><h2>${animatedOnly?'Finding animated artist GIFs':'Finding artist images'}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status"><span class="spinner"></span><span>${animatedOnly?'Searching GIPHY for exact artist, singer, and band matches, plus Wikimedia and Tenor':'Searching Wikimedia Commons, Deezer, TheAudioDB, and animated GIF sources'} for ${esc(name)}…</span></div></div>`);
  const searches=await Promise.allSettled([...(animatedOnly?[]:[searchWikimediaArtistImages(name)]),window.firefly?.searchArtistImages?window.firefly.searchArtistImages(name,{animatedOnly}):Promise.resolve([])]);
  const combined=searches.flatMap(result=>result.status==='fulfilled'?result.value:[]),seen=new Set();
  const results=combined.filter(result=>{if(!result?.image||(animatedOnly&&!result.animated))return false;const key=String(result.image).replace(/^https?:/,'').replace(/[?#].*$/,'').toLowerCase();if(seen.has(key))return false;seen.add(key);return true}).slice(0,animatedOnly?30:24);
  if(!results.length){openModal(`<div class="modal-head"><h2>No ${animatedOnly?'animated GIF':'artist image'} found</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">No reusable ${animatedOnly?'animated artist GIFs':'artist images'} were found for ${esc(name)}. Try a shorter or alternate artist name.</p></div><div class="modal-actions"><button class="ghost close-modal">Close</button><button class="primary" id="retryArtistImage">Try again</button></div>`,true);$('#retryArtistImage').onclick=()=>artistImageLookup(name,animatedOnly);return}
  const sourceNames=[...new Set(results.map(result=>result.sourceLabel).filter(Boolean))];
  openModal(`<div class="modal-head"><h2>Choose ${animatedOnly?'an animated GIF':'an artist image'}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status">${icon('spark')}<span>${results.length} options from ${esc(sourceNames.join(', '))}</span></div><div class="artist-image-results">${results.map((result,index)=>`<button data-artist-image-choice="${index}" class="${result.animated?'animated-result':''}"><span style="background-image:url(&quot;${esc(result.image)}&quot;)"></span><b>${esc(result.label||name)}</b><small>${esc(result.sourceLabel||'Online source')} · ${esc(result.description||'Artist image')}</small></button>`).join('')}</div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button></div>`);
  $$('[data-artist-image-choice]',modalLayer).forEach(button=>button.onclick=async()=>{const result=results[Number(button.dataset.artistImageChoice)];button.disabled=true;button.classList.add('loading');try{const cached=window.firefly?.cacheArtistImage?await window.firefly.cacheArtistImage({artist:name,url:result.image}):{imageUrl:result.image,animated:result.animated};artistProfiles[artistProfileKey(name)]={image:cached.imageUrl,animated:Boolean(cached.animated||result.animated),sourceUrl:result.sourceUrl,sourceLabel:result.sourceLabel||'Online source',cachedAt:cached.cachedAt};saveLibrary();closeModal();render();toast(result.animated?'Animated artist image saved':'Artist image updated',`${name} · ${result.sourceLabel||'online'} · available offline`)}catch(error){button.disabled=false;button.classList.remove('loading');toast('Could not save artist image',error.message)}});
}

function addTrackToPlaylist(track) {
  const destinations=leafPlaylists();if(!destinations.length){toast('Create a playlist first');return}
  openModal(`<div class="modal-head"><h2>Add to playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="detected-list">${destinations.map(p=>`<button class="detected-track" data-add-to-playlist="${p.id}" style="background:transparent;color:inherit;text-align:left"><i class="status-dot"></i><span><b>${esc(p.title)}</b><small>${playlistTracks(p).length} songs</small></span><em>ADD</em></button>`).join('')}</div></div>`,true);
  $$('[data-add-to-playlist]',modalLayer).forEach(btn=>btn.onclick=()=>{const p=findPlaylistById(btn.dataset.addToPlaylist);p.trackIds=p.trackIds||[];if(!p.trackIds.includes(track.id))p.trackIds.push(track.id);saveLibrary();closeModal();toast('Added to playlist',p.title)});
}

function trackContext(track,x,y) {
  showContextMenu([
    {label:'Play',icon:'play',action:()=>playTrack(track)},
    {label:'Play next',icon:'next',action:()=>queueTracksNext([track],track.title)},
    {label:'Add to playlist',icon:'playlist',action:()=>addTrackToPlaylist(track)},
    {label:track.favorite?'Remove from favorites':'Add to favorites',icon:'spark',action:()=>setTrackFavorite(track)},
    {label:'Edit track',icon:'settings',action:()=>showTrackMenu(track)},
    ...(isCloudTrack(track)?[{label:isCloudDownloaded(track)?'Remove cloud download':'Download cloud track',icon:isCloudDownloaded(track)?'close':'download',action:()=>setCloudDownload([track],!isCloudDownloaded(track))}]:[]),
    {separator:true},
    {label:'Remove from library',icon:'close',danger:true,action:()=>confirmRemove('Remove track?',`“${track.title}” will be removed from Ignifire. The source file stays untouched.`,()=>{const album=albumById(track.albumId);if(album)album.tracks=album.tracks.filter(t=>t.id!==track.id);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,new Set([track.id])));albums=albums.filter(a=>a.tracks.length||a.id!=='loose-files');saveLibrary();render();toast('Track removed')})}
  ],x,y);
}

function nowPlayingContext(x,y) {
  if(!currentTrack){toast('Nothing is playing');return}
  const album=albumById(currentTrack.albumId);
  showContextMenu([
    {label:'Add to playlist',icon:'playlist',action:()=>addTrackToPlaylist(currentTrack)},
    ...(album?[{label:'Open album',icon:'albums',action:()=>openAlbumDetail(album.id)}]:[]),
    {label:'Open artist',icon:'artist',action:()=>openArtistDetail(currentTrack.artist)},
    {label:'Edit track',icon:'settings',action:()=>showTrackMenu(currentTrack)},
    {separator:true},
    {label:'View queue',icon:'list',action:openQueue}
  ],x,y);
}

function settingToggle(key,title,description){return `<div class="setting-row"><div><b>${title}</b><small>${description}</small></div><button class="switch ${settings[key]?'on':''}" data-setting-toggle="${key}" aria-pressed="${Boolean(settings[key])}"></button></div>`}
function settingSelect(key,title,description,options){return `<div class="setting-row"><div><b>${title}</b><small>${description}</small></div><select data-setting-select="${key}">${options.map(([value,label])=>`<option value="${value}" ${String(settings[key])===String(value)?'selected':''}>${label}</option>`).join('')}</select></div>`}
function settingRange(key,title,description,min,max,step=1,suffix=''){return `<div class="setting-row"><div><b>${title}</b><small>${description}</small></div><span class="setting-range"><input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}" data-setting-range="${key}" style="--range:${(Number(settings[key])-min)/(max-min)*100}%"><output>${settings[key]}${suffix}</output></span></div>`}
function discordPresenceConfig(){return {enabled:settings.discordRichPresence,showTrack:settings.discordShowTrack,showAlbum:settings.discordShowAlbum,showPaused:settings.discordShowPaused,timeDisplay:settings.discordTimeDisplay,shareArtwork:settings.discordShareArtwork,showButton:settings.discordShowButton}}
function discordStatusCopy(){
  if(!settings.discordRichPresence)return ['disabled','Off','Enable sharing when you want Ignifire to appear on Discord.'];
  const labels={connected:['connected','Connected','Discord is receiving your current Ignifire playback.'],connecting:['connecting','Connecting','Looking for the Discord desktop app…'],unavailable:['warning','Waiting for Discord',discordPresenceState.error||'Open the Discord desktop app and Ignifire will reconnect automatically.'],error:['warning','Connection error',discordPresenceState.error||'Open Discord and try reconnecting.']};
  return labels[discordPresenceState.status]||labels.connecting;
}
function updateDiscordStatusView(){
  const element=$('#discordPresenceStatus');if(!element)return;
  const [kind,title,detail]=discordStatusCopy();element.className=`discord-presence-status ${kind}`;element.innerHTML=`<i></i><span><b>${esc(title)}</b><small>${esc(detail)}</small></span>`;
}
async function configureDiscordPresence(notify=false){
  if(!window.firefly?.configureDiscordPresence)return;
  discordPresenceState={status:settings.discordRichPresence?'connecting':'disabled',error:''};updateDiscordStatusView();
  try{discordPresenceState=await window.firefly.configureDiscordPresence(discordPresenceConfig())||discordPresenceState}
  catch(error){discordPresenceState={status:'error',error:error.message||'Discord could not be configured.'}}
  updateDiscordStatusView();
  if(notify){const [,title,detail]=discordStatusCopy();toast(title,detail)}
}
function discordSettingsMarkup(){return `<div class="settings-section discord-settings-section"><div class="settings-section-heading"><span><small class="discord-kicker">DISCORD</small><h3>Rich Presence</h3></span></div>${settingToggle('discordRichPresence','Share listening activity','Show the current track, artist, album, and playback state on your Discord profile')}${settingToggle('discordShowTrack','Show track title','Share the title of the song that is playing')}${settingToggle('discordShowAlbum','Show album name','Include the album alongside the artist')}${settingToggle('discordShowPaused','Show paused status','Keep Rich Presence visible while playback is paused')}${settingSelect('discordTimeDisplay','Playback timer','Choose whether Discord shows elapsed or remaining time',[['elapsed','Elapsed time'],['remaining','Time remaining'],['off','Hidden']])}${settingToggle('discordShareArtwork','Share online album artwork','Use HTTPS cover artwork when Discord supports the source')}${settingToggle('discordShowButton','Show Ignifire button','Add a button linking friends to the Ignifire project')}<div class="setting-row discord-status-row"><div id="discordPresenceStatus" class="discord-presence-status"><i></i><span><b>Status</b><small>Checking the connection…</small></span></div><button class="ghost" id="reconnectDiscord">Reconnect</button></div></div>`}
function accountIdentity(){const user=accountState.user||{};return user.email&&!/@phone\.(?:firefly|ignifire)\.invalid$/i.test(String(user.email))?user.email:user.phoneNumber||user.name||'Ignifire listener'}
function accountSettingsMarkup(){
  const used=Number(accountState.storageUsed)||0,limit=Number(accountState.storageLimit)||ACCOUNT_STORAGE_LIMIT_BYTES,percent=Math.min(100,used/Math.max(1,limit)*100),identity=accountIdentity();
  if(!accountState.signedIn)return `<header class="account-settings-header"><span class="eyebrow">IGNIFIRE ACCOUNT</span><h2>Your library, wherever you listen</h2><p>Sign in securely with email, phone, password, a one-time code, or a passkey.</p></header><div class="settings-section account-intro-section"><div class="account-orbit"><i></i><i></i><i></i><span>${icon('spark')}</span></div><p>Playlists, library metadata, settings, artwork, listening history, and available music files can follow your account. Cloud backup stays off until you enable it.</p><div class="account-actions"><button class="primary" id="accountSignIn">Sign in</button><button class="ghost" id="accountCreate">Create account</button></div></div><div class="settings-section"><h3>Connect this app</h3><div class="setting-row"><div><b>Browser connection code</b><small>After signing in securely in your browser, paste the short-lived code here</small></div><span class="account-code-entry"><input id="accountConnectionCode" type="text" placeholder="Paste code" autocomplete="one-time-code"><button class="ghost" id="accountClaimCode">Connect</button></span></div></div>`;
  const syncDetail=accountSyncState.status==='syncing'?(accountSyncState.phase==='snapshot'?'Finishing encrypted library backup…':accountSyncState.totalTracks?`Uploading tracks · ${Math.min(Number(accountSyncState.uploadedTracks)||0,Number(accountSyncState.totalTracks))} of ${accountSyncState.totalTracks}`:'Preparing cloud backup…'):accountSyncState.status==='error'?esc(accountSyncState.error||'Sync could not finish'):accountSyncState.status==='synced'?`Protected backup updated${accountSyncState.syncedAt?` · ${new Date(accountSyncState.syncedAt).toLocaleString()}`:''}`:settings.cloudSyncEnabled?'Changes sync automatically in the background':'Cloud sync is disabled';
  return `<header class="account-settings-header signed-in"><span class="eyebrow">IGNIFIRE ACCOUNT</span><h2>${esc(accountState.user?.name||'Your cloud library')}</h2><p>${esc(identity)} · connected securely</p></header><div class="settings-section"><div class="account-profile-row"><span class="account-avatar">${esc((accountState.user?.name||identity).slice(0,1).toUpperCase())}</span><span><b>${esc(accountState.user?.name||identity)}</b><small>${esc(identity)}</small></span><button class="ghost" id="accountManagePasskeys">Manage passkeys ↗</button></div>${settingToggle('cloudSyncEnabled','Cloud backup & sync','Back up Ignifire data and download the newest library after signing in on another PC')}<div class="account-storage"><span><b>${formatStorage(used)} used</b><small>${formatStorage(limit)} included with this account</small></span><em>${Math.round(percent)}%</em><i><u style="width:${percent}%"></u></i></div><div class="setting-row"><div><b>Sync status</b><small>${syncDetail}</small></div><span class="account-sync-actions"><button class="ghost" id="accountRestore">Download cloud copy</button><button class="primary" id="accountSyncNow" ${settings.cloudSyncEnabled?'':'disabled'}>Sync now</button></span></div><div class="setting-row"><div><b>Sign out on this PC</b><small>Local music and settings stay on this computer</small></div><button class="ghost danger" id="accountSignOut">Sign out</button></div></div>`;
}
async function openAccountPortal(mode='signin'){
  try{await window.firefly.openAccountPortal({mode});toast('Continue in your browser',mode==='passkeys'?'Add or remove passkeys, then return to Ignifire.':'Choose email, phone, password, one-time code, or passkey.')}
  catch(error){toast('Could not open account portal',error.message)}
}
async function claimAccountConnection(){
  const input=$('#accountConnectionCode'),code=input?.value.trim();if(!code){input?.focus();toast('Paste the browser connection code');return}
  const button=$('#accountClaimCode');button.disabled=true;button.textContent='Connecting…';
  try{const result=await window.firefly.claimAccountCode({code});accountState={...accountState,...result.account,status:'ready'};if(result.cloud)applyCloudState(result.cloud,{notify:false});saveLibrary();renderSettings();toast('Ignifire account connected',result.cloud?'Your cloud library has been downloaded.':'Cloud backup is ready when you enable it.')}
  catch(error){button.disabled=false;button.textContent='Connect';toast('Could not connect account',error.message)}
}
async function syncAccountNow(){
  accountSyncState={status:'syncing'};renderSettings();
  try{const result=await window.firefly.syncAccountNow(currentLibraryState());applyCloudSyncResult(result);accountSyncState={status:'synced',...result};accountState.storageUsed=Number(result.storageUsed)||accountState.storageUsed;accountState.storageLimit=Number(result.storageLimit)||accountState.storageLimit;renderSettings();toast('Cloud backup updated',`${formatStorage(accountState.storageUsed)} of ${formatStorage(accountState.storageLimit)} used.`)}
  catch(error){accountSyncState={status:'error',error:error.message};renderSettings();toast('Cloud sync failed',error.message)}
}
async function restoreAccountCloud(){
  try{const payload=await window.firefly.restoreAccountCloud();if(!payload){toast('No cloud backup yet');return}applyCloudState(payload)}catch(error){toast('Could not download cloud library',error.message)}
}
function updateStatusText(){return updateState.status==='available'?`Version ${esc(updateState.version)} is available`:updateState.status==='error'?esc(updateState.error||'Update check failed'):updateState.status==='checking'?'Checking GitHub now…':updateState.status==='downloading'?'Downloading in the background…':updateState.status==='installing'?'Verifying and preparing…':updateState.status==='ready'?'Ready · restart to apply':'Ignifire checks when it opens and every 30 minutes'}
function settingsPanelMarkup(tab){
  if(tab==='appearance')return `<header><span class="eyebrow">APPEARANCE</span><h2>Shape the entire interface</h2><p>Color, scale, spacing, surfaces, and motion update immediately.</p></header>
    <div class="settings-section"><h3>Color & surfaces</h3><div class="setting-row"><div><b>Accent color</b><small>Used for actions, progress, focus, and ambient light</small></div><span class="accent-swatches"><button class="${settings.accent==='#f55f45'?'active':''}" data-accent="#f55f45" data-rgb="245,95,69" style="--swatch:#f55f45"></button><button class="${settings.accent==='#9b7bff'?'active':''}" data-accent="#9b7bff" data-rgb="155,123,255" style="--swatch:#9b7bff"></button><button class="${settings.accent==='#53d6b6'?'active':''}" data-accent="#53d6b6" data-rgb="83,214,182" style="--swatch:#53d6b6"></button><button class="${settings.accent==='#f2b84b'?'active':''}" data-accent="#f2b84b" data-rgb="242,184,75" style="--swatch:#f2b84b"></button><label class="custom-accent" title="Custom accent"><input id="customAccent" type="color" value="${settings.accent}"></label></span></div>${settingSelect('theme','Base theme','Choose the darkness and warmth of Ignifire’s canvas',[['midnight','Midnight'],['oled','OLED black'],['charcoal','Warm charcoal']])}${settingToggle('glassEffects','Liquid glass effects','Blur and translucency across panels, menus, and navigation')}${settingToggle('ambient','Animated background','Slow reactive color fields across the app')}${settingToggle('highContrast','High contrast','Stronger borders, text, and control separation')}</div>
    <div class="settings-section"><h3>Layout & scale</h3>${settingRange('uiScale','Interface scale','Scale the entire application without changing Windows display settings',85,120,5,'%')}${settingSelect('density','Content density','Adjust padding and row height throughout the library',[['compact','Compact'],['comfortable','Comfortable'],['spacious','Spacious']])}${settingSelect('cornerStyle','Corner style','Control the shape language used across cards and panels',[['square','Subtle'],['rounded','Rounded'],['soft','Extra soft']])}${settingSelect('sidebarWidth','Sidebar width','Give navigation more room or preserve library space',[['compact','Compact'],['default','Default'],['wide','Wide']])}${settingSelect('albumCardSize','Album card size','Choose how many covers fit on screen',[['small','Small'],['medium','Medium'],['large','Large']])}${settingToggle('showSidebarPlaylists','Sidebar playlist previews','Show recent playlists beneath the main navigation')}${settingToggle('reducedMotion','Reduced motion','Minimize navigation, artwork, shelf, and logo animation')}</div>`;
  if(tab==='playback')return `<header><span class="eyebrow">PLAYBACK</span><h2>Audio, queue, and transport</h2><p>Set the behavior Ignifire uses whenever a collection starts.</p></header>
    <div class="settings-section"><h3>Audio</h3>${settingRange('volume','Current volume','Sets and remembers the player’s master volume',0,100,1,'%')}${settingRange('playbackRate','Playback speed','Applies to local audio while preserving pitch when enabled',.5,2,.05,'×')}${settingToggle('preservePitch','Preserve pitch','Keep vocals and instruments natural when changing speed')}${settingToggle('gapless','Gapless playback','Preload local tracks and advance without an intentional pause')}${settingRange('crossfade','Transition fade','Gently fade the final seconds before advancing',0,12,1,' sec')}${settingToggle('preloadAudio','Preload audio','Prepare local audio ahead of playback for quicker starts')}</div>
    <div class="settings-section"><h3>Queue behavior</h3>${settingToggle('autoplayNext','Automatically play next','Advance through the active album, artist, or playlist')}${settingToggle('stopAfterCurrent','Stop after current track','A one-time sleep timer that turns itself off after stopping')}${settingToggle('shuffle','Shuffle mode','Start newly selected collections in shuffled order')}${settingSelect('repeatMode','Repeat mode','Choose the persistent repeat behavior',[['off','Off'],['all','Repeat queue'],['one','Repeat current track']])}${settingSelect('visualizerStyle','Default visualizer','Opens fullscreen playback with this visual style',[['waves','Aurora waves'],['orbit','Pulse orbit'],['spectrum','Prism spectrum']])}</div>`;
  if(tab==='library')return `<header><span class="eyebrow">LIBRARY</span><h2>Organize imports and collections</h2><p>Choose default views, sorting, safeguards, and automatic artwork behavior.</p></header>
    <div class="settings-section"><h3>Default organization</h3>${settingSelect('songSort','Song-list sorting','Default order used on the Songs screen',[['plays-desc','Most played'],['plays-asc','Least played'],['added-desc','Last added'],['added-asc','First added'],['title-asc','Song A–Z'],['artist-asc','Artist A–Z']])}${settingSelect('albumView','Album presentation','Default layout for the Albums screen',[['grid','Artwork grid'],['list','Detailed list']])}${settingSelect('albumFilter','Album filter','The Albums screen remembers this collection filter',[['all','All albums'],['recent','Recently added'],['downloaded','Downloaded'],['favorites','Favorites']])}${settingSelect('playlistDefaultSort','New playlist sorting','Used until an individual playlist chooses another order',Object.entries(playlistSortLabels))}${settingToggle('showPendingTracks','Show pending tracks','Keep screenshot-import placeholders visible in playlist tables')}${settingToggle('confirmDeletes','Confirm destructive actions','Ask before removing tracks, albums, artists, playlists, or shelves')}</div>
    <div class="settings-section"><h3>Imports & artwork</h3>${settingToggle('dynamicArtByDefault','Dynamic Case Art for new albums','Automatically extend imported covers into coordinated back and spine artwork')}<div class="setting-row"><div><b>Live folders</b><small>${localLiveFolders().length?`${localLiveFolders().length} watched folder${localLiveFolders().length===1?'':'s'} · ${localLiveFolders().reduce((sum,folder)=>sum+(Number(folder.trackCount)||0),0)} synced tracks`:'Continuously mirror local music folders into your library'}</small></div><button class="ghost" id="manageLiveFolders">${localLiveFolders().length?'Manage folders':'Add live folder'}</button></div><div class="setting-row"><div><b>Ignifire data folder</b><small>${esc(dataDirectory||'Browser local storage')}</small></div><button class="ghost" id="openDataFolder" ${dataDirectory?'':'disabled'}>Open folder</button></div></div>`;
  if(tab==='integrations')return `<header><span class="eyebrow">INTEGRATIONS</span><h2>Connected creative services</h2><p>Credentials are encrypted by Windows and stored outside the application installation.</p></header>
    <div class="settings-section"><h3>Creative tools</h3><div class="setting-row"><div><b>OpenAI API key</b><small>Used for optional AI video and case art</small></div><input id="openaiKey" type="password" value="${esc(credentials.openaiKey)}" placeholder="Not connected" autocomplete="off"></div><div class="setting-row"><div><b>ApiPass · Suno</b><small>Create and import Suno tracks</small></div><button class="ghost" id="connectSuno">${sunoConnected?'Manage connection':'Connect ApiPass'}</button></div></div>`;
  if(tab==='updates')return `<header><span class="eyebrow">UPDATES</span><h2>Keep Ignifire current</h2><p>Choose a release channel and manage background updates.</p></header><div class="settings-section"><div class="setting-row update-setting-row"><div><b>Update channel</b><small>Stable follows main; Test follows beta</small></div><span class="update-setting-controls"><select id="updateChannel"><option value="stable" ${settings.updateChannel!=='beta'?'selected':''}>Stable · main</option><option value="beta" ${settings.updateChannel==='beta'?'selected':''}>Test · beta</option></select><button class="ghost" id="checkForUpdates">Check now</button></span></div><div class="setting-row"><div><b>Update status</b><small>${updateStatusText()}</small></div><button class="ghost" id="showUpdateDetails">Details</button></div></div>`;
  if(tab==='account')return accountSettingsMarkup();
  return `<header><span class="eyebrow">PRIVACY & CONTROL</span><h2>Decide what can go online</h2><p>Your library and listening history remain local unless you explicitly enable account sync. These switches control optional lookups.</p></header>
    <div class="settings-section"><h3>Online discovery</h3>${settingToggle('onlineMetadata','Metadata and cover lookup','Allow MusicBrainz and Cover Art Archive searches')}${settingToggle('onlineLyrics','Lyrics lookup','Allow plain and time-synchronized LRCLIB searches')}${settingToggle('onlineArtistImages','Artist-image and GIF lookup','Allow Wikimedia, Deezer, TheAudioDB, GIPHY, and Tenor searches')}${settingToggle('onlineMusicVideos','Existing music-video lookup','Search video platforms before any AI generation')}</div>
    <div class="settings-section reset-preferences-section"><div class="setting-row"><div><b>Reset preferences</b><small>Restore interface, playback, and library defaults without deleting music</small></div><button class="ghost danger" id="resetSettings">Reset settings</button></div></div>`;
}

function renderSettings() {
  updateAccountControl();
  const tabs=[['appearance','Appearance'],['playback','Playback'],['library','Library'],['account','Account & sync'],['integrations','Integrations'],['updates','Updates'],['privacy','Privacy & control']];
  view.innerHTML = pageHead('MAKE IT YOURS','Settings','Tune every part of Ignifire without interrupting playback.') + `<div class="settings-grid"><nav class="settings-menu">${tabs.map(([value,label])=>`<button class="${settingsTab===value?'active':''}" data-settings-tab="${value}">${label}</button>`).join('')}</nav><section class="settings-panel" data-settings-panel="${settingsTab}">${settingsPanelMarkup(settingsTab)}</section></div>`;
  if(settingsTab==='integrations'){const sections=$$('.settings-section',view);(sections[1]||sections[0])?.insertAdjacentHTML(sections[1]?'beforebegin':'afterend',discordSettingsMarkup());updateDiscordStatusView()}
  if(settingsTab==='account'&&accountState.signedIn){const cloudToggle=$('[data-setting-toggle="cloudSyncEnabled"]',view)?.closest('.setting-row');cloudToggle?.insertAdjacentHTML('afterend',settingToggle('autoDownloadCloudLibrary','Auto-download library','Keep cloud tracks downloaded on this PC'))}
  $$('[data-settings-tab]',view).forEach(button=>button.onclick=()=>{settingsTab=button.dataset.settingsTab;renderSettings()});
  $$('.accent-swatches [data-accent]',view).forEach(button=>button.onclick=()=>{settings.accent=button.dataset.accent;settings.accentRgb=button.dataset.rgb;applySettings();saveLibrary();renderSettings()});
  if($('#customAccent'))$('#customAccent').oninput=event=>{const hex=event.target.value,parts=hex.match(/[a-f\d]{2}/gi).map(value=>parseInt(value,16));settings.accent=hex;settings.accentRgb=parts.join(',');applySettings();saveLibrary()};
  $$('[data-setting-toggle]',view).forEach(button=>button.onclick=()=>{const key=button.dataset.settingToggle;settings[key]=!settings[key];if(key==='shuffle')setShuffleEnabled(settings[key],{persist:false});if(key==='repeatMode')repeatMode=settings.repeatMode;applySettings();saveLibrary();if(key.startsWith('discord'))configureDiscordPresence();if(key==='autoDownloadCloudLibrary'&&settings[key])setCloudDownload(allTracks(),true);renderSettings()});
  $$('[data-setting-select]',view).forEach(select=>select.onchange=()=>{const key=select.dataset.settingSelect;settings[key]=select.value;if(key==='playbackRate')settings[key]=Number(select.value);if(key==='repeatMode')repeatMode=settings.repeatMode;if(key==='visualizerStyle')visualizerStyle=settings.visualizerStyle;if(key.startsWith('discord'))configureDiscordPresence();applySettings();saveLibrary();render()});
  $$('[data-setting-range]',view).forEach(range=>range.oninput=()=>{const key=range.dataset.settingRange,value=Number(range.value),percent=(value-Number(range.min))/(Number(range.max)-Number(range.min))*100;settings[key]=value;range.style.setProperty('--range',`${percent}%`);range.nextElementSibling.textContent=`${value}${key==='volume'||key==='uiScale'?'%':key==='playbackRate'?'×':key==='crossfade'?' sec':''}`;if(key==='volume')setVolume(value);else{applySettings();saveLibrary()}});
  if($('#updateChannel'))$('#updateChannel').onchange=e=>{settings.updateChannel=e.target.value==='beta'?'beta':'stable';updateState={status:'idle',channel:settings.updateChannel,available:false,progress:null};saveLibrary();renderUpdateWidget();checkForUpdates(true)};
  if($('#checkForUpdates'))$('#checkForUpdates').onclick=()=>checkForUpdates(true);if($('#showUpdateDetails'))$('#showUpdateDetails').onclick=openUpdateModal;
  if($('#reconnectDiscord'))$('#reconnectDiscord').onclick=()=>configureDiscordPresence(true);
  if($('#accountSignIn'))$('#accountSignIn').onclick=()=>openAccountPortal('signin');if($('#accountCreate'))$('#accountCreate').onclick=()=>openAccountPortal('signup');if($('#accountManagePasskeys'))$('#accountManagePasskeys').onclick=()=>openAccountPortal('passkeys');
  if($('#accountClaimCode'))$('#accountClaimCode').onclick=claimAccountConnection;if($('#accountConnectionCode'))$('#accountConnectionCode').onkeydown=e=>{if(e.key==='Enter')claimAccountConnection()};
  if($('#accountSyncNow'))$('#accountSyncNow').onclick=syncAccountNow;if($('#accountRestore'))$('#accountRestore').onclick=restoreAccountCloud;
  if($('#accountSignOut'))$('#accountSignOut').onclick=()=>confirmRemove('Sign out of Ignifire?','Your local library stays on this PC. Cloud backup will stop until you sign in again.',async()=>{await window.firefly.signOutAccount();settings.cloudSyncEnabled=false;accountState={signedIn:false,configured:true,status:'ready',storageUsed:0,storageLimit:ACCOUNT_STORAGE_LIMIT_BYTES};saveLibrary();renderSettings();toast('Signed out on this PC')});
  if($('#openaiKey'))$('#openaiKey').onchange=e=>{credentials.openaiKey=e.target.value.trim();saveCredentials();if(credentials.openaiKey)albums.filter(album=>album.dynamicCaseArt?.autoGenerate).forEach(queueDefaultDynamicCase);toast('OpenAI key saved','Stored with Windows encryption.')};
  if($('#openDataFolder'))$('#openDataFolder').onclick=()=>window.firefly?.openDataDirectory();if($('#manageLiveFolders'))$('#manageLiveFolders').onclick=()=>localLiveFolders().length?openLiveFoldersModal():addLiveFolder();if($('#connectSuno'))$('#connectSuno').onclick=connectSunoModal;
  if($('#resetSettings'))$('#resetSettings').onclick=()=>confirmRemove('Reset preferences?','Music, playlists, artwork, and connections will stay intact.',()=>{const channel=settings.updateChannel;settings={...defaultSettings,updateChannel:channel};shuffleEnabled=settings.shuffle;repeatMode=settings.repeatMode;visualizerStyle=settings.visualizerStyle;applySettings();saveLibrary();configureDiscordPresence();renderSettings();toast('Preferences reset')});
}

function sunoStateLabel(state='queuing'){return({queuing:'Queued',pending:'Queued',generating:'Generating',processing:'Generating',success:'Complete',fail:'Failed'}[state]||state)}
function pendingSunoJob(job){return['queuing','pending','generating','processing'].includes(job.state)}
function sunoResultMarkup(job,result,index){
  const imported=Boolean(result.importedTrackId&&allTracks().some(track=>track.id===result.importedTrackId));
  const art=result.imageUrl?`style="background-image:url(&quot;${esc(result.imageUrl)}&quot;)"`:'';
  return `<article class="suno-result"><div class="suno-result-art" ${art}><span>VARIANT ${index+1}</span></div><div class="suno-result-copy"><h3>${esc(result.title||job.title||`Variant ${index+1}`)}</h3><p>${esc(result.style||job.style||'Suno generation')} · ${result.duration?displayDuration(result.duration):'Ready'}</p><audio controls preload="none" src="${esc(result.audioUrl)}"></audio><div><button class="primary" data-suno-import data-task-id="${esc(job.taskId)}" data-result-index="${index}" ${imported?'disabled':''}>${icon(imported?'song':'upload')} ${imported?'Imported':'Import to Ignifire'}</button></div></div></article>`;
}
function renderSuno() {
  const pending=sunoJobs.filter(pendingSunoJob).length;
  view.innerHTML=`<section class="suno-hero"><span class="connect-pill connection-status ${sunoConnected?'connected':''}"><i></i>${icon('suno')} APIPASS · SUNO ${sunoConnected?'CONNECTED':'NOT CONNECTED'}</span><h1>Make something unheard.</h1><p>Create, preview, and import Suno music.</p><div class="suno-hero-actions"><button class="primary" id="sunoConnect">${sunoConnected?'Manage ApiPass':'Connect ApiPass'}</button><button class="ghost" id="openApiPassDocs">API documentation ↗</button>${pending?`<span class="suno-running"><i class="spinner"></i>${pending} running</span>`:''}</div></section><div class="suno-tabs"><button class="chip ${sunoTab==='create'?'active':''}" data-suno-tab="create">Create</button><button class="chip ${sunoTab==='generations'?'active':''}" data-suno-tab="generations">Your generations <em>${sunoJobs.length}</em></button><button class="chip ${sunoTab==='capabilities'?'active':''}" data-suno-tab="capabilities">ApiPass capabilities</button></div><div id="sunoContent"></div>`;
  $('#sunoConnect').onclick=connectSunoModal;
  $('#openApiPassDocs').onclick=()=>window.open('https://apipass.dev/features/suno','_blank');
  $$('[data-suno-tab]',view).forEach(button=>button.onclick=()=>{sunoTab=button.dataset.sunoTab;renderSuno()});
  if(!sunoConnected){$('#sunoContent').innerHTML=`<div class="empty-state">${icon('suno')}<h2>Connect ApiPass to begin</h2><button class="primary" id="emptySunoConnect">Connect ApiPass</button></div>`;$('#emptySunoConnect').onclick=connectSunoModal;return}
  if(sunoTab==='create')renderSunoCreate();
  else if(sunoTab==='generations')renderSunoGenerations();
  else renderSunoCapabilities();
}
function renderSunoCreate(){
  const host=$('#sunoContent');
  host.innerHTML=`<form class="suno-create-panel" id="sunoCreateForm"><header><div><span>TEXT TO MUSIC</span><h2>Create with Suno</h2><p>ApiPass queues generation in the background and normally returns two complete MP3 variants.</p></div><span class="suno-provider-mark">Suno V5.5</span></header><div class="form-grid suno-create-grid"><div class="field"><label>MODEL</label><select id="sunoModel"><option value="V5_5">V5.5 · Latest</option><option value="V5">V5</option><option value="V4_5PLUS">V4.5 Plus</option><option value="V4_5ALL">V4.5 All</option><option value="V4_5">V4.5</option><option value="V4">V4</option></select></div><div class="field"><label>ROUTING</label><select id="sunoChannel"><option value="auto">Auto · Recommended</option><option value="starter">Starter</option><option value="regular">Regular</option><option value="official">Official</option></select></div><label class="suno-mode-toggle"><input id="sunoCustom" type="checkbox"><span>${icon('settings')}<b>Custom mode</b><small>Control lyrics, title, style, and generation weights</small></span></label><label class="suno-mode-toggle"><input id="sunoInstrumental" type="checkbox"><span>${icon('song')}<b>Instrumental</b><small>Generate without vocals</small></span></label><div class="field full"><label id="sunoPromptLabel">SONG DESCRIPTION</label><textarea id="sunoPrompt" rows="7" maxlength="5000" placeholder="An atmospheric synth-pop song about driving through a neon city at midnight…"></textarea><small id="sunoPromptHint">Describe the mood, instruments, tempo, theme, and vocal character.</small></div><div class="suno-custom-fields hidden"><div class="field"><label>TITLE</label><input id="sunoTitle" maxlength="80" placeholder="Midnight Circuit"></div><div class="field"><label>STYLE</label><input id="sunoStyle" maxlength="1000" placeholder="Synth-pop, cinematic, female vocal"></div><div class="field"><label>VOCAL GENDER</label><select id="sunoVocalGender"><option value="">Any</option><option value="f">Female</option><option value="m">Male</option></select></div><div class="field"><label>EXCLUDE</label><input id="sunoNegativeTags" maxlength="1000" placeholder="screaming, harsh distortion"></div><div class="field"><label>STYLE WEIGHT · <output id="sunoStyleWeightOut">0.50</output></label><input id="sunoStyleWeight" type="range" min="0" max="1" step="0.01" value="0.5"></div><div class="field"><label>WEIRDNESS · <output id="sunoWeirdnessOut">0.30</output></label><input id="sunoWeirdness" type="range" min="0" max="1" step="0.01" value="0.3"></div><div class="field"><label>AUDIO WEIGHT · <output id="sunoAudioWeightOut">0.50</output></label><input id="sunoAudioWeight" type="range" min="0" max="1" step="0.01" value="0.5"></div></div></div><footer><p>Generation uses your ApiPass credits. Ignifire polls securely while you use the rest of the app.</p><button class="primary" id="generateSuno" type="submit">${icon('spark')} Generate two variants</button></footer></form>`;
  $('.suno-create-panel>header p',host).textContent='Turn an idea into music.';$('.suno-create-panel>footer p',host).textContent='Uses ApiPass credits.';
  $('#sunoModel').value=settings.sunoModel||'V5_5';$('#sunoChannel').value=settings.sunoChannel||'auto';
  const syncMode=()=>{const custom=$('#sunoCustom').checked,instrumental=$('#sunoInstrumental').checked;$('.suno-custom-fields',host).classList.toggle('hidden',!custom);$('#sunoPrompt').disabled=custom&&instrumental;$('#sunoPromptLabel').textContent=custom?(instrumental?'PROMPT · EMPTY FOR CUSTOM INSTRUMENTAL':'LYRICS / LYRIC DIRECTION'):'SONG DESCRIPTION';$('#sunoPromptHint').textContent=custom?(instrumental?'ApiPass requires an explicit empty prompt in this mode.':'Enter lyrics or a detailed lyric direction.'):'Describe the mood, instruments, tempo, theme, and vocal character.';if(custom&&instrumental)$('#sunoPrompt').value='';$('#sunoVocalGender').disabled=instrumental};
  $('#sunoCustom').onchange=syncMode;$('#sunoInstrumental').onchange=syncMode;
  [['#sunoStyleWeight','#sunoStyleWeightOut'],['#sunoWeirdness','#sunoWeirdnessOut'],['#sunoAudioWeight','#sunoAudioWeightOut']].forEach(([range,output])=>$(range).oninput=event=>{$(output).textContent=Number(event.target.value).toFixed(2);setRange(event.target,Number(event.target.value)*100)});syncMode();
  $('#sunoCreateForm').onsubmit=submitSunoGeneration;
}
async function submitSunoGeneration(event){
  event.preventDefault();const button=$('#generateSuno'),customMode=$('#sunoCustom').checked,instrumental=$('#sunoInstrumental').checked;
  const options={modelVersion:$('#sunoModel').value,channel:$('#sunoChannel').value,customMode,instrumental,prompt:$('#sunoPrompt').value,title:customMode?$('#sunoTitle').value:'',style:customMode?$('#sunoStyle').value:'',vocalGender:$('#sunoVocalGender').value,negativeTags:$('#sunoNegativeTags').value,styleWeight:$('#sunoStyleWeight').value,weirdnessConstraint:$('#sunoWeirdness').value,audioWeight:$('#sunoAudioWeight').value};
  if(!options.prompt.trim()&&!customMode){toast('Describe the song first');$('#sunoPrompt').focus();return}
  if(customMode&&(!options.title.trim()||!options.style.trim()||(!instrumental&&!options.prompt.trim()))){toast('Complete the custom song details','Title, style, and vocal lyrics are required.');return}
  button.disabled=true;button.innerHTML=`<span class="spinner"></span> Sending to ApiPass`;
  try{const task=await window.firefly.createSunoTask(options);settings.sunoModel=options.modelVersion;settings.sunoChannel=options.channel;sunoJobs.unshift({...task,title:task.input.title||options.prompt.trim().slice(0,70)||'Instrumental generation',style:task.input.style||'Description mode',prompt:task.input.prompt,results:[],lastError:''});sunoTab='generations';saveLibrary();renderSuno();toast('Generation started','ApiPass is creating two variants in the background.');setTimeout(pollSunoJobs,1500)}catch(error){button.disabled=false;button.innerHTML=`${icon('spark')} Generate two variants`;toast('Could not start generation',error.message)}
}
function renderSunoGenerations(){
  const host=$('#sunoContent');
  if(!sunoJobs.length){host.innerHTML=`<div class="empty-state">${icon('spark')}<h2>No generations yet</h2><p>Create a song and both ApiPass variants will appear here when ready.</p><button class="primary" id="startFirstSuno">Create your first song</button></div>`;$('#startFirstSuno').onclick=()=>{sunoTab='create';renderSuno()};return}
  host.innerHTML=`<div class="suno-job-list">${sunoJobs.map(job=>`<section class="suno-job ${pendingSunoJob(job)?'running':''}"><header><div><span class="suno-state ${esc(job.state)}">${pendingSunoJob(job)?'<i class="spinner"></i>':''}${esc(sunoStateLabel(job.state))}</span><h2>${esc(job.title||'Suno generation')}</h2><p>${esc(job.style||job.model||'suno/generate')} · ${new Date(job.createdAt||Date.now()).toLocaleString()}</p></div><div><button class="ghost" data-suno-refresh="${esc(job.taskId)}">Refresh</button><button class="icon-button" data-suno-delete="${esc(job.taskId)}" title="Remove generation record">${icon('close')}</button></div></header>${job.state==='fail'?`<div class="suno-error"><b>${esc(job.failCode||'Generation failed')}</b><span>${esc(job.failMsg||job.lastError||'ApiPass could not finish this task.')}</span></div>`:''}${pendingSunoJob(job)?`<div class="suno-progress"><span></span><p>${job.state==='generating'?'Suno is composing and rendering your tracks…':'Waiting for an ApiPass worker…'}</p></div>`:''}${job.state==='success'&&!job.results?.length?`<div class="suno-error"><b>Task completed without playable audio</b><span>Refresh once more. ApiPass may still be finalizing its result payload.</span></div>`:''}${job.results?.length?`<div class="suno-result-grid">${job.results.map((result,index)=>sunoResultMarkup(job,result,index)).join('')}</div>`:''}<footer><span>Task ${esc(job.taskId)}</span></footer></section>`).join('')}</div>`;
  $$('[data-suno-refresh]',host).forEach(button=>button.onclick=()=>pollSunoJob(button.dataset.sunoRefresh,true));
  $$('[data-suno-delete]',host).forEach(button=>button.onclick=()=>{sunoJobs=sunoJobs.filter(job=>job.taskId!==button.dataset.sunoDelete);saveLibrary();renderSuno();toast('Generation record removed','Imported music remains in your library.')});
  $$('[data-suno-import]',host).forEach(button=>button.onclick=()=>importSunoResult(button.dataset.taskId,Number(button.dataset.resultIndex),button));
}
function renderSunoCapabilities(){
  $('#sunoContent').innerHTML=`<div class="suno-capability-intro"><div><span>APIPASS SUNO API</span><h2>One protected connection</h2><p>Ignifire currently integrates text-to-music generation and task polling—the production starting point recommended by ApiPass. Generated MP3s and artwork can be imported locally.</p></div><button class="ghost" id="capabilityDocs">Read ApiPass guide ↗</button></div><div class="suno-capability-grid"><article class="ready">${icon('spark')}<b>Generate Music</b><span>Integrated · V5.5 through V4</span></article><article class="ready">${icon('list')}<b>Async Task Queue</b><span>Integrated · background polling</span></article><article>${icon('song')}<b>Generate Lyrics</b><span>Available from ApiPass</span></article><article>${icon('albums')}<b>Create Covers</b><span>Available from ApiPass</span></article><article>${icon('plus')}<b>Extend Songs</b><span>Available from ApiPass</span></article><article>${icon('artist')}<b>Vocal Separation</b><span>Available from ApiPass</span></article></div>`;$('#capabilityDocs').onclick=()=>window.open('https://apipass.dev/document/suno-api-integration-guide','_blank');
}
async function pollSunoJob(taskId,manual=false){
  const job=sunoJobs.find(item=>item.taskId===taskId);if(!job||!window.firefly?.querySunoTask)return;
  const prior=job.state;if(manual&&currentView==='suno')toast('Checking ApiPass',job.title);
  try{const result=await window.firefly.querySunoTask(taskId);Object.assign(job,result,{lastCheckedAt:new Date().toISOString(),lastError:''});saveLibrary();if(prior!==job.state&&job.state==='success')toast('Suno generation complete',`${job.results.length} variant${job.results.length===1?'':'s'} ready to preview`);if(prior!==job.state&&job.state==='fail')toast('Suno generation failed',job.failMsg||job.failCode);if(currentView==='suno')renderSuno()}catch(error){job.lastError=error.message;job.lastCheckedAt=new Date().toISOString();saveLibrary();if(manual)toast('Could not refresh generation',error.message)}
}
async function pollSunoJobs(){if(sunoPolling||!sunoConnected)return;const pending=sunoJobs.filter(pendingSunoJob);if(!pending.length)return;sunoPolling=true;try{await Promise.all(pending.slice(0,4).map(job=>pollSunoJob(job.taskId)))}finally{sunoPolling=false}}
function initializeSunoPolling(){clearInterval(sunoPollTimer);sunoPollTimer=setInterval(pollSunoJobs,12000);if(sunoConnected&&sunoJobs.some(pendingSunoJob))setTimeout(pollSunoJobs,1200)}
async function importSunoResult(taskId,index,button){
  const job=sunoJobs.find(item=>item.taskId===taskId),result=job?.results?.[index];if(!job||!result)return;
  button.disabled=true;button.innerHTML=`<span class="spinner"></span> Importing`;
  try{const cached=await window.firefly.importSunoTrack({taskId,resultId:result.id,title:result.title,audioUrl:result.audioUrl,imageUrl:result.imageUrl});const albumId=`suno-${taskId}`,albumTitle=job.title||result.title||'Suno Generation';let album=albumById(albumId);if(!album){album=applyNewAlbumDefaults({id:albumId,title:albumTitle,artist:'Suno AI',year:new Date().getFullYear(),genre:result.style||job.style||'AI Generated',cover:(cached.imageUrl||result.imageUrl)?'':'cover-8',customCover:cached.imageUrl||result.imageUrl||null,fullArt:null,tracks:[]});albums.push(album)}const trackId=`suno-${taskId}-${String(result.id||index).replace(/[^A-Za-z0-9_-]+/g,'-')}`;let track=allTracks().find(item=>item.id===trackId);if(!track){track={id:trackId,title:result.title||`${albumTitle} · Variant ${index+1}`,artist:'Suno AI',album:album.title,albumId:album.id,duration:displayDuration(result.duration),durationSeconds:Number(result.duration)||0,trackNumber:index+1,discNumber:1,plays:0,lastPlayed:null,added:Date.now(),pending:false,url:cached.audioUrl,path:cached.audioPath,source:{provider:'ApiPass',model:job.model,taskId,resultId:result.id}};album.tracks.push(track);album.tracks.sort((left,right)=>(left.trackNumber||0)-(right.trackNumber||0))}queueDefaultDynamicCase(album);result.importedTrackId=track.id;result.localAudioUrl=cached.audioUrl;saveLibrary();renderSuno();toast('Suno track imported',`${track.title} is now in your library.`)}catch(error){button.disabled=false;button.innerHTML=`${icon('upload')} Import to Ignifire`;toast('Could not import generated track',error.message)}
}
function connectSunoModal() {
  openModal(`<div class="modal-head"><h2>${sunoConnected?'Manage ApiPass':'Connect ApiPass'}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body">${sunoConnected?`<div class="lookup-status"><span class="status-dot"></span><span>Connected to ApiPass. The key is encrypted with Windows and stored outside the app installation.</span></div>`:''}<div class="form-grid"><div class="field full"><label>PROVIDER</label><input value="https://api.apipass.dev" readonly></div><div class="field full"><label>APIPASS API KEY</label><input id="sunoToken" type="password" value="${esc(credentials.sunoToken)}" placeholder="sk-ap-xxxxxxxxxxxxxx" autocomplete="off"></div></div><p class="suno-connect-note">Create a key in <a href="https://apipass.dev/app/api-keys" target="_blank" rel="noreferrer">ApiPass API Keys ↗</a>. Ignifire uses Bearer authentication through its protected main process; generation consumes your ApiPass credits.</p></div><div class="modal-actions">${sunoConnected?'<button class="ghost" id="disconnectSuno" style="margin-right:auto;color:#ef806f">Disconnect</button>':''}<button class="ghost close-modal">Cancel</button><button class="primary" id="finishSunoConnect">${sunoConnected?'Verify & save':'Connect & verify'}</button></div>`,true);
  $('#finishSunoConnect').onclick=async()=>{const token=$('#sunoToken').value.trim(),button=$('#finishSunoConnect');if(!token){$('#sunoToken').focus();toast('Enter an ApiPass API key');return}button.disabled=true;button.innerHTML=`<span class="spinner"></span> Verifying`;credentials.sunoToken=token;try{if(!await saveCredentials())throw new Error('The API key could not be saved.');await window.firefly.testSunoConnection();settings.sunoEndpoint=defaultSettings.sunoEndpoint;sunoConnected=true;saveLibrary();closeModal();if(currentView==='suno')renderSuno();else if(currentView==='settings')renderSettings();initializeSunoPolling();toast('ApiPass connected','Suno generation is ready.') }catch(error){sunoConnected=false;saveLibrary();button.disabled=false;button.textContent='Connect & verify';toast('ApiPass connection failed',error.message)}};
  if($('#disconnectSuno'))$('#disconnectSuno').onclick=async()=>{sunoConnected=false;credentials.sunoToken='';await saveCredentials().catch(()=>{});saveLibrary();closeModal();if(currentView==='suno')renderSuno();else renderSettings();toast('ApiPass disconnected')};
}

function spineArtworkStyle(image,mode='separate'){
  const crop={
    dynamic:{size:'1200% 100%',position:'right center'},
    'back-scan':{size:'2200% 100%',position:'right center'},
    'full-spread':{size:'2200% 100%',position:'center center'},
    separate:{size:'100% 100%',position:'center center'}
  }[mode]||{size:'100% 100%',position:'center center'};
  return `background-image:url('${image}');background-size:${crop.size};background-position:${crop.position};background-repeat:no-repeat;`;
}
function shelfAlbumMarkup(album,shelfId){
  const dynamic=dynamicCaseReady(album)?album.dynamicCaseArt:null;
  const scannedSpine=album.fullArtParts?.spine;
  const spreadArt=album.customFullArt&&(!album.fullArtParts||album.fullArtParts.spineMode==='full-spread')?album.customFullArt:null;
  const textureArt=album.fullArtParts?.back||album.customFullArt||album.customCover||null;
  const textureUrl=textureArt?String(textureArt).replace(/['\\]/g,'\\$&'):'';
  const source=scannedSpine?'scanned':spreadArt?'spread':dynamic?'dynamic':textureArt?'texture':'text';
  const spineStyle=scannedSpine
    ? spineArtworkStyle(scannedSpine,album.fullArtParts.spineMode||'separate')
    : spreadArt?spineArtworkStyle(spreadArt,'full-spread')
    : dynamic?`${spineArtworkStyle(dynamic.backgroundUrl,'dynamic')}font-family:'${dynamicFontName(dynamic.font)}';`
    : textureArt?`background-image:linear-gradient(90deg,#08080899,#08080835,#080808aa),url('${textureUrl}');background-size:auto 100%,cover;background-position:center;background-repeat:no-repeat;`:'';
  const showText=['dynamic','texture','text'].includes(source);
  return `<div draggable="true" class="shelf-album shelf-spine-${source} ${showText?'artwork-text-spine':'has-real-spine'}" data-shelf-album="${album.id}" data-parent-shelf="${shelfId}" data-spine-source="${source}" style="${spineStyle}">${showText?`${esc(album.artist)} - ${esc(album.title)}`:''}</div>`;
}

function renderShelf() {
  currentView='shelf';
  syncShelves();
  $('#shelfToggle').classList.add('active');
  const shelfMarkup=shelves.map((shelf,index)=>{
    const shelfAlbums=shelf.albumIds.map(albumById).filter(Boolean);
    return `<section class="shelf-unit" data-shelf-unit="${shelf.id}"><div class="shelf-header"><div><span>SHELF ${index+1}</span><h2>${esc(shelf.name)}</h2><small>${shelfAlbums.length} album${shelfAlbums.length===1?'':'s'}</small></div><div class="shelf-actions"><button class="icon-button" data-move-shelf="up" data-shelf-id="${shelf.id}" title="Move shelf up" ${index===0?'disabled':''}>↑</button><button class="icon-button" data-move-shelf="down" data-shelf-id="${shelf.id}" title="Move shelf down" ${index===shelves.length-1?'disabled':''}>↓</button><button class="ghost" data-rename-shelf="${shelf.id}">${icon('settings')} Rename</button><button class="icon-button shelf-delete" data-delete-shelf="${shelf.id}" title="Delete shelf">${icon('close')}</button></div></div><div class="wood-shelf ${shelfAlbums.length?'':'empty-wood-shelf'}" data-shelf-drop="${shelf.id}">${shelfAlbums.map(a=>shelfAlbumMarkup(a,shelf.id)).join('')}${shelfAlbums.length?'':'<div class="shelf-drop-hint">Drop albums here</div>'}</div></section>`;
  }).join('');
  view.innerHTML = pageHead('PHYSICAL VIEW','The Shelf','Create, name, reorder, and fill multiple shelves.',`<button class="ghost" id="sortShelf">Sort albums</button><button class="primary" id="addShelf">${icon('plus')} Add shelf</button>`) + (albums.length?`<div class="shelf-scene">${shelfMarkup}<p class="shelf-tip">Drag albums between shelves · click a spine to open the case</p></div>`:`<div class="shelf-scene">${shelfMarkup}</div><div class="empty-state" style="margin-top:18px">${icon('shelf')}<h2>Your shelves are ready</h2><p>Import a folder with multiple songs to create your first album.</p><div class="empty-actions"><button class="primary" data-import="folder">${icon('albums')} Import folder</button></div></div>`);
  $$('[data-shelf-album]',view).forEach(spine=>{
    spine.addEventListener('dragstart',()=>{draggedAlbum=spine.dataset.shelfAlbum;spine.classList.add('dragging')});
    spine.addEventListener('dragend',()=>spine.classList.remove('dragging'));
    spine.addEventListener('dragover',e=>e.preventDefault());
    spine.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();const target=spine.dataset.shelfAlbum;if(target===draggedAlbum)return;const targetShelf=shelves.find(s=>s.id===spine.dataset.parentShelf);shelves.forEach(s=>s.albumIds=s.albumIds.filter(id=>id!==draggedAlbum));const at=targetShelf.albumIds.indexOf(target);targetShelf.albumIds.splice(at,0,draggedAlbum);saveLibrary();renderShelf();toast('Album moved',targetShelf.name)});
    spine.addEventListener('click',()=>openAlbumDetail(spine.dataset.shelfAlbum));
  });
  $$('[data-shelf-drop]',view).forEach(drop=>{drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag-over')});drop.addEventListener('dragleave',()=>drop.classList.remove('drag-over'));drop.addEventListener('drop',e=>{e.preventDefault();if(e.target.closest('[data-shelf-album]'))return;const targetShelf=shelves.find(s=>s.id===drop.dataset.shelfDrop);shelves.forEach(s=>s.albumIds=s.albumIds.filter(id=>id!==draggedAlbum));targetShelf.albumIds.push(draggedAlbum);saveLibrary();renderShelf();toast('Album moved',targetShelf.name)})});
  $('#addShelf').onclick=addShelfModal;
  $$('[data-rename-shelf]',view).forEach(btn=>btn.onclick=()=>renameShelfModal(btn.dataset.renameShelf));
  $$('[data-delete-shelf]',view).forEach(btn=>btn.onclick=()=>deleteShelf(btn.dataset.deleteShelf));
  $$('[data-move-shelf]',view).forEach(btn=>btn.onclick=()=>moveShelf(btn.dataset.shelfId,btn.dataset.moveShelf));
  $('#sortShelf').onclick=()=>{shelves.forEach(s=>s.albumIds.sort((a,b)=>{const aa=albumById(a),bb=albumById(b);return aa.artist.localeCompare(bb.artist)||aa.title.localeCompare(bb.title)}));saveLibrary();renderShelf();toast('Shelves sorted','Artist and album · ascending')};
}

function addShelfModal(){openModal(`<div class="modal-head"><h2>Add shelf</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>SHELF NAME</label><input id="newShelfName" value="Shelf ${shelves.length+1}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="createShelf">Add shelf</button></div>`,true);$('#createShelf').onclick=()=>{const name=$('#newShelfName').value.trim()||`Shelf ${shelves.length+1}`;shelves.push({id:`shelf-${Date.now()}`,name,albumIds:[]});saveLibrary();closeModal();renderShelf();toast('Shelf added',name)}}
function renameShelfModal(id){const shelf=shelves.find(s=>s.id===id);if(!shelf)return;openModal(`<div class="modal-head"><h2>Rename shelf</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>SHELF NAME</label><input id="renameShelfName" value="${esc(shelf.name)}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="saveShelfName">Save</button></div>`,true);$('#saveShelfName').onclick=()=>{shelf.name=$('#renameShelfName').value.trim()||shelf.name;saveLibrary();closeModal();renderShelf();toast('Shelf renamed')}}
function deleteShelf(id){const shelf=shelves.find(s=>s.id===id);if(!shelf)return;if(shelves.length===1){toast('Keep at least one shelf');return}confirmRemove('Delete shelf?',`“${shelf.name}” will be removed. Its albums will move to the first remaining shelf.`,()=>{shelves=shelves.filter(s=>s.id!==id);shelves[0].albumIds.push(...shelf.albumIds.filter(albumId=>!shelves[0].albumIds.includes(albumId)));saveLibrary();renderShelf();toast('Shelf removed')})}
function moveShelf(id,direction){const index=shelves.findIndex(s=>s.id===id),next=direction==='up'?index-1:index+1;if(index<0||next<0||next>=shelves.length)return;[shelves[index],shelves[next]]=[shelves[next],shelves[index]];saveLibrary();renderShelf();toast('Shelf moved')}

function navigate(name,{record=true}={}) {
  if(currentView!==name&&(selectedTrackIds.size||selectedAlbumIds.size))clearBulkSelection();
  if(record&&currentView!==name){viewBackStack.push(currentView);viewForwardStack=[]}
  currentView=name;
  if(name==='home')$('#searchInput').value='';
  $$('#primaryNav button,.sidebar-bottom button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===name));
  $('#shelfToggle').classList.remove('active');
  render();
}
function updateHistoryControls(){const buttons=$$('.history button');if(buttons.length<2)return;buttons[0].disabled=!viewBackStack.length;buttons[1].disabled=!viewForwardStack.length}
function historyBack(){if(!viewBackStack.length)return;viewForwardStack.push(currentView);const destination=viewBackStack.pop();navigate(destination,{record:false})}
function historyForward(){if(!viewForwardStack.length)return;viewBackStack.push(currentView);const destination=viewForwardStack.pop();navigate(destination,{record:false})}

function openModal(html, narrow=false) {
  modalLayer.innerHTML=`<div class="modal ${narrow?'narrow':''}" role="dialog" aria-modal="true">${html}</div>`;
  modalLayer.classList.add('open');modalLayer.setAttribute('aria-hidden','false');
  $$('.close-modal',modalLayer).forEach(b=>b.onclick=closeModal);
  modalLayer.onclick=e=>{if(e.target===modalLayer)closeModal()};
}
function closeModal(){modalLayer.classList.remove('open');modalLayer.setAttribute('aria-hidden','true');setTimeout(()=>{modalLayer.innerHTML='';if(pendingUpdateRestartPrompt&&updateState.status==='ready'){pendingUpdateRestartPrompt=false;openUpdateModal()}},200)}

function editAlbum(id) {
  const a=albumById(id);
  openModal(`<div class="modal-head"><h2>Customize album</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body">
    <div class="artwork-slots"><label class="art-slot" id="coverSlot">${a.customCover?`<img src="${a.customCover}">`:albumCover(a)}<span>${icon('image')}Cover art<br><small>Square · 1400px+</small></span><input type="file" id="coverUpload" accept="image/*"></label><label class="art-slot" id="fullArtSlot">${a.customFullArt?`<img src="${a.customFullArt}">`:''}<span>${icon('image')}Full case art<br><small>Front · spine · back</small></span><span class="full-art-labels"><i>BACK</i><i>SPINE</i><i>FRONT</i></span><input type="file" id="fullArtUpload" accept="image/*"></label></div>
    ${dynamicCaseSectionMarkup(a)}
    <div class="form-grid"><div class="field"><label>ALBUM TITLE</label><input id="editTitle" value="${esc(a.title)}"></div><div class="field"><label>ARTIST</label><input id="editArtist" value="${esc(a.artist)}"></div><div class="field"><label>YEAR</label><input id="editYear" type="number" value="${a.year}"></div><div class="field"><label>GENRE</label><input id="editGenre" value="${esc(a.genre)}"></div><div class="field full"><label>NOTES</label><textarea rows="2" placeholder="Personal notes, edition details, catalog number…"></textarea></div></div>
  </div><div class="modal-actions"><button class="ghost" id="lookupMetadata">${icon('spark')} Pull metadata & cover</button><button class="ghost" id="lookupCaseArt">${icon('image')} Find full case art</button><span style="flex:1"></span><button class="ghost close-modal">Cancel</button><button class="primary" id="saveAlbum">Save changes</button></div>`);
  bindDynamicCaseControls(a);
  bindArtUpload('#coverUpload', data=>{a.customCover=data;$('#coverSlot').insertAdjacentHTML('afterbegin',`<img src="${data}">`);markDynamicCaseStale(a);queueDefaultDynamicCase(a)});
  bindArtUpload('#fullArtUpload', data=>{a.customFullArt=data;a.fullArtParts={front:null,back:data,spine:data,spineMode:'full-spread'};$('#fullArtSlot').insertAdjacentHTML('afterbegin',`<img src="${data}">`)});
  $('#lookupMetadata').onclick=()=>metadataLookup(a);
  $('#lookupCaseArt').onclick=()=>caseArtLookup(a);
  $('#saveAlbum').onclick=()=>{a.title=$('#editTitle').value.trim()||a.title;a.artist=$('#editArtist').value.trim()||a.artist;a.year=Number($('#editYear').value)||a.year;a.genre=$('#editGenre').value.trim()||a.genre;a.tracks.forEach(t=>{t.album=a.title;t.artist=a.artist});saveLibrary();closeModal();render();toast('Album updated',`${a.artist} — ${a.title}`)};
}
function bindArtUpload(selector, callback){$(selector).onchange=e=>{const file=e.target.files[0];if(!file)return;const r=new FileReader();r.onload=()=>callback(r.result);r.readAsDataURL(file)}}
function durationSecondsFor(track){
  if(Number(track?.durationSeconds)>0)return Number(track.durationSeconds);
  const parts=String(track?.duration||'').split(':').map(Number);return parts.length===2&&parts.every(Number.isFinite)?parts[0]*60+parts[1]:0;
}
function parseSyncedLyrics(value=''){
  const lines=[];
  String(value).split(/\r?\n/).forEach(line=>{
    const matches=[...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text=line.replace(/\[[^\]]+\]/g,'').trim();
    matches.forEach(match=>{const fraction=match[3]?Number(`0.${match[3].padEnd(3,'0').slice(0,3)}`):0;lines.push({time:Number(match[1])*60+Number(match[2])+fraction,text})});
  });
  return lines.sort((a,b)=>a.time-b.time);
}
function syncedLinesFor(track){return track?.lyrics?.syncedLines?.length?track.lyrics.syncedLines:parseSyncedLyrics(track?.lyrics?.synced||'')}
async function lookupTrackLyrics(track,{force=false}={}){
  if(!settings.onlineLyrics)return{found:false,disabled:true};
  if(!track||track.pending)return{found:false,synced:false};
  if(!force&&(track.lyrics?.plain||track.lyrics?.synced||track.lyrics?.syncedLines?.length))return{found:true,synced:Boolean(syncedLinesFor(track).length)};
  if(!window.firefly?.lookupLyrics)throw new Error('Lyrics lookup requires the Windows app.');
  const result=await window.firefly.lookupLyrics({title:track.title,artist:track.artist,album:track.album,duration:durationSecondsFor(track)});
  if(!result){track.lyrics={plain:'',synced:'',source:'LRCLIB',fetchedAt:Date.now(),notFound:true};return{found:false,synced:false}}
  track.lyrics={...result,syncedLines:parseSyncedLyrics(result.synced||'')};
  return{found:true,synced:Boolean(track.lyrics.syncedLines.length)};
}
async function fetchLyricsForAlbum(album,statusElement=null){
  const tracks=album.tracks.filter(track=>!track.pending);let found=0,synced=0,processed=0;
  for(let index=0;index<tracks.length;index+=3){
    const results=await Promise.allSettled(tracks.slice(index,index+3).map(track=>lookupTrackLyrics(track,{force:true})));
    results.forEach(result=>{if(result.status==='fulfilled'&&result.value.found)found++;if(result.status==='fulfilled'&&result.value.synced)synced++;processed++});
    if(statusElement)statusElement.textContent=`Fetching lyrics ${processed} of ${tracks.length} · ${synced} synchronized`;
  }
  return{found,synced,total:tracks.length};
}
async function metadataLookup(a){
  if(!settings.onlineMetadata){toast('Metadata lookup is disabled','Enable it under Settings · Privacy & control.');return}
  openModal(`<div class="modal-head"><h2>Searching metadata</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status"><span class="spinner"></span><span>Searching MusicBrainz and Cover Art Archive for ${esc(a.artist)} — ${esc(a.title)}…</span></div></div>`);
  let candidates=[];
  try {
    const query=encodeURIComponent(`release:${a.title} AND artist:${a.artist}`);
    const response=await fetch(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=5`,{headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error('Metadata service unavailable');
    const data=await response.json();
    candidates=(data.releases||[]).slice(0,3).map((r,i)=>({
      id:r.id,title:r.title||a.title,artist:r['artist-credit']?.[0]?.name||a.artist,
      year:Number((r.date||'').slice(0,4))||a.year,label:r.status||['Original release','Deluxe edition','Reissue'][i],
      art:`https://coverartarchive.org/release/${r.id}/front-500`
    }));
  } catch(error) { /* Offline mode uses curated visual candidates below. */ }
  const fallback=[
    {title:a.title,artist:a.artist,year:a.year,label:'Original release',cover:'image-cover'},
    {title:a.title,artist:a.artist,year:a.year+1,label:'Deluxe edition',cover:'cover-3'},
    {title:a.title,artist:a.artist,year:a.year,label:'Vinyl reissue',cover:'cover-7'}
  ];
  if(!candidates.length)candidates=fallback;
  const online=Boolean(candidates[0]?.art);
  openModal(`<div class="modal-head"><h2>Choose album artwork</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status">${icon('spark')}<span>${online?'Live results':'Offline matches'} · ${candidates.length} high-confidence choices ${online?'from MusicBrainz and Cover Art Archive':'available'}</span></div><div class="meta-choice-grid">${candidates.map((c,i)=>{
    const style=c.art?`style="background-image:url('${c.art}');background-size:cover;background-position:center"`:'';
    return `<button class="meta-choice" data-meta-index="${i}"><div class="choice-art ${c.cover||'cover-8'}" ${style}></div><div><b>${esc(c.label)}</b><small>${esc(c.artist)} · ${c.year}</small></div></button>`;
  }).join('')}</div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button></div>`);
  $$('[data-meta-index]',modalLayer).forEach(btn=>btn.onclick=async()=>{const c=candidates[Number(btn.dataset.metaIndex)];a.title=c.title;a.artist=c.artist;a.year=c.year;if(c.art){a.customCover=c.art;a.cover=''}else{a.cover=c.cover;a.customCover=null}a.tracks.forEach(t=>{t.album=a.title;t.artist=a.artist});if(a.dynamicCaseArt?.enabled&&a.dynamicCaseArt?.backgroundUrl)a.dynamicCaseArt.status='stale';openModal(`<div class="modal-head"><h2>Applying album information</h2></div><div class="modal-body"><div class="lookup-status"><span class="spinner"></span><span id="lyricsLookupProgress">Fetching lyrics for ${a.tracks.length} tracks…</span></div><p class="modal-intro">Ignifire is saving plain lyrics and using time-synchronized lyrics whenever the provider has them.</p></div>`);const summary=await fetchLyricsForAlbum(a,$('#lyricsLookupProgress')).catch(error=>({found:0,synced:0,total:a.tracks.length,error:error.message}));saveLibrary();closeModal();render();queueDefaultDynamicCase(a);toast('Metadata and lyrics applied',summary.error?`Artwork updated · lyrics unavailable: ${summary.error}`:`${summary.found} lyric sheet${summary.found===1?'':'s'} · ${summary.synced} time-synchronized`) });
}

function coverArtTypes(image){return (image?.types||[]).map(type=>String(type).toLowerCase())}
function coverArtUrl(image){return image?.thumbnails?.['1200']||image?.thumbnails?.large||image?.thumbnails?.['500']||image?.image||null}
function preferredCoverImage(images,type){
  const matches=images.filter(image=>coverArtTypes(image).includes(type)||Boolean(image?.[type]));
  return matches.find(image=>image.approved!==false)||matches[0]||null;
}
async function caseArtLookup(a){
  if(!settings.onlineMetadata){toast('Artwork lookup is disabled','Enable metadata lookup under Settings · Privacy & control.');return}
  openModal(`<div class="modal-head"><h2>Searching full case artwork</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status"><span class="spinner"></span><span>Searching release scans for front, spine, and back artwork for ${esc(a.artist)} — ${esc(a.title)}…</span></div></div>`);
  let cases=[];
  try{
    const query=encodeURIComponent(`release:${a.title} AND artist:${a.artist}`);
    const releaseResponse=await fetch(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=12`,{headers:{Accept:'application/json'}});
    if(!releaseResponse.ok)throw new Error('Release search failed');
    const releases=(await releaseResponse.json()).releases||[];
    const results=await Promise.all(releases.map(async release=>{
      try{
        const artResponse=await fetch(`https://coverartarchive.org/release/${release.id}`);
        if(!artResponse.ok)return null;
        const images=(await artResponse.json()).images||[];
        const front=preferredCoverImage(images,'front');
        const back=preferredCoverImage(images,'back');
        const spine=preferredCoverImage(images,'spine');
        if(!back)return null;
        const sharedBackSpine=Boolean(spine&&String(spine.id)===String(back.id));
        return{id:release.id,title:release.title||a.title,date:release.date||'',country:release.country||'',front:coverArtUrl(front),back:coverArtUrl(back),spine:coverArtUrl(spine),spineMode:spine?(sharedBackSpine?'back-scan':'separate'):null};
      }catch{return null}
    }));
    cases=results.filter(Boolean).sort((left,right)=>(Number(Boolean(right.spine))*100+Number(Boolean(right.front))*10)-(Number(Boolean(left.spine))*100+Number(Boolean(left.front))*10)).slice(0,6);
  }catch{/* The empty state below provides a retry path. */}
  if(!cases.length){
    openModal(`<div class="modal-head"><h2>No case scans found</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="empty-state" style="padding:42px 20px">${icon('image')}<h2>No back-cover scans are available</h2><p>Try another album or release title. Ignifire only shows editions with a genuine back-cover scan in full case-art results.</p></div></div><div class="modal-actions"><button class="ghost close-modal">Close</button><button class="primary" id="retryCaseArt">Retry search</button></div>`,true);$('#retryCaseArt').onclick=()=>caseArtLookup(a);return;
  }
  const realSpineCount=cases.filter(item=>item.spine).length;
  openModal(`<div class="modal-head"><h2>Choose full case artwork</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status">${icon('spark')}<span>${cases.length} release${cases.length===1?'':'s'} with real back art found · ${realSpineCount} with scanned spine art. Editions with spines are listed first.</span></div><div class="case-art-grid">${cases.map((item,index)=>{const spineStyle=item.spine?spineArtworkStyle(item.spine,item.spineMode||'separate'):'';return `<button class="case-art-choice" data-case-index="${index}"><div class="case-art-preview"><span style="background-image:url('${item.back}')"></span><i class="${item.spine?'scanned-spine':'auto-spine-preview'}" style="${spineStyle}">${item.spine?'':'AUTO'}</i><span style="background-image:url('${item.front||item.back}')"></span></div><b>${esc(item.title)}</b><small>${esc([item.country,item.date].filter(Boolean).join(' · ')||'Scanned release')} · Back ✓ · ${item.spine?'Spine scan ✓':'Auto spine'}</small></button>`}).join('')}</div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button></div>`);
  $$('[data-case-index]',modalLayer).forEach(btn=>btn.onclick=()=>{const item=cases[Number(btn.dataset.caseIndex)];a.fullArtParts={front:item.front,back:item.back,spine:item.spine,spineMode:item.spineMode,sourceReleaseId:item.id};a.customFullArt=item.back;if(!a.customCover&&item.front){a.customCover=item.front;a.cover=''}saveLibrary();closeModal();render();toast('Full case artwork applied',item.spine?'Real back and spine scans added.':'Real back cover added; no spine scan exists for this edition, so the text spine will be used.')});
}

function openMasterPlaylistModal(sourceId,targetId){
  const s=customPlaylists.find(p=>p.id===sourceId),t=customPlaylists.find(p=>p.id===targetId);
  openModal(`<div class="modal-head"><h2>Create master playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p style="color:#888;margin-top:0">Combine <b>${esc(s.title)}</b> and <b>${esc(t.title)}</b>. The master stays in sync while each sub-playlist remains playable on its own.</p><div class="field"><label>MASTER PLAYLIST NAME</label><input id="masterName" value="${esc(s.title)} + ${esc(t.title)}" autofocus></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="createMaster">Create master</button></div>`,true);
  $('#createMaster').onclick=()=>{const title=$('#masterName').value.trim();if(!title)return;customPlaylists=customPlaylists.filter(p=>![sourceId,targetId].includes(p.id));customPlaylists.unshift({id:`master-${Date.now()}`,title,color:'#f07157',children:[s,t]});saveLibrary();closeModal();renderPlaylists();toast('Master playlist created',`${title} combines ${s.title} and ${t.title}`)};
}
function newPlaylistModal(){openModal(`<div class="modal-head"><h2>New playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>PLAYLIST NAME</label><input id="playlistName" placeholder="Untitled playlist" autofocus></div><p class="modal-intro">Start listening immediately, or open Cover Studio to make it yours.</p></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="ghost" id="makePlaylist">Create</button><button class="primary" id="makeAndDesignPlaylist">${icon('spark')} Create & design</button></div>`,true);const createPlaylist=design=>{const title=$('#playlistName').value.trim()||'Untitled playlist';const playlist={id:`playlist-${Date.now()}`,title,trackIds:[],color:'#6f8fab'};customPlaylists.unshift(playlist);saveLibrary();closeModal();if(design)setTimeout(()=>playlistCoverStudio(playlist.id),210);else openPlaylist(playlist.id);toast('Playlist created',title)};$('#makePlaylist').onclick=()=>createPlaylist(false);$('#makeAndDesignPlaylist').onclick=()=>createPlaylist(true)}

function openTrackCollection(title,tracks){openModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body" style="padding-top:10px">${songTable(tracks)}</div><div class="modal-actions"><button class="primary" id="playCollection">${icon('play')} Play all</button></div>`);$('#playCollection').onclick=()=>{playTrackQueue(tracks);closeModal()}}

async function detectPlaylistTracks(file){
  if(!('TextDetector' in window)||!window.createImageBitmap)return null;
  try{
    const bitmap=await createImageBitmap(file),blocks=await new TextDetector().detect(bitmap);
    const lines=blocks.map(b=>(b.rawValue||'').trim()).filter(t=>t.length>2&&!/playlist|songs|tracks|duration/i.test(t)).slice(0,20);
    const library=allTracks();
    return lines.map(line=>{const parts=line.split(/\s+[—–|-]\s+/),title=parts[0],artist=parts[1]||'Unknown artist';return{title,artist,found:library.some(t=>t.title.toLowerCase()===title.toLowerCase())}});
  }catch{return null}
}
function screenshotWorkflow(file){
  const reader=new FileReader();reader.onload=async()=>{screenshotData=reader.result;let detected=await detectPlaylistTracks(file);if(!detected?.length)detected=[{title:file.name.replace(/\.[^.]+$/,''),artist:'Unknown artist',found:false}];
  const matched=detected.filter(t=>t.found).length;
  openModal(`<div class="modal-head"><h2>Screenshot scan</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="screenshot-preview"><img src="${screenshotData}" alt="Imported playlist screenshot"></div><div class="lookup-status">${icon('spark')}<span>${detected.length} tracks detected · ${matched} matched locally · ${detected.length-matched} will be pending</span></div><div class="detected-list">${detected.map((t,i)=>`<div class="detected-track"><i class="status-dot ${t.found?'':'pending'}"></i><span><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><em>${t.found?'MATCHED':'PENDING'}</em></div>`).join('')}</div><div class="field" style="margin-top:15px"><label>NEW PLAYLIST NAME</label><input id="scanPlaylistName" value="Imported from screenshot"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="createScanPlaylist">Create playlist</button></div>`);
  $('#createScanPlaylist').onclick=()=>{const title=$('#scanPlaylistName').value.trim()||'Imported playlist';const loose=ensureLooseAlbum(),trackIds=[];detected.forEach((t,i)=>{const match=allTracks().find(x=>x.title.toLowerCase()===t.title.toLowerCase());if(match)trackIds.push(match.id);else{const pending={id:`pending-${Date.now()}-${i}`,title:t.title,artist:t.artist,album:'Pending imports',albumId:loose.id,duration:'—',plays:0,lastPlayed:null,added:0,pending:true,url:null};loose.tracks.push(pending);trackIds.push(pending.id)}});customPlaylists.unshift({id:`scan-${Date.now()}`,title,trackIds,color:'#9b61be'});saveLibrary();closeModal();renderPlaylists();toast('Playlist created','Pending tracks will be skipped until imported.')};};reader.readAsDataURL(file);
}

function ensureLooseAlbum(){let a=albumById('loose-files');if(!a){a={id:'loose-files',title:'Loose Files',artist:'Various Artists',year:new Date().getFullYear(),genre:'Imported',cover:'cover-8',tracks:[]};albums.push(a)}return a}
function cleanTrackTitle(name){return name.replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i,'').replace(/^\d+[\s._-]*/,'').replace(/[_]+/g,' ').trim()}
function displayDuration(seconds){if(!seconds)return'Local';const whole=Math.round(seconds);return`${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`}
function mostCommon(values){const usable=values.filter(Boolean);if(!usable.length)return null;return usable.sort((a,b)=>usable.filter(x=>x===a).length-usable.filter(x=>x===b).length).at(-1)}
function makeTrack(entry,album,index=0){const meta=entry.metadata||{};return{id:`local-${Date.now()}-${index}-${Math.random().toString(36).slice(2,7)}`,title:meta.title||cleanTrackTitle(entry.name),artist:meta.artist||album.artist,album:album.title,albumId:album.id,duration:displayDuration(meta.duration),durationSeconds:Number(meta.duration)||0,trackNumber:meta.track||index+1,discNumber:meta.disc||1,plays:0,lastPlayed:null,added:Date.now(),pending:false,url:entry.url||null,path:entry.path||null,lyrics:meta.lyrics||null}}

function stableLiveKey(value=''){let hash=2166136261;for(const character of String(value)){hash^=character.charCodeAt(0);hash=Math.imul(hash,16777619)}return(hash>>>0).toString(36)}
function liveFolderById(id){return liveFolders.find(folder=>folder.id===id)}
function localLiveFolders(){return liveFolders}
function sourceAtPath(source){const key=String(source?.path||'').replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();return liveFolders.find(folder=>folder.id!==source?.id&&String(folder.path||'').replaceAll('\\','/').replace(/\/+$/,'').toLowerCase()===key)}
function preferredFolderImage(entries,key){return entries.filter(entry=>entry.kind==='image'&&((entry.relativePath||'').split('/').slice(0,-1).join('/'))===key).sort((left,right)=>(/^(cover|folder|front)/i.test(left.name)?-1:1)-(/^(cover|folder|front)/i.test(right.name)?-1:1))[0]||null}
function applyLiveFolderSnapshot(snapshot,{persist=true,notify=true}={}){
  if(!snapshot?.folder?.id)return{added:0,removed:0,updated:0,offline:true};
  let folder=liveFolderById(snapshot.folder.id),priorStatus=folder?.status,priorError=folder?.error;
  if(!folder){folder={...snapshot.folder};liveFolders.push(folder)}else Object.assign(folder,snapshot.folder);
  if(!snapshot.ok){folder.status='offline';folder.error=snapshot.error||'Folder unavailable';if(persist&&(priorStatus!=='offline'||priorError!==folder.error))saveLibrary();if(notify&&priorStatus!=='offline')toast('Live folder is offline',`${folder.name} will reconnect automatically.`);return{added:0,removed:0,updated:0,offline:true}}
  folder.status='synced';folder.error='';folder.lastSyncedAt=snapshot.scannedAt||Date.now();
  const entries=Array.isArray(snapshot.entries)?snapshot.entries:[],audioEntries=entries.filter(entry=>entry.kind==='audio'),activeIds=new Set(audioEntries.map(entry=>entry.liveTrackId));
  const existingTracks=new Map(allTracks().map(track=>[track.id,track])),groups=new Map();
  audioEntries.forEach(entry=>{const parts=(entry.relativePath||entry.name).split('/');parts.pop();const key=parts.join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry)});
  let added=0,updated=0;
  groups.forEach((sourceTracks,key)=>{
    const taggedAlbum=mostCommon(sourceTracks.map(entry=>entry.metadata?.album));
    const isLoose=sourceTracks.length===1&&!taggedAlbum,parts=key.split('/').filter(Boolean),sourceTitle=taggedAlbum||parts.at(-1)||folder.name||'Imported Album';
    const sourceArtist=mostCommon(sourceTracks.map(entry=>entry.metadata?.albumArtist||entry.metadata?.artist))||'Imported Artist';
    const albumId=isLoose?'loose-files':`live-album-${stableLiveKey(`${folder.id}\0${key}\0${sourceTitle}\0${sourceArtist}`)}`;
    let album=albumById(albumId),createdAlbum=false;
    if(!album){album=isLoose?ensureLooseAlbum():applyNewAlbumDefaults({id:albumId,title:sourceTitle,artist:sourceArtist,year:mostCommon(sourceTracks.map(entry=>entry.metadata?.year))||new Date().getFullYear(),genre:mostCommon(sourceTracks.map(entry=>entry.metadata?.genre))||'Imported',cover:'cover-8',customCover:null,fullArt:null,tracks:[]});if(!isLoose)albums.push(album);createdAlbum=true}
    if(!isLoose){album.liveFolderId=folder.id;album.liveFolderKey=key;const image=preferredFolderImage(entries,key),embedded=sourceTracks.find(entry=>entry.metadata?.artwork)?.metadata.artwork,nextCover=image?.url||embedded||null;if(nextCover&&(!album.customCover||album.customCover===album.liveSourceCover)){if(album.customCover!==nextCover)updated++;album.customCover=nextCover;album.cover='';album.liveSourceCover=nextCover}else if(!nextCover&&album.customCover&&album.customCover===album.liveSourceCover){album.customCover=null;album.liveSourceCover=null;album.cover='cover-8';updated++}}
    sourceTracks.forEach((entry,index)=>{
      const meta=entry.metadata||{},sourceMetadata={title:meta.title||cleanTrackTitle(entry.name),artist:meta.artist||album.artist,album:meta.album||album.title,track:Number(meta.track)||index+1,disc:Number(meta.disc)||1};
      let track=existingTracks.get(entry.liveTrackId);
      if(!track){track=makeTrack(entry,album,index);track.id=entry.liveTrackId;track.liveFolderId=folder.id;track.liveManagedAlbumId=album.id;track.sourceModifiedAt=entry.modifiedAt||0;track.sourceSize=entry.size||0;track.sourceMetadataPending=Boolean(entry.metadataError);track.liveSourceMetadata=sourceMetadata;album.tracks.push(track);existingTracks.set(track.id,track);added++}
      else{
        const prior=track.liveSourceMetadata||{},sourceChanged=track.sourceModifiedAt!==entry.modifiedAt||track.sourceSize!==entry.size,metadataResolved=track.sourceMetadataPending&&!entry.metadataError;
        if(sourceChanged||metadataResolved){if(!prior.title||track.title===prior.title)track.title=sourceMetadata.title;if(!prior.artist||track.artist===prior.artist)track.artist=sourceMetadata.artist;track.duration=displayDuration(meta.duration);track.durationSeconds=Number(meta.duration)||0;track.trackNumber=sourceMetadata.track;track.discNumber=sourceMetadata.disc;if(meta.lyrics&&(!track.lyrics||track.lyrics?.source==='Embedded metadata'))track.lyrics=meta.lyrics;updated++}
        const userMoved=track.liveManagedAlbumId&&track.albumId!==track.liveManagedAlbumId;
        if(!userMoved&&track.albumId!==album.id){const oldAlbum=albumById(track.albumId);if(oldAlbum)oldAlbum.tracks=oldAlbum.tracks.filter(item=>item.id!==track.id);if(!album.tracks.includes(track))album.tracks.push(track)}
        if(!userMoved){track.albumId=album.id;track.album=album.title;track.liveManagedAlbumId=album.id}
        track.url=entry.url;track.path=entry.path;track.liveFolderId=folder.id;track.sourceModifiedAt=entry.modifiedAt||0;track.sourceSize=entry.size||0;track.sourceMetadataPending=Boolean(entry.metadataError);track.liveSourceMetadata=sourceMetadata;
      }
    });
    album.tracks.sort((left,right)=>(left.discNumber||1)-(right.discNumber||1)||(left.trackNumber||999)-(right.trackNumber||999));if(createdAlbum&&!isLoose)queueDefaultDynamicCase(album);
  });
  const staleIds=new Set(allTracks().filter(track=>track.liveFolderId===folder.id&&!activeIds.has(track.id)).map(track=>track.id));
  if(staleIds.size){albums.forEach(album=>album.tracks=album.tracks.filter(track=>!staleIds.has(track.id)));playbackQueue=playbackQueue.filter(track=>!staleIds.has(track.id));playbackOriginalQueue=playbackOriginalQueue.filter(track=>!staleIds.has(track.id));staleIds.forEach(id=>selectedTrackIds.delete(id))}
  folder.trackCount=audioEntries.length;folder.albumCount=[...groups.values()].filter(group=>group.length>1||mostCommon(group.map(entry=>entry.metadata?.album))).length;
  if(persist&&(added||staleIds.size||updated||priorStatus!=='synced'))saveLibrary();
  if(notify&&(added||staleIds.size||updated))toast('Live folder synced',`${folder.name} · ${added} added · ${staleIds.size} removed${updated?` · ${updated} refreshed`:''}`);
  return{added,removed:staleIds.size,updated,offline:false};
}
async function initializeLiveFolderSync(){
  if(!window.firefly?.syncLiveFolders)return;
  window.firefly.onLiveFolderSnapshot?.(snapshot=>applyLiveFolderSnapshot(snapshot));
  if(!liveFolders.length)return;
  liveFolders.forEach(folder=>folder.status='scanning');
  try{const snapshots=await window.firefly.syncLiveFolders(liveFolders);let changes=0,offline=0;snapshots.forEach(snapshot=>{const result=applyLiveFolderSnapshot(snapshot,{persist:false,notify:false});changes+=result.added+result.removed+result.updated;offline+=Number(result.offline)});saveLibrary();if(changes)toast('Live folders refreshed',`${changes} library change${changes===1?'':'s'} applied.`);if(offline)toast(`${offline} live folder${offline===1?' is':'s are'} offline`,'Ignifire will keep checking in the background.')}
  catch(error){toast('Could not start live folder sync',error?.message||'Ignifire will retry next time it opens.')}
}
async function addLiveFolder(){
  if(!window.firefly?.addLiveFolder){toast('Live folders are available in the Windows app');return}
  try{const snapshot=await window.firefly.addLiveFolder();if(!snapshot)return;const duplicate=sourceAtPath(snapshot.folder);if(duplicate){window.firefly?.removeLiveFolder?.(snapshot.folder.id);toast('Folder already linked',`${duplicate.name} is already managed as a live folder.`);openFolderManager(duplicate);return}applyLiveFolderSnapshot(snapshot,{notify:false});toast(snapshot.ok?'Live folder connected':'Live folder saved',snapshot.ok?`${snapshot.folder.trackCount} tracks are now kept in sync.`:'Ignifire will keep trying to reconnect.');openLiveFoldersModal()}
  catch(error){toast('Could not add live folder',error?.message||'The selected folder could not be scanned.')}
}
function openFolderManager(){openLiveFoldersModal()}
async function rescanLiveFolder(id){const folder=liveFolderById(id);if(!folder||!window.firefly?.rescanLiveFolder)return;folder.status='scanning';openFolderManager(folder);try{const snapshot=await window.firefly.rescanLiveFolder(folder);applyLiveFolderSnapshot(snapshot);openFolderManager(folder)}catch(error){folder.status='offline';folder.error=error?.message||'Scan failed';saveLibrary();openFolderManager(folder)}}
function removeLiveFolder(id){
  const folder=liveFolderById(id);if(!folder)return;const ids=new Set(allTracks().filter(track=>track.liveFolderId===id).map(track=>track.id));
  confirmRemove('Remove live folder?',`${folder.name} and its ${ids.size} synced track${ids.size===1?'':'s'} will be removed from Ignifire. Files in the source folder stay untouched.`,()=>{albums.forEach(album=>album.tracks=album.tracks.filter(track=>!ids.has(track.id)));customPlaylists.forEach(playlist=>removePlaylistTrackReferences(playlist,ids));playbackQueue=playbackQueue.filter(track=>!ids.has(track.id));playbackOriginalQueue=playbackOriginalQueue.filter(track=>!ids.has(track.id));liveFolders=liveFolders.filter(item=>item.id!==id);window.firefly?.removeLiveFolder?.(id);saveLibrary();render();toast('Live folder removed',folder.name)})
}
function openLiveFoldersModal(){
  const folders=localLiveFolders(),rows=folders.length?folders.map(folder=>`<article class="live-folder-row ${esc(folder.status||'pending')}"><span class="live-folder-icon">${icon('albums')}<i></i></span><div><b>${esc(folder.name)}</b><small title="${esc(folder.path)}">${esc(folder.path)}</small><em>${folder.status==='synced'?`${folder.trackCount||0} tracks · synced ${folder.lastSyncedAt?new Date(folder.lastSyncedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'now'}`:folder.status==='scanning'?'Scanning for changes…':folder.status==='offline'?'Offline · retrying automatically':'Waiting to sync'}</em></div><button class="ghost" data-live-rescan="${esc(folder.id)}">Scan now</button><button class="icon-button danger" data-live-remove="${esc(folder.id)}" title="Remove live folder">${icon('close')}</button></article>`).join(''):`<div class="empty-state compact">${icon('albums')}<h2>No live folders yet</h2><p>Add a music folder and Ignifire will continuously mirror its supported audio files.</p></div>`;
  openModal(`<div class="modal-head"><h2>Live folders</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">Live folders stay outside Ignifire and are watched for new, changed, moved, or deleted music. Disconnected folders remain in your library and reconnect automatically.</p><div class="live-folder-list">${rows}</div></div><div class="modal-actions"><button class="ghost close-modal">Done</button><button class="primary" id="addAnotherLiveFolder">${icon('plus')} Add live folder</button></div>`);
  $('#addAnotherLiveFolder').onclick=addLiveFolder;$$('[data-live-rescan]',modalLayer).forEach(button=>button.onclick=()=>rescanLiveFolder(button.dataset.liveRescan));$$('[data-live-remove]',modalLayer).forEach(button=>button.onclick=()=>removeLiveFolder(button.dataset.liveRemove));
}

function normalizeBrowserFiles(files){return [...files].map(file=>({name:file.name,relativePath:file.webkitRelativePath||file.name,url:URL.createObjectURL(file),kind:file.type.startsWith('image/')?'image':'audio'}))}
function importAudioEntries(entries,targetTrack=null){
  const audioEntries=entries.filter(e=>e.kind!=='image');if(!audioEntries.length){toast('No supported audio files found');return}
  const added=[];
  audioEntries.forEach((entry,index)=>{
    const meta=entry.metadata||{};
    if(targetTrack&&index===0){
      targetTrack.title=meta.title||cleanTrackTitle(entry.name);targetTrack.artist=meta.artist||targetTrack.artist;targetTrack.url=entry.url;targetTrack.path=entry.path||null;targetTrack.pending=false;targetTrack.duration=displayDuration(meta.duration);targetTrack.trackNumber=meta.track||targetTrack.trackNumber||1;targetTrack.discNumber=meta.disc||targetTrack.discNumber||1;
      targetTrack.lyrics=meta.lyrics||targetTrack.lyrics||null;targetTrack.durationSeconds=Number(meta.duration)||targetTrack.durationSeconds||0;
      if(meta.album){const artist=meta.albumArtist||meta.artist||'Unknown Artist';let destination=albums.find(a=>a.title.toLowerCase()===meta.album.toLowerCase()&&a.artist.toLowerCase()===artist.toLowerCase());if(!destination){destination=applyNewAlbumDefaults({id:`tagged-${Date.now()}-${index}`,title:meta.album,artist,year:meta.year||new Date().getFullYear(),genre:meta.genre||'Unknown',cover:meta.artwork?'':'cover-8',customCover:meta.artwork||null,fullArt:null,tracks:[]});albums.push(destination)}const source=albumById(targetTrack.albumId);if(source&&source.id!==destination.id)source.tracks=source.tracks.filter(t=>t.id!==targetTrack.id);if(!destination.tracks.includes(targetTrack))destination.tracks.push(targetTrack);targetTrack.album=destination.title;targetTrack.albumId=destination.id;queueDefaultDynamicCase(destination)}
      added.push(targetTrack);return;
    }
    let album;
    if(meta.album){
      const artist=meta.albumArtist||meta.artist||'Unknown Artist';
      album=albums.find(a=>a.title.toLowerCase()===meta.album.toLowerCase()&&a.artist.toLowerCase()===artist.toLowerCase());
      if(!album){album=applyNewAlbumDefaults({id:`tagged-${Date.now()}-${index}`,title:meta.album,artist,year:meta.year||new Date().getFullYear(),genre:meta.genre||'Unknown',cover:meta.artwork?'':'cover-8',customCover:meta.artwork||null,fullArt:null,tracks:[]});albums.push(album)}
    } else album=ensureLooseAlbum();
    const track=makeTrack(entry,album,index);album.tracks.push(track);album.tracks.sort((a,b)=>(a.discNumber||1)-(b.discNumber||1)||(a.trackNumber||999)-(b.trackNumber||999));added.push(track);queueDefaultDynamicCase(album);
  });
  if(playlistImportTarget){const playlist=findPlaylistById(playlistImportTarget);if(playlist){playlist.trackIds=playlist.trackIds||[];added.forEach(t=>{if(!playlist.trackIds.includes(t.id))playlist.trackIds.push(t.id)})}playlistImportTarget=null}
  saveLibrary();render();toast(`${audioEntries.length} track${audioEntries.length===1?'':'s'} imported`,'Embedded title, artist, album, year, genre, track order, duration, and artwork were applied when available.');
}

function importFolderEntries(folder) {
  const entries=folder.entries||[],audioEntries=entries.filter(e=>e.kind==='audio');
  if(!audioEntries.length){toast('No supported audio files found',folder.name);return}
  const groups=new Map();
  audioEntries.forEach(entry=>{const parts=(entry.relativePath||entry.name).split('/');parts.pop();const key=parts.join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry)});
  let albumCount=0,looseCount=0;
  groups.forEach((tracks,key)=>{
    const taggedAlbum=mostCommon(tracks.map(t=>t.metadata?.album));
    if(tracks.length===1&&!taggedAlbum){const loose=ensureLooseAlbum();loose.tracks.push(makeTrack(tracks[0],loose,loose.tracks.length));looseCount++;return}
    const parts=key.split('/').filter(Boolean),title=taggedAlbum||parts.at(-1)||folder.name||'Imported Album';
    const id=`folder-${Date.now()}-${albumCount}-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`;
    const images=entries.filter(e=>e.kind==='image'&&((e.relativePath||'').split('/').slice(0,-1).join('/'))===key);
    const preferred=images.sort((a,b)=>(/^(cover|folder|front)/i.test(a.name)?-1:1))[0];
    const artist=mostCommon(tracks.map(t=>t.metadata?.albumArtist||t.metadata?.artist))||'Imported Artist';
    const embeddedArt=tracks.find(t=>t.metadata?.artwork)?.metadata.artwork;
    const album=applyNewAlbumDefaults({id,title,artist,year:mostCommon(tracks.map(t=>t.metadata?.year))||new Date().getFullYear(),genre:mostCommon(tracks.map(t=>t.metadata?.genre))||'Imported',cover:(preferred||embeddedArt)?'':'cover-8',customCover:preferred?.url||embeddedArt||null,fullArt:null,tracks:[]});
    album.tracks=tracks.map((entry,index)=>makeTrack(entry,album,index)).sort((a,b)=>(a.discNumber||1)-(b.discNumber||1)||(a.trackNumber||999)-(b.trackNumber||999));albums.push(album);queueDefaultDynamicCase(album);albumCount++;
  });
  saveLibrary();navigate('albums');toast(folder.source==='zip'?'ZIP imported':'Folder imported',`${albumCount} album${albumCount===1?'':'s'} · ${looseCount} loose track${looseCount===1?'':'s'}`);
}

async function chooseFiles(targetTrackId=null){
  if(window.firefly?.chooseMusicFiles){const entries=await window.firefly.chooseMusicFiles();if(entries.length)importAudioEntries(entries,targetTrackId?allTracks().find(t=>t.id===targetTrackId):null)}
  else{$('#audioInput').dataset.targetTrack=targetTrackId||'';$('#audioInput').click()}
}
async function chooseFolder(){
  if(window.firefly?.chooseMusicFolder){const folder=await window.firefly.chooseMusicFolder();if(folder)importFolderEntries(folder)}
  else $('#folderInput').click();
}
async function chooseZip(){
  if(!window.firefly?.chooseMusicZip){toast('ZIP import is available in the Windows app');return}
  try{const archive=await window.firefly.chooseMusicZip();if(archive)importFolderEntries(archive)}catch(error){toast('Could not import ZIP',error?.message||'The archive may be damaged or encrypted.')}
}
function showImportMenu(){const rect=$('#importTrigger').getBoundingClientRect();showContextMenu([{label:'Import music files',icon:'song',action:()=>chooseFiles()},{label:'Import a folder once',icon:'albums',action:chooseFolder},{label:'Add a live folder',icon:'spark',action:addLiveFolder},{label:'Import a ZIP archive',icon:'upload',action:chooseZip},...(localLiveFolders().length?[{separator:true},{label:'Manage live folders',icon:'settings',action:openLiveFoldersModal}]:[])],rect.right-215,rect.bottom+7)}

function showTrackMenu(track){
  if(track.pending){openModal(`<div class="modal-head"><h2>Pending track</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p style="color:#888">${esc(track.title)} by ${esc(track.artist)} is in the playlist but not in your library. Import the matching audio file to activate it and auto-tag its metadata.</p></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="importPending">${icon('upload')} Import audio</button></div>`,true);$('#importPending').onclick=()=>{closeModal();chooseFiles(track.id)};return}
  const sourceAlbum=albumById(track.albumId);
  openModal(`<div class="modal-head"><h2>Edit song</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="form-grid"><div class="field full"><label>SONG TITLE</label><input id="trackTitle" value="${esc(track.title)}"></div><div class="field"><label>ARTIST</label><input id="trackArtist" value="${esc(track.artist)}"></div><div class="field"><label>ALBUM</label><input id="trackAlbum" value="${esc(track.album)}" list="albumNames"><datalist id="albumNames">${albums.map(a=>`<option value="${esc(a.title)}"></option>`).join('')}</datalist></div><div class="field"><label>TRACK NUMBER</label><input id="trackNumber" type="number" min="1" value="${sourceAlbum?sourceAlbum.tracks.indexOf(track)+1:1}"></div><div class="field"><label>GENRE</label><input id="trackGenre" value="${esc(sourceAlbum?.genre||'')}" /></div></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="saveTrack">Save song</button></div>`);
  $('#saveTrack').onclick=()=>{
    const albumName=$('#trackAlbum').value.trim()||track.album;
    let destination=albums.find(a=>a.title.toLowerCase()===albumName.toLowerCase());
    if(!destination){destination=applyNewAlbumDefaults({id:`album-${Date.now()}`,title:albumName,artist:$('#trackArtist').value.trim()||'Unknown Artist',year:new Date().getFullYear(),genre:$('#trackGenre').value.trim()||'Unknown',cover:'cover-8',tracks:[]});albums.push(destination)}
    if(sourceAlbum&&sourceAlbum.id!==destination.id)sourceAlbum.tracks=sourceAlbum.tracks.filter(t=>t.id!==track.id);
    if(!destination.tracks.includes(track))destination.tracks.push(track);
    const nextTitle=$('#trackTitle').value.trim()||track.title,nextArtist=$('#trackArtist').value.trim()||track.artist;
    if(nextTitle!==track.title||nextArtist!==track.artist)delete track.video;
    track.title=nextTitle;track.artist=nextArtist;track.album=destination.title;track.albumId=destination.id;destination.genre=$('#trackGenre').value.trim()||destination.genre;
    const desired=Math.max(0,Number($('#trackNumber').value)-1);destination.tracks=destination.tracks.filter(t=>t!==track);destination.tracks.splice(Math.min(desired,destination.tracks.length),0,track);
    if(sourceAlbum&&sourceAlbum.id==='loose-files'&&!sourceAlbum.tracks.length)albums=albums.filter(a=>a.id!==sourceAlbum.id);
    saveLibrary();closeModal();render();toast('Song updated',`Album: ${destination.title}`)
  };
}

function effectivePlaybackQueue(){return playbackQueueExplicit?playbackQueue:(currentTrack?allTracks().filter(track=>!track.pending):[])}
function materializePlaybackQueue(){if(!playbackQueueExplicit){playbackQueue=effectivePlaybackQueue();playbackOriginalQueue=[...playbackQueue];playbackQueueExplicit=true}}
function queueTracksNext(tracks,label='Selection'){
  const unique=[...new Map((tracks||[]).filter(track=>track&&!track.pending&&track.id!==currentTrack?.id).map(track=>[track.id,track])).values()];
  if(!unique.length){toast('Nothing new to queue',currentTrack?'The current track is already playing.':'No playable tracks were selected.');return}
  if(!currentTrack){playbackQueue=[...unique];playbackOriginalQueue=[...unique];playbackQueueExplicit=true;renderQueue();toast('Added to queue',`${label} will play when playback starts.`);return}
  materializePlaybackQueue();
  if(!playbackQueue.some(track=>track.id===currentTrack.id))playbackQueue.unshift(currentTrack);
  const queuedIds=new Set(unique.map(track=>track.id));playbackQueue=playbackQueue.filter(track=>!queuedIds.has(track.id));
  const currentIndex=Math.max(0,playbackQueue.findIndex(track=>track.id===currentTrack.id));playbackQueue.splice(currentIndex+1,0,...unique);playbackOriginalQueue=[...playbackQueue];playbackQueueExplicit=true;renderQueue();toast('Playing next',`${label} · ${unique.length} track${unique.length===1?'':'s'}`);
}
function shuffledTracks(tracks){const shuffled=[...tracks];for(let index=shuffled.length-1;index>0;index--){const swap=Math.floor(Math.random()*(index+1));[shuffled[index],shuffled[swap]]=[shuffled[swap],shuffled[index]]}return shuffled}
function updatePlaybackModeControls(){
  const shuffle=$('#shuffleBtn'),repeat=$('#repeatBtn');if(!shuffle||!repeat)return;
  shuffle.classList.toggle('active',shuffleEnabled);shuffle.setAttribute('aria-pressed',String(shuffleEnabled));shuffle.title=shuffleEnabled?'Shuffle on':'Shuffle off';
  repeat.classList.toggle('active',repeatMode!=='off');repeat.classList.toggle('repeat-one',repeatMode==='one');repeat.setAttribute('aria-label',repeatMode==='one'?'Repeat one':repeatMode==='all'?'Repeat all':'Repeat off');repeat.title=repeat.getAttribute('aria-label');
}
function setShuffleEnabled(enabled,{persist=true,reorder=true}={}){
  shuffleEnabled=Boolean(enabled);settings.shuffle=shuffleEnabled;
  if(reorder&&shuffleEnabled&&!playbackQueueExplicit&&currentTrack)materializePlaybackQueue();
  if(reorder&&playbackQueueExplicit&&playbackQueue.length){
    if(!playbackOriginalQueue.length)playbackOriginalQueue=[...playbackQueue];
    if(shuffleEnabled){const current=playbackQueue.find(track=>track.id===currentTrack?.id);const rest=playbackOriginalQueue.filter(track=>track.id!==current?.id);playbackQueue=current?[current,...shuffledTracks(rest)]:shuffledTracks(rest)}
    else playbackQueue=playbackOriginalQueue.filter(track=>allTracks().some(item=>item.id===track.id));
  }
  updatePlaybackModeControls();renderQueue();if(persist)saveLibrary();
}
function cycleRepeatMode(){repeatMode=repeatMode==='off'?'all':repeatMode==='all'?'one':'off';settings.repeatMode=repeatMode;updatePlaybackModeControls();saveLibrary();toast(repeatMode==='one'?'Repeating current song':repeatMode==='all'?'Repeating queue':'Repeat off')}
function renderQueue(){
  const list=$('#queueList'),button=$('#queueButton'),badge=$('#queueCount'),summary=$('#queueSummary');if(!list||!button)return;
  const validIds=new Set(allTracks().map(track=>track.id));if(playbackQueueExplicit){playbackQueue=playbackQueue.filter(track=>validIds.has(track.id));playbackOriginalQueue=playbackOriginalQueue.filter(track=>validIds.has(track.id))}
  const tracks=effectivePlaybackQueue(),currentIndex=currentTrack?tracks.findIndex(track=>track.id===currentTrack.id):-1;
  badge.textContent=tracks.length>99?'99+':tracks.length;badge.classList.toggle('visible',tracks.length>0);button.classList.toggle('active',$('#queuePanel').classList.contains('open'));
  summary.textContent=tracks.length?`${tracks.length} track${tracks.length===1?'':'s'} · ${playbackQueueExplicit?'Active collection':'Library order'}`:'No songs queued';
  if(!tracks.length){list.innerHTML=`<div class="queue-empty">${icon('list')}<b>Your queue is empty</b><span>Play an album, artist, or playlist to fill it.</span></div>`;return}
  list.innerHTML=tracks.map((track,index)=>{const album=albumById(track.albumId),style=album?.customCover?`style="background-image:url(&quot;${esc(album.customCover)}&quot;)"`:'';return `<article class="queue-item ${index===currentIndex?'current':''}" draggable="true" data-queue-track="${track.id}"><button class="queue-grip" aria-label="Reorder ${esc(track.title)}">⋮⋮</button><button class="queue-track-main" data-queue-play="${track.id}"><span class="queue-position">${index===currentIndex?icon(isPlaying?'pause':'play'):index+1}</span><span class="thumb ${album?.cover||'cover-8'}" ${style}></span><span class="queue-copy"><b>${esc(track.title)}</b><small>${esc(track.artist)} · ${esc(track.album)}</small></span></button><button class="queue-remove" data-queue-remove="${track.id}" aria-label="Remove ${esc(track.title)} from queue">${icon('close')}</button></article>`}).join('');
  $$('[data-queue-play]',list).forEach(row=>row.onclick=()=>{materializePlaybackQueue();const track=playbackQueue.find(item=>item.id===row.dataset.queuePlay);if(track)playTrack(track,true)});
  $$('[data-queue-remove]',list).forEach(remove=>remove.onclick=()=>{materializePlaybackQueue();playbackQueue=playbackQueue.filter(track=>track.id!==remove.dataset.queueRemove);playbackOriginalQueue=playbackOriginalQueue.filter(track=>track.id!==remove.dataset.queueRemove);renderQueue()});
  $$('[data-queue-track]',list).forEach(row=>{row.addEventListener('dragstart',()=>{materializePlaybackQueue();draggedQueueTrack=row.dataset.queueTrack;row.classList.add('dragging')});row.addEventListener('dragend',()=>{draggedQueueTrack=null;row.classList.remove('dragging');$$('.queue-drop-target',list).forEach(item=>item.classList.remove('queue-drop-target'))});row.addEventListener('dragover',event=>{event.preventDefault();if(row.dataset.queueTrack!==draggedQueueTrack)row.classList.add('queue-drop-target')});row.addEventListener('dragleave',()=>row.classList.remove('queue-drop-target'));row.addEventListener('drop',event=>{event.preventDefault();const targetId=row.dataset.queueTrack;if(!draggedQueueTrack||draggedQueueTrack===targetId)return;const from=playbackQueue.findIndex(track=>track.id===draggedQueueTrack),to=playbackQueue.findIndex(track=>track.id===targetId);if(from<0||to<0)return;const[moved]=playbackQueue.splice(from,1);playbackQueue.splice(to,0,moved);playbackOriginalQueue=[...playbackQueue];renderQueue()})});
}
function openQueue(){const panel=$('#queuePanel');panel.classList.add('open');panel.setAttribute('aria-hidden','false');$('#queueBackdrop').classList.add('open');$('#queueButton').setAttribute('aria-expanded','true');renderQueue()}
function closeQueue(){const panel=$('#queuePanel');panel.classList.remove('open');panel.setAttribute('aria-hidden','true');$('#queueBackdrop').classList.remove('open');$('#queueButton').setAttribute('aria-expanded','false');renderQueue()}
function clearPlaybackQueue(){playbackQueue=[];playbackOriginalQueue=[];playbackQueueExplicit=true;renderQueue();toast('Queue cleared','The current song will keep playing.')}
function refreshVisiblePlayStats(track){
  $$('tr[data-track]').forEach(row=>{if(row.dataset.track!==track.id)return;const cells=row.querySelectorAll('td');if(cells[3])cells[3].textContent=String(track.plays)});
  const backlog=$('[data-smart="backlog"] b',view),old=$('[data-smart="old"] b',view),hits=$('[data-smart="hits"] b',view);
  if(backlog)backlog.textContent=String(allTracks().filter(item=>!item.lastPlayed).length);
  if(old)old.textContent=String(allTracks().filter(isOldBanger).length);
  if(hits)hits.textContent=String(Math.min(50,allTracks().filter(item=>!item.pending).length));
}
function commitPlayCount(track){
  if(!track||track.pending||pendingPlayCountTrackId!==track.id)return false;
  pendingPlayCountTrackId=null;track.plays=(Number(track.plays)||0)+1;track.lastPlayed=Date.now();playHistory.push({trackId:track.id,playedAt:track.lastPlayed});if(playHistory.length>2500)playHistory=playHistory.slice(-2500);saveLibrary();refreshVisiblePlayStats(track);return true;
}
function playTrackQueue(tracks,shuffle=shuffleEnabled,context=null,startTrackId=''){
  const nextQueue=tracks.filter(track=>!track.pending);if(!nextQueue.length){toast('No playable tracks');return}
  playbackContext=context?.type==='playlist'&&context.id?{type:'playlist',id:context.id}:null;
  playbackOriginalQueue=[...nextQueue];playbackQueue=shuffle?shuffledTracks(nextQueue):[...nextQueue];playbackQueueExplicit=true;setShuffleEnabled(shuffle,{persist:true,reorder:false});
  const startTrack=playbackQueue.find(track=>track.id===startTrackId)||playbackQueue[0];
  playTrack(startTrack,true);
}
function syncNativePlaybackState(){
  const album=albumById(currentTrack?.albumId),durationSeconds=currentTrack?.url?(Number(audio.duration)||Number(currentTrack?.durationSeconds)||0):(Number(currentTrack?.durationSeconds)||272),positionSeconds=currentTrack?.url?(Number(audio.currentTime)||0):durationSeconds*simProgress/100;
  const state={playing:isPlaying,hasTrack:Boolean(currentTrack&&!currentTrack.pending),title:currentTrack?.title||'',artist:currentTrack?.artist||'',album:currentTrack?.album||'',durationSeconds,positionSeconds,artworkUrl:/^https:\/\//i.test(album?.customCover||'')?album.customCover:''};
  window.firefly?.setPlaybackState?.(state);
  if('mediaSession' in navigator){
    try{navigator.mediaSession.metadata=currentTrack?new MediaMetadata({title:state.title,artist:state.artist,album:state.album}):null;navigator.mediaSession.playbackState=state.hasTrack?(state.playing?'playing':'paused'):'none'}catch{/* Windows thumbnail controls remain available if Media Session metadata is unavailable. */}
  }
}
function playTrack(track,preserveQueue=false){
  if(!track){toast('Nothing to play','Import music first.');return}
  if(track.pending){toast('Skipped pending track','Import the audio file to make this track playable.');return}
  if(!preserveQueue){playbackContext=null;if(shuffleEnabled){const library=allTracks().filter(item=>!item.pending),rest=library.filter(item=>item.id!==track.id);playbackOriginalQueue=[...library];playbackQueue=[track,...shuffledTracks(rest)];playbackQueueExplicit=true}else{playbackQueue=[];playbackOriginalQueue=[];playbackQueueExplicit=false}}
  pendingPlayCountTrackId=track.id;
  currentTrack=track;const a=albumById(track.albumId);$('#nowTitle').textContent=track.title;$('#nowArtist').textContent=`${track.artist} · ${track.album}`;$('#fullTitle').textContent=track.title;$('#fullArtist').textContent=`${track.artist} · ${track.album}`;updateFavoriteControl();
  $$('.now-cover').forEach(c=>{c.className=`now-cover ${a?.cover||'cover-8'}`;if(a?.customCover){c.style.backgroundImage=`url('${a.customCover}')`;c.style.backgroundSize='cover'}});
  updateFullscreenArtistBackdrop(track);updatePlayerPlaybackContext();updatePlayingTrackRows();
  renderQueue();
  syncNativePlaybackState();
  if(track.url){audio.volume=settings.muted?0:settings.volume/100;audio.src=track.url;audio.playbackRate=Math.max(.5,Math.min(2,Number(settings.playbackRate)||1));audio.play().then(()=>setPlaying(true)).catch(()=>setPlaying(false));}else{simProgress=0;setRange($('#progress'),0);setPlaying(true);commitPlayCount(track)}
  if($('#fullscreenPlayer').classList.contains('open')){if(fullscreenMode==='video')prepareTrackVideo(track);if(fullscreenMode==='lyrics')renderLyricsStage(track)}
}
function setPlaying(value){isPlaying=value;const name=value?'pause':'play';$('#playBtn').innerHTML=icon(name);$('#fullPlay').innerHTML=icon(name);renderQueue();updatePlayingTrackRows();syncNativePlaybackState();clearInterval(simTimer);if(value&&!currentTrack.url){simTimer=setInterval(()=>{simProgress=(simProgress+.22)%100;setRange($('#progress'),simProgress);$('#elapsed').textContent=formatTime(simProgress*2.72);if(Date.now()-lastDiscordProgressSync>15000){lastDiscordProgressSync=Date.now();syncNativePlaybackState()}},1000)}}
function startShuffledLibrary(){
  const library=allTracks().filter(track=>!track.pending);if(!library.length){toast('Nothing to play','Import music first.');return false}
  playbackContext=null;playbackOriginalQueue=[...library];playbackQueue=shuffledTracks(library);playbackQueueExplicit=true;setShuffleEnabled(true,{persist:true,reorder:false});playTrack(playbackQueue[0],true);return true
}
function togglePlay(){if(isPlaying){if(currentTrack?.url)audio.pause();else setPlaying(false);return}if(!effectivePlaybackQueue().length){startShuffledLibrary();return}if(!currentTrack){playTrack(effectivePlaybackQueue()[0],true);return}if(currentTrack.url)audio.play().catch(()=>setPlaying(false));else setPlaying(true)}
function formatTime(s){s=Math.floor(s);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
function nextTrack(dir=1,{ended=false}={}){const tracks=effectivePlaybackQueue();if(!tracks.length){toast(playbackQueueExplicit?'Queue finished':'Nothing to play',playbackQueueExplicit?'Add songs or start another collection.':'Import music first.');return}const idx=currentTrack?tracks.findIndex(t=>t.id===currentTrack.id):-1;if(ended&&settings.stopAfterCurrent){settings.stopAfterCurrent=false;setPlaying(false);saveLibrary();toast('Stopped after current track');return}if(ended&&!settings.autoplayNext){setPlaying(false);renderQueue();return}if(ended&&repeatMode==='one'){playTrack(currentTrack,true);return}if(ended&&idx===tracks.length-1&&repeatMode==='off'){setPlaying(false);renderQueue();return}const next=idx<0?(dir>=0?0:tracks.length-1):(idx+dir+tracks.length)%tracks.length;playTrack(tracks[next],playbackQueueExplicit)}
function handleNativeMediaCommand(command){
  if(command==='toggle'){togglePlay();return}
  if(command==='next'){nextTrack(1);return}
  if(command==='previous'){nextTrack(-1);return}
  if(command==='play'){if(!effectivePlaybackQueue().length){startShuffledLibrary();return}if(!currentTrack){playTrack(effectivePlaybackQueue()[0],true);return}if(currentTrack.url){if(audio.paused)audio.play().catch(()=>setPlaying(false))}else setPlaying(true);return}
  if(command==='pause'){if(currentTrack?.url)audio.pause();else if(currentTrack)setPlaying(false);return}
  if(command==='stop'){if(currentTrack?.url){audio.pause();try{audio.currentTime=0}catch{/* A not-yet-loaded cloud track may not be seekable. */}}else simProgress=0;setRange($('#progress'),0);$('#elapsed').textContent='0:00';setPlaying(false)}
}
function installMediaSessionHandlers(){
  if(!('mediaSession' in navigator))return;
  const actions={play:'play',pause:'pause',nexttrack:'next',previoustrack:'previous',stop:'stop'};
  Object.entries(actions).forEach(([action,command])=>{try{navigator.mediaSession.setActionHandler(action,()=>handleNativeMediaCommand(command))}catch{/* Unsupported actions fall back to the registered Windows media keys. */}});
  try{navigator.mediaSession.setActionHandler('seekbackward',details=>{if(currentTrack?.url&&audio.duration)audio.currentTime=Math.max(0,audio.currentTime-(details.seekOffset||10))});navigator.mediaSession.setActionHandler('seekforward',details=>{if(currentTrack?.url&&audio.duration)audio.currentTime=Math.min(audio.duration,audio.currentTime+(details.seekOffset||10))});navigator.mediaSession.setActionHandler('seekto',details=>{if(currentTrack?.url&&audio.duration&&Number.isFinite(details.seekTime))audio.currentTime=Math.max(0,Math.min(audio.duration,details.seekTime))})}catch{/* Seeking is optional on older Windows media surfaces. */}
}
function updateVolumeControls(){const slider=$('#volume'),button=$('#volumeMute');if(!slider||!button)return;setRange(slider,settings.volume);button.innerHTML=icon(settings.muted||settings.volume===0?'mute':'volume');button.classList.toggle('active',Boolean(settings.muted));button.setAttribute('aria-label',settings.muted?'Unmute':'Mute');button.title=button.getAttribute('aria-label')}
function persistVolumeSoon(){clearTimeout(volumePersistenceTimer);volumePersistenceTimer=setTimeout(()=>saveLibrary(),350)}
function setVolume(value){settings.volume=Math.max(0,Math.min(100,Number(value)||0));settings.muted=settings.volume===0;if(settings.volume>0)lastAudibleVolume=settings.volume;audio.volume=settings.muted?0:settings.volume/100;updateVolumeControls();persistVolumeSoon()}
function updatePlaybackEnvelope(){if(!audio.duration||settings.muted)return;const fade=Math.max(0,Math.min(12,Number(settings.crossfade)||0)),remaining=audio.duration-audio.currentTime,gain=fade&&remaining<fade?Math.max(.18,remaining/fade):1;audio.volume=settings.volume/100*gain}
function toggleMute(){settings.muted=!settings.muted;if(!settings.muted&&settings.volume===0)settings.volume=lastAudibleVolume||72;audio.volume=settings.muted?0:settings.volume/100;updateVolumeControls();saveLibrary();toast(settings.muted?'Muted':'Sound on')}

function videoFromUrl(resource){
  if(!resource)return null;
  try{
    const url=new URL(resource),host=url.hostname.replace(/^www\./,'').toLowerCase();
    let id=null,provider=null,embedUrl=null;
    if(host==='youtu.be')id=url.pathname.split('/').filter(Boolean)[0];
    else if(host.endsWith('youtube.com'))id=url.searchParams.get('v')||url.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1];
    if(id&&/^[A-Za-z0-9_-]{11}$/.test(id)){provider='YouTube';embedUrl=`https://www.youtube.com/embed/${id}?autoplay=1&controls=1&rel=0`}
    if(!embedUrl&&host.endsWith('vimeo.com')){id=url.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];if(id){provider='Vimeo';embedUrl=`https://player.vimeo.com/video/${id}?autoplay=1`}}
    if(!embedUrl&&host.endsWith('dailymotion.com')){id=url.pathname.match(/\/video\/([A-Za-z0-9]+)/)?.[1];if(id){provider='Dailymotion';embedUrl=`https://www.dailymotion.com/embed/video/${id}?autoplay=1`}}
    return embedUrl?{provider,embedUrl,sourceUrl:resource,videoId:id}:null;
  }catch{return null}
}
function videoFromRelations(relations=[],allowAnyVideoLink=false){
  for(const relation of relations){
    const resource=relation?.url?.resource;
    const descriptor=[relation?.type,...(relation?.attributes||[])].join(' ').toLowerCase();
    if(!allowAnyVideoLink&&!descriptor.includes('video'))continue;
    const playable=videoFromUrl(resource);
    if(playable)return{...playable,relationType:relation.type||'video'};
  }
  return null;
}
const VIDEO_FINDER_VERSION=2;
function normalizedVideoWords(value=''){return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[’']/g,'').replace(/[^a-z0-9]+/gi,' ').trim().toLowerCase()}
function coreVideoTitle(value=''){
  return normalizedVideoWords(String(value).replace(/\s*[\[(][^\])]*(?:official|music video|official video|video|lyrics?|audio|visuali[sz]er|remaster(?:ed)?|4k|hd)[^\])]*[\])]/gi,' ').replace(/\b(?:official music video|official video|music video|official|video|4k|hd|hq|remastered?)\b/gi,' '));
}
function videoWordSet(value=''){return new Set(normalizedVideoWords(value).split(' ').filter(word=>word.length>1&&!['the','a','an','and','feat','featuring','ft','with'].includes(word)))}
function parsedVideoDuration(value=''){const parts=String(value).trim().split(':').map(Number);if(!parts.length||parts.some(part=>!Number.isFinite(part)))return 0;return parts.reduce((seconds,part)=>seconds*60+part,0)}
function rankedYouTubeVideos(results=[],track){
  const titleCore=coreVideoTitle(track.title),titleWords=videoWordSet(titleCore),artistCore=normalizedVideoWords(track.artist),leadArtist=normalizedVideoWords(String(track.artist).split(/\s+(?:feat(?:uring)?|ft\.?|with)\s+/i)[0]),artistWords=videoWordSet(leadArtist),trackWantsLive=/\blive\b/i.test(track.title),trackWantsRemix=/\bremix\b/i.test(track.title),trackDuration=Number(track.durationSeconds)||0;
  return results.map(video=>{
    const rawTitle=String(video.title||''),rawChannel=String(video.channel||''),candidateCore=coreVideoTitle(rawTitle),candidateWords=videoWordSet(candidateCore),haystack=normalizedVideoWords(`${rawTitle} ${rawChannel}`),badges=normalizedVideoWords((video.badges||[]).join(' '));
    const titleMatches=[...titleWords].filter(word=>candidateWords.has(word)).length,titleOverlap=titleWords.size?titleMatches/titleWords.size:0,artistMatches=[...artistWords].filter(word=>haystack.includes(word)).length,artistOverlap=artistWords.size?artistMatches/artistWords.size:0;
    const exactTitle=Boolean(titleCore&&candidateCore&&(candidateCore===titleCore||candidateCore.endsWith(` ${titleCore}`)||candidateCore.startsWith(`${titleCore} `))),artistInTitle=Boolean(artistCore&&normalizedVideoWords(rawTitle).includes(artistCore)),artistInChannel=Boolean(leadArtist&&normalizedVideoWords(rawChannel).includes(leadArtist)),officialArtist=/official artist channel/.test(badges),verified=/verified|official artist/.test(badges),vevo=/vevo\b/i.test(rawChannel);
    let score=titleOverlap*105+artistOverlap*35+Number(exactTitle)*60+Number(artistInTitle)*42+Number(artistInChannel)*52+Number(officialArtist)*38+Number(verified)*18+Number(vevo)*28+Number(/official music video/i.test(rawTitle))*46+Number(/official video/i.test(rawTitle))*34+Number(/music video/i.test(rawTitle))*18-Math.min(14,Number(video.resultIndex)||0)-Math.min(8,(Number(video.queryIndex)||0)*3);
    const rejectors=[[/\bkaraoke\b/i,170],[/\bcover\b/i,135],[/\breaction\b|reacts?\s+to/i,150],[/\btutorial\b|how to play/i,125],[/\bfan[ -]?made\b|unofficial/i,95],[/\bslowed\b|\breverb\b|sped up|nightcore/i,120],[/\btrailer\b|teaser/i,90]];rejectors.forEach(([pattern,penalty])=>{if(pattern.test(`${rawTitle} ${rawChannel}`))score-=penalty});
    if(!trackWantsLive&&/\blive\b|live at|live from|concert|performance/i.test(rawTitle))score-=82;if(!trackWantsRemix&&/\bremix\b|\bmix\b/i.test(rawTitle))score-=62;if(/lyrics?|official audio|audio only|visuali[sz]er/i.test(rawTitle))score-=68;
    const candidateDuration=parsedVideoDuration(video.duration);if(trackDuration&&candidateDuration){const ratio=candidateDuration/trackDuration;if(ratio>=.78&&ratio<=1.35)score+=16;else if(ratio<.55||ratio>1.85)score-=38}
    const descriptor=`${rawTitle} ${rawChannel}`,artistEvidence=artistInTitle||artistInChannel||artistOverlap>=.66||vevo,explicitVideo=/official music video|official video|music video/i.test(rawTitle),trustedPublisher=officialArtist||verified||vevo||artistInChannel;
    const wrongVariant=(!trackWantsLive&&/\blive\b|live at|live from|concert|performance|late show|award show/i.test(descriptor))||(!trackWantsRemix&&/\bremix\b|\bmix\b/i.test(rawTitle))||/behind the scenes|making of|official audio|audio only|lyrics?|visuali[sz]er|instrumental|commentary|commercial|advert|dance video|dance practice|challenge|tik ?tok|interview/i.test(descriptor);
    const hardReject=/\bkaraoke\b|\bcover\b|\breaction\b|reacts?\s+to|\btutorial\b|how to play|fan[ -]?made|unofficial|\bslowed\b|\breverb\b|sped up|nightcore|\btrailer\b|teaser/i.test(descriptor);
    const eligible=titleOverlap>=.58&&artistEvidence&&(explicitVideo||trustedPublisher)&&score>=112&&!wrongVariant&&!hardReject&&!/LIVE|PREMIERE/i.test(video.duration||'');
    return{...video,score:Math.round(score),titleOverlap,artistEvidence,eligible};
  }).filter(video=>video.eligible).sort((left,right)=>right.score-left.score||left.queryIndex-right.queryIndex||left.resultIndex-right.resultIndex);
}
const waitForMusicBrainz=()=>new Promise(resolve=>setTimeout(resolve,1100));
async function discoverExistingMusicVideo(track){
  if(!settings.onlineMusicVideos)return{status:'not-found',finderVersion:VIDEO_FINDER_VERSION,searchedAt:Date.now(),disabled:true};
  const cached=track.video;
  if(cached?.status==='found'&&cached.embedUrl)return cached;
  if(cached?.finderVersion===VIDEO_FINDER_VERSION&&cached?.status==='not-found'&&Date.now()-(cached.searchedAt||0)<VIDEO_RECHECK_MS)return cached;
  if(cached?.finderVersion===VIDEO_FINDER_VERSION&&cached?.status==='generating'&&cached.searchedAt)return cached;
  const luceneValue=value=>String(value||'').replace(/["\\]/g,' ').trim();
  const baseQuery=`recording:"${luceneValue(track.title)}" AND artist:"${luceneValue(track.artist)}"`;
  const rememberPlayable=(recording,playable)=>{track.video={status:'found',finderVersion:VIDEO_FINDER_VERSION,searchedAt:Date.now(),recordingId:recording?.id||null,...playable};saveLibrary();return track.video};
  if(window.firefly?.searchYouTubeVideos){
    try{
      const ranked=rankedYouTubeVideos(await window.firefly.searchYouTubeVideos({title:track.title,artist:track.artist,album:track.album}),track),best=ranked[0];
      if(best){const playable=videoFromUrl(best.sourceUrl),alternatives=ranked.slice(1).filter(video=>video.score>=best.score-85).slice(0,6).map(video=>({sourceUrl:video.sourceUrl,resultTitle:video.title,channel:video.channel,matchScore:video.score,videoId:video.videoId}));if(playable)return rememberPlayable(null,{...playable,discoverySource:'YouTube Search',resultTitle:best.title,channel:best.channel,matchScore:best.score,alternatives})}
    }catch(error){console.warn('Direct YouTube video search failed; trying recording links.',error)}
  }
  let videoSearchResponse;
  try{videoSearchResponse=await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(`${baseQuery} AND video:true`)}&fmt=json&limit=10`,{headers:{Accept:'application/json'}})}catch{throw new Error('Music-video search is offline')}
  if(!videoSearchResponse.ok)throw new Error('Music-video search service unavailable');
  const videoRecordings=(await videoSearchResponse.json()).recordings||[];
  videoRecordings.sort((left,right)=>{
    const score=recording=>{const description=String(recording.disambiguation||'').toLowerCase(),statuses=(recording.releases||[]).map(release=>String(release.status||'').toLowerCase());return Number(description.includes('official music video'))*120+Number(description.includes('music video'))*60-Number(description.includes('live'))*80-Number(statuses.includes('bootleg'))*30+Number(statuses.includes('official'))*10};
    return score(right)-score(left);
  });
  for(const recording of videoRecordings.slice(0,5)){
    await waitForMusicBrainz();
    const response=await fetch(`https://musicbrainz.org/ws/2/recording/${recording.id}?inc=url-rels&fmt=json`,{headers:{Accept:'application/json'}});
    if(!response.ok)continue;
    const playable=videoFromRelations((await response.json()).relations,true);
    if(playable)return rememberPlayable(recording,playable);
  }
  await waitForMusicBrainz();
  const query=encodeURIComponent(baseQuery);
  let searchResponse;
  try{searchResponse=await fetch(`https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=10`,{headers:{Accept:'application/json'}})}catch{throw new Error('Music-video search is offline')}
  if(!searchResponse.ok)throw new Error('Music-video search service unavailable');
  const recordings=(await searchResponse.json()).recordings||[];
  if(!recordings.length){track.video={status:'not-found',finderVersion:VIDEO_FINDER_VERSION,searchedAt:Date.now()};saveLibrary();return track.video}
  const exact=value=>String(value||'').normalize('NFKD').replace(/[‐‑‒–—−]/g,'-').trim().toLowerCase();
  recordings.sort((left,right)=>{
    const score=item=>Number(exact(item.title)===exact(track.title))*20+Number((item['artist-credit']||[]).some(credit=>exact(credit.name)===exact(track.artist)))*15-Number(/live|remix|mix|karaoke|cover/i.test(item.disambiguation||''))*25;
    return score(right)-score(left);
  });
  for(const recording of recordings.slice(0,3)){
    await waitForMusicBrainz();
    const detailResponse=await fetch(`https://musicbrainz.org/ws/2/recording/${recording.id}?inc=url-rels+recording-rels&fmt=json`,{headers:{Accept:'application/json'}});
    if(!detailResponse.ok)continue;
    const details=await detailResponse.json();
    let playable=videoFromRelations(details.relations);
    if(!playable){
      const musicVideoTarget=(details.relations||[]).find(relation=>/music video/i.test(relation.type||'')&&relation.recording?.id)?.recording;
      if(musicVideoTarget){
        await waitForMusicBrainz();
        const videoResponse=await fetch(`https://musicbrainz.org/ws/2/recording/${musicVideoTarget.id}?inc=url-rels&fmt=json`,{headers:{Accept:'application/json'}});
        if(videoResponse.ok)playable=videoFromRelations((await videoResponse.json()).relations,true);
      }
    }
    if(playable)return rememberPlayable(recording,playable);
  }
  track.video={status:'not-found',finderVersion:VIDEO_FINDER_VERSION,searchedAt:Date.now()};saveLibrary();return track.video;
}
function renderVideoStatus(kind,video={}){
  const stage=$('#videoStage'),host=$('#onlineVideoHost'),card=$('#videoStatusCard');
  stage.classList.toggle('online-video',kind==='found');stage.classList.toggle('ai-video',kind==='generating');
  host.innerHTML='';
  if(kind==='searching')card.innerHTML=`<span class="spinner"></span><div><b>Searching for an existing music video</b><small>Checking multiple title variants, official channels, and verified recording links</small></div>`;
  if(kind==='found'){
    const playerOrigin=location.origin.startsWith('http')?location.origin:'https://ignifire.local';
    const embedUrl=video.provider==='YouTube'?`${video.embedUrl}&origin=${encodeURIComponent(playerOrigin)}`:video.embedUrl;
    host.innerHTML=window.firefly?.platform==='win32'
      ? `<webview class="online-video-frame" src="${embedUrl}" title="${esc(currentTrack?.artist)} — ${esc(currentTrack?.title)} music video" webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"></webview>`
      : `<iframe class="online-video-frame" src="${embedUrl}" title="${esc(currentTrack?.artist)} — ${esc(currentTrack?.title)} music video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    const matchDetail=video.discoverySource==='YouTube Search'?`Ranked by title, artist, official channel, and video type${video.channel?` · ${esc(video.channel)}`:''}`:'Matched through a verified MusicBrainz recording relationship';
    card.innerHTML=`<span class="video-found-dot"></span><div><b>Existing video found on ${esc(video.provider)}</b><small>${matchDetail} · <a href="${video.sourceUrl}" target="_blank" rel="noreferrer">Open source</a></small></div>${video.alternatives?.length?'<button data-video-action="next-result">Try another result</button>':''}<button data-video-action="search-again">Search again</button>`;
    if($('#fullscreenPlayer').classList.contains('video')){if(currentTrack?.url&&!audio.paused)audio.pause();else if(!currentTrack?.url)setPlaying(false)}
  }
  if(kind==='generating')card.innerHTML=`<span class="spinner"></span><div><b>No existing video found · generating with AI</b><small>Search completed first · generation continues in the background</small></div>`;
  if(kind==='no-key')card.innerHTML=`<span class="video-missing-dot"></span><div><b>No existing music video found</b><small>Connect OpenAI to generate one after this completed search</small></div><button data-video-action="open-settings">Open settings</button><button data-video-action="search-again">Retry</button>`;
  if(kind==='error')card.innerHTML=`<span class="video-missing-dot"></span><div><b>Couldn’t complete the online video search</b><small>AI generation has not started · ${esc(video.message||'Check your connection and retry.')}</small></div><button data-video-action="search-again">Retry search</button>`;
}
function queueAIVideo(track){
  if(!credentials.openaiKey){renderVideoStatus('no-key');return}
  if(track.video?.status!=='generating'||track.video?.finderVersion!==VIDEO_FINDER_VERSION){track.video={status:'generating',finderVersion:VIDEO_FINDER_VERSION,searchedAt:track.video?.searchedAt||Date.now(),queuedAt:Date.now(),prompt:`Music video for ${track.artist} — ${track.title}, inspired by the album artwork and musical style.`};saveLibrary()}
  renderVideoStatus('generating',track.video);
}
function useNextVideoResult(track=currentTrack){
  const video=track?.video,next=video?.alternatives?.[0];if(!next)return;
  const playable=videoFromUrl(next.sourceUrl);if(!playable)return;
  const current={sourceUrl:video.sourceUrl,resultTitle:video.resultTitle,channel:video.channel,matchScore:video.matchScore,videoId:video.videoId};
  track.video={...video,...playable,resultTitle:next.resultTitle,channel:next.channel,matchScore:next.matchScore,alternatives:[...video.alternatives.slice(1),current]};saveLibrary();renderVideoStatus('found',track.video);
}
async function prepareTrackVideo(track,force=false){
  if(!track)return;
  const token=++videoLookupToken;
  if(force)delete track.video;
  renderVideoStatus('searching');
  try{
    const result=await discoverExistingMusicVideo(track);
    if(token!==videoLookupToken||currentTrack?.id!==track.id)return;
    if(result.status==='found')renderVideoStatus('found',result);
    else if(result.status==='generating')renderVideoStatus('generating',result);
    else queueAIVideo(track);
  }catch(error){
    console.error('Video discovery failed',error);
    if(token===videoLookupToken)renderVideoStatus('error',{message:error.message});
  }
}
function renderLyricsStage(track=currentTrack){
  const stage=$('#lyricsStage');if(!stage)return;activeLyricIndex=-1;
  if(!track){stage.innerHTML=`<div class="lyrics-empty">${icon('song')}<h2>Nothing playing</h2><p>Choose a song to see its lyrics here.</p></div>`;return}
  const lyrics=track.lyrics||{},synced=syncedLinesFor(track);
  if(lyrics.instrumental){stage.innerHTML=`<div class="lyrics-empty">${icon('song')}<h2>Instrumental</h2><p>${esc(track.title)} has no sung lyrics.</p></div>`;return}
  if(!synced.length&&!lyrics.plain){stage.innerHTML=`<div class="lyrics-empty">${icon('song')}<h2>${lyrics.notFound?'No lyrics found':'Lyrics are not downloaded yet'}</h2><p>Search LRCLIB for plain and time-synchronized lyrics for ${esc(track.title)}.</p><button class="primary" id="fetchTrackLyrics">${icon('spark')} Find lyrics</button></div>`;const button=$('#fetchTrackLyrics');button.onclick=async()=>{button.disabled=true;button.innerHTML='<span class="spinner"></span> Searching';try{const result=await lookupTrackLyrics(track,{force:true});saveLibrary();renderLyricsStage(track);toast(result.found?'Lyrics downloaded':'No lyrics found',result.synced?'Time-synchronized lyrics are ready.':result.found?'Plain lyrics are ready.':'Try pulling album information with a different title or artist.')}catch(error){button.disabled=false;button.innerHTML=`${icon('spark')} Try again`;toast('Could not fetch lyrics',error.message)}};return}
  const source=lyrics.source||'Saved lyrics';
  if(synced.length){stage.innerHTML=`<div class="lyrics-heading"><span>TIME-SYNCHRONIZED · ${esc(source)}</span><h2>${esc(track.title)}</h2></div><div class="lyrics-scroll synced">${synced.map((line,index)=>`<button data-lyric-index="${index}" data-lyric-time="${line.time}">${esc(line.text||'♪')}</button>`).join('')}</div>`;$$('[data-lyric-time]',stage).forEach(line=>line.onclick=()=>{if(currentTrack?.url&&audio.duration)audio.currentTime=Math.min(audio.duration,Number(line.dataset.lyricTime));updateLyricsPosition(Number(line.dataset.lyricTime))});updateLyricsPosition(currentTrack?.url?audio.currentTime:simProgress*durationSecondsFor(track)/100);return}
  const lines=String(lyrics.plain).split(/\r?\n/);stage.innerHTML=`<div class="lyrics-heading"><span>LYRICS · ${esc(source)}</span><h2>${esc(track.title)}</h2></div><div class="lyrics-scroll plain">${lines.map(line=>line.trim()?`<p>${esc(line)}</p>`:'<br>').join('')}</div>`;
}
function updateLyricsPosition(time){
  if(fullscreenMode!=='lyrics'||!currentTrack)return;const lines=syncedLinesFor(currentTrack);if(!lines.length)return;
  let index=-1;for(let i=0;i<lines.length;i++){if(lines[i].time<=time+.08)index=i;else break}if(index===activeLyricIndex)return;activeLyricIndex=index;
  const elements=$$('[data-lyric-index]',$('#lyricsStage'));elements.forEach((line,i)=>line.classList.toggle('active',i===index));const active=elements[index];if(active)active.scrollIntoView({block:'center',behavior:settings.reducedMotion?'auto':'smooth'});
}
function setFullscreenMode(mode){
  fullscreenMode=['visualizer','video','lyrics'].includes(mode)?mode:'visualizer';
  $$('.full-mode button').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));
  const player=$('#fullscreenPlayer');player.classList.toggle('video',fullscreenMode==='video');player.classList.toggle('lyrics',fullscreenMode==='lyrics');
  if(fullscreenMode==='visualizer'){$('#onlineVideoHost').innerHTML='';drawVisualizer();return}
  cancelAnimationFrame(visualFrame);
  if(fullscreenMode==='lyrics'){$('#onlineVideoHost').innerHTML='';videoLookupToken++;renderLyricsStage(currentTrack);return}
  if(currentTrack?.video?.status==='found')renderVideoStatus('found',currentTrack.video);
  else if(currentTrack?.video?.status==='generating')renderVideoStatus('generating',currentTrack.video);
  else if(currentTrack)prepareTrackVideo(currentTrack);
}
function updateVisualizerControls(){$$('[data-visualizer]').forEach(button=>button.classList.toggle('active',button.dataset.visualizer===visualizerStyle))}
function setVisualizerStyle(style){visualizerStyle=['waves','orbit','spectrum'].includes(style)?style:'waves';settings.visualizerStyle=visualizerStyle;updateVisualizerControls();saveLibrary();if(fullscreenMode==='visualizer')drawVisualizer()}
function updateFullscreenArtistBackdrop(track=currentTrack){const backdrop=$('#fullscreenArtistBackdrop'),image=track?artistProfile(track.artist).image:'';backdrop.style.backgroundImage=image?`url("${String(image).replace(/["\\]/g,'\\$&')}")`:'';backdrop.classList.toggle('has-image',Boolean(image))}
function openFullscreen(){const fp=$('#fullscreenPlayer');updateFullscreenArtistBackdrop();fp.classList.add('open');fp.setAttribute('aria-hidden','false');document.body.requestFullscreen?.().catch(()=>{});resizeCanvas();setFullscreenMode(fullscreenMode)}
function closeFullscreen(){const fp=$('#fullscreenPlayer');videoLookupToken++;$('#onlineVideoHost').innerHTML='';fp.classList.remove('open');fp.setAttribute('aria-hidden','true');if(document.fullscreenElement)document.exitFullscreen?.()}
let visualFrame=null;
function resizeCanvas(){const c=$('#visualizer');const dpr=Math.min(devicePixelRatio,2);c.width=innerWidth*dpr;c.height=innerHeight*dpr;c.getContext('2d').setTransform(dpr,0,0,dpr,0,0)}
function drawVisualizer(){
  cancelAnimationFrame(visualFrame);const canvas=$('#visualizer'),ctx=canvas.getContext('2d');let phase=0;
  const loop=()=>{if(!$('#fullscreenPlayer').classList.contains('open')||fullscreenMode!=='visualizer')return;phase+=isPlaying?.018:.006;const w=innerWidth,h=innerHeight,energy=isPlaying?1:.34,accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();ctx.globalCompositeOperation='destination-out';ctx.fillStyle=visualizerStyle==='spectrum'?'rgba(0,0,0,.3)':'rgba(0,0,0,.18)';ctx.fillRect(0,0,w,h);ctx.globalCompositeOperation='source-over';
    if(visualizerStyle==='waves'){
      for(let band=0;band<4;band++){ctx.beginPath();for(let x=0;x<=w;x+=8){const amp=(35+band*17)*energy,y=h*.47+Math.sin(x*.008+phase*(2+band*.25)+band)*amp+Math.sin(x*.019-phase)*20;if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.strokeStyle=band===0?accent:`rgba(210,130,100,${.36-band*.07})`;ctx.lineWidth=2-band*.25;ctx.shadowColor=accent;ctx.shadowBlur=band===0?20:6;ctx.stroke()}
    }else if(visualizerStyle==='orbit'){
      const centerX=w*.5,centerY=h*.43,base=Math.min(w,h)*.16;ctx.save();ctx.translate(centerX,centerY);for(let ring=0;ring<5;ring++){const radius=base+ring*32;ctx.beginPath();for(let step=0;step<=180;step++){const angle=step/180*Math.PI*2,wobble=(10+ring*2)*energy*Math.sin(angle*(3+ring)+phase*(4-ring*.35)),r=radius+wobble,x=Math.cos(angle)*r,y=Math.sin(angle)*r;if(step===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.strokeStyle=ring===0?accent:`rgba(${170+ring*13},${95+ring*18},${205-ring*8},${.58-ring*.075})`;ctx.lineWidth=Math.max(1,3-ring*.35);ctx.shadowColor=accent;ctx.shadowBlur=ring===0?25:9;ctx.stroke();const orbitAngle=phase*(2.4-ring*.22)+ring*1.25,orbRadius=radius+Math.sin(phase*2+ring)*12;ctx.beginPath();ctx.arc(Math.cos(orbitAngle)*orbRadius,Math.sin(orbitAngle)*orbRadius,Math.max(2,7-ring),0,Math.PI*2);ctx.fillStyle=ring%2?accent:'#f8d69a';ctx.fill()}ctx.restore();
    }else{
      const bars=Math.max(48,Math.floor(w/20)),gap=4,barWidth=Math.max(4,(w*.84-(bars-1)*gap)/bars),start=w*.08,baseline=h*.66,gradient=ctx.createLinearGradient(0,baseline,0,h*.22);gradient.addColorStop(0,accent);gradient.addColorStop(.55,'#b45bdb');gradient.addColorStop(1,'#78e8dc');ctx.fillStyle=gradient;ctx.shadowColor=accent;ctx.shadowBlur=14;for(let bar=0;bar<bars;bar++){const normalized=bar/(bars-1),envelope=.32+.68*Math.sin(Math.PI*normalized),motion=(Math.sin(bar*.55+phase*5)+Math.sin(bar*.19-phase*3)+2)/4,height=(18+motion*h*.29*envelope)*energy;ctx.globalAlpha=.48+motion*.52;ctx.fillRect(start+bar*(barWidth+gap),baseline-height,barWidth,height);ctx.fillRect(start+bar*(barWidth+gap),baseline+5,barWidth,height*.16)}ctx.globalAlpha=1;
    }
    ctx.shadowBlur=0;visualFrame=requestAnimationFrame(loop)
  };loop();
}

// Global interactions
$('#primaryNav').addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)navigate(btn.dataset.view)});
$('#brandHome').onclick=()=>navigate('home');
$('.sidebar-bottom').addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)navigate(btn.dataset.view)});
$('#updateWidget').onclick=openUpdateModal;
$('#whatsNewWidget').onclick=openWhatsNew;
$('#miniPlaylists').addEventListener('click',e=>{const btn=e.target.closest('[data-sidebar-playlist]');if(btn)openPlaylist(btn.dataset.sidebarPlaylist)});
document.addEventListener('click',e=>{
  if(!e.target.closest('#contextMenu')&&!e.target.closest('#importTrigger'))hideContextMenu();
  const selectableAlbum=e.target.closest('.album-card[data-album],.album-list-row[data-album]'),selectableTrack=e.target.closest('tr[data-track]'),modifier=e.ctrlKey||e.metaKey||e.shiftKey;
  if(modifier&&!e.target.closest('button')&&(selectableAlbum||selectableTrack)){e.preventDefault();handleBulkSelection(selectableAlbum?'album':'track',selectableAlbum?.dataset.album||selectableTrack.dataset.track,e);return}
  if(!modifier&&!e.target.closest('button')&&(selectableAlbum||selectableTrack)&&(selectedTrackIds.size||selectedAlbumIds.size))clearBulkSelection();
  const videoAction=e.target.closest('[data-video-action]');
  if(videoAction?.dataset.videoAction==='search-again'&&currentTrack)prepareTrackVideo(currentTrack,true);
  if(videoAction?.dataset.videoAction==='next-result'&&currentTrack)useNextVideoResult(currentTrack);
  if(videoAction?.dataset.videoAction==='open-settings'){closeFullscreen();navigate('settings')}
  const newBtn=e.target.closest('[data-action="new-playlist"]');if(newBtn)newPlaylistModal();
  const importBtn=e.target.closest('[data-import]');if(importBtn){importBtn.dataset.import==='folder'?chooseFolder():chooseFiles()}
  const edit=e.target.closest('[data-edit-album]');if(edit){e.stopPropagation();editAlbum(edit.dataset.editAlbum)}
  const play=e.target.closest('[data-play-album]');if(play){e.stopPropagation();playTrackQueue(albumById(play.dataset.playAlbum)?.tracks||[])}
  const album=e.target.closest('.album-card,.album-list-row');if(album&&!e.target.closest('button'))openAlbumDetail(album.dataset.album);
  const row=e.target.closest('[data-track]');if(row&&!e.target.closest('button')){const t=allTracks().find(x=>x.id===row.dataset.track);if(t){const playlist=currentView.startsWith('playlist:')?findPlaylistById(currentView.slice(9)):null;if(playlist&&view.contains(row))playTrackQueue(sortedPlaylistTracks(playlist),false,playlistPlaybackContext(playlist),t.id);else playTrack(t)}}
  const rowAction=e.target.closest('[data-row-action]');if(rowAction){const t=allTracks().find(x=>x.id===rowAction.dataset.rowAction),rect=rowAction.getBoundingClientRect();if(t)trackContext(t,rect.right-205,rect.bottom+4)}
});
document.addEventListener('contextmenu',e=>{
  const nowPlaying=e.target.closest('.now-playing');if(nowPlaying){e.preventDefault();nowPlayingContext(e.clientX,e.clientY);return}
  const playlist=e.target.closest('[data-playlist-card],[data-sidebar-playlist]');if(playlist){e.preventDefault();playlistContext(playlist.dataset.playlistCard||playlist.dataset.sidebarPlaylist,e.clientX,e.clientY);return}
  const row=e.target.closest('[data-track]');if(row){e.preventDefault();const t=allTracks().find(x=>x.id===row.dataset.track);if(t)trackContext(t,e.clientX,e.clientY);return}
  const artist=e.target.closest('[data-artist]');if(artist){e.preventDefault();artistContext(artist.dataset.artist,e.clientX,e.clientY);return}
  const album=e.target.closest('[data-album]');if(album){e.preventDefault();albumContext(album.dataset.album,e.clientX,e.clientY)}
});
$('#shelfToggle').onclick=()=>currentView==='shelf'?navigate('albums'):navigate('shelf');
const historyButtons=$$('.history button');if(historyButtons.length>=2){historyButtons[0].onclick=historyBack;historyButtons[1].onclick=historyForward;updateHistoryControls()}
$('#bulkSelectionBar').addEventListener('click',event=>{const action=event.target.closest('[data-bulk-action]');if(action)runBulkAction(action.dataset.bulkAction)});
$('#importTrigger').onclick=showImportMenu;
$('#accountControl').onclick=()=>{settingsTab='account';navigate('settings')};
$('#audioInput').onchange=e=>{const target=e.target.dataset.targetTrack?allTracks().find(t=>t.id===e.target.dataset.targetTrack):null;if(e.target.files.length)importAudioEntries(normalizeBrowserFiles(e.target.files),target);e.target.value='';e.target.dataset.targetTrack=''};
$('#folderInput').onchange=e=>{if(e.target.files.length){const entries=normalizeBrowserFiles(e.target.files),first=(entries[0].relativePath||'Imported folder').split('/')[0];importFolderEntries({name:first,entries})}e.target.value=''};
$('#screenshotInput').onchange=e=>{if(e.target.files[0])screenshotWorkflow(e.target.files[0]);e.target.value=''};
$('#playBtn').onclick=togglePlay;$('#fullPlay').onclick=togglePlay;$('#prevBtn').onclick=()=>nextTrack(-1);$('#nextBtn').onclick=()=>nextTrack(1);$('#fullPrev').onclick=()=>nextTrack(-1);$('#fullNext').onclick=()=>nextTrack(1);$('#fullscreenBtn').onclick=openFullscreen;$('#closeFull').onclick=closeFullscreen;
$('#queueButton').onclick=()=>$('#queuePanel').classList.contains('open')?closeQueue():openQueue();$('#closeQueue').onclick=closeQueue;$('#queueBackdrop').onclick=closeQueue;$('#clearQueue').onclick=clearPlaybackQueue;
audio.onplay=()=>{audio.volume=settings.muted?0:settings.volume/100;setPlaying(true);commitPlayCount(currentTrack)};audio.onpause=()=>setPlaying(false);audio.onended=()=>nextTrack(1,{ended:true});audio.ontimeupdate=()=>{if(!audio.duration)return;const p=audio.currentTime/audio.duration*100;setRange($('#progress'),p);$('#elapsed').textContent=formatTime(audio.currentTime);$('#duration').textContent=formatTime(audio.duration);updatePlaybackEnvelope();updateLyricsPosition(audio.currentTime);if(Date.now()-lastDiscordProgressSync>15000){lastDiscordProgressSync=Date.now();syncNativePlaybackState()}};
$('#progress').oninput=e=>{setRange(e.target,e.target.value);if(currentTrack?.url&&audio.duration)audio.currentTime=audio.duration*e.target.value/100;else simProgress=Number(e.target.value);syncNativePlaybackState()};
$('#volume').oninput=e=>setVolume(e.target.value);$('#volume').onchange=()=>{clearTimeout(volumePersistenceTimer);saveLibrary()};$('#volumeMute').onclick=toggleMute;
$('#favoriteTrack').onclick=()=>currentTrack?setTrackFavorite(currentTrack):toast('Nothing is playing');
$('#nowPlaylistLink').onclick=event=>{event.stopPropagation();const id=event.currentTarget.dataset.playlistId;if(id)openPlaylist(id)};
$('#shuffleBtn').onclick=()=>{setShuffleEnabled(!shuffleEnabled);toast(shuffleEnabled?'Shuffle on':'Shuffle off',shuffleEnabled?(playbackQueueExplicit?'The active queue was reshuffled.':'New collections will play in random order.'):'Collections will play in their listed order.')};$('#repeatBtn').onclick=cycleRepeatMode;
$('#searchInput').oninput=e=>{if(currentView==='home'&&e.target.value.trim()){navigate('songs');renderSongs(e.target.value)}else if(currentView==='albums')renderAlbums(e.target.value);else if(currentView==='artists')renderArtists(e.target.value);else if(currentView==='songs')renderSongs(e.target.value)};
$('#searchInput').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';render()}});
$$('.full-mode button').forEach(btn=>btn.onclick=()=>setFullscreenMode(btn.dataset.mode));
$$('[data-visualizer]').forEach(btn=>btn.onclick=()=>setVisualizerStyle(btn.dataset.visualizer));
window.addEventListener('resize',()=>{hideContextMenu();if($('#fullscreenPlayer').classList.contains('open'))resizeCanvas()});
$('.content').addEventListener('scroll',hideContextMenu,{passive:true});
window.firefly?.onMediaCommand?.(handleNativeMediaCommand);
window.firefly?.onDiscordStatus?.(status=>{discordPresenceState=status||discordPresenceState;updateDiscordStatusView()});
window.firefly?.onAccountSyncStatus?.(status=>{accountSyncState=status||accountSyncState;if(status?.trackFiles?.length||status?.removedLocalTrackIds?.length)applyCloudSyncResult(status,{persist:status.status==='synced'});if(status?.storageUsed!=null)accountState.storageUsed=Number(status.storageUsed)||0;if(status?.storageLimit!=null)accountState.storageLimit=Number(status.storageLimit)||accountState.storageLimit;if(status?.code==='STORAGE_QUOTA'&&!cloudQuotaAlertShown){cloudQuotaAlertShown=true;openModal(`<div class="modal-head"><h2>Cloud storage is full</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">Ignifire paused new uploads. Your existing cloud library is still available to stream and download.</p></div><div class="modal-actions"><button class="primary close-modal">Got it</button></div>`)}if(currentView==='settings'&&settingsTab==='account')renderSettings()});
installMediaSessionHandlers();
syncNativePlaybackState();
document.addEventListener('keydown',e=>{
  const editing=['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#searchInput').focus()}
  if(e.code==='Space'&&!editing){e.preventDefault();togglePlay()}
  if((e.key==='Delete'||e.key==='Backspace')&&!editing&&(selectedTrackIds.size||selectedAlbumIds.size)){e.preventDefault();deleteBulkSelection();return}
  if(e.key==='Escape'){hideContextMenu();if(modalLayer.classList.contains('open'))closeModal();else if($('#fullscreenPlayer').classList.contains('open'))closeFullscreen();else if($('#queuePanel').classList.contains('open'))closeQueue();else if(selectedTrackIds.size||selectedAlbumIds.size)clearBulkSelection()}
});

initializePersistence();
