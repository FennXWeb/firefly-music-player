const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

let albums = [];
let customPlaylists = [];
let shelves = [];
let artistProfiles = {};
let sunoConnected = false;
const defaultSettings = {
  accent: '#f55f45', accentRgb: '245,95,69', ambient: true,
  reducedMotion: false, gapless: true, crossfade: 40, volume: 72,
  sunoEndpoint: 'https://api.suno.ai', updateChannel: 'stable'
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

let currentView = 'albums';
let viewBackStack = [];
let viewForwardStack = [];
const openedAlbumCases = new Set();
let currentTrack = null;
let playbackQueue = [];
let isPlaying = false;
let simProgress = 38;
let simTimer = null;
let draggedPlaylist = null;
let draggedAlbum = null;
const selectedTrackIds = new Set();
const selectedAlbumIds = new Set();
let trackSelectionAnchor = null;
let albumSelectionAnchor = null;
let screenshotData = null;
let playlistImportTarget = null;
let videoLookupToken = 0;
let updateState = { status:'idle', channel:'stable', available:false, progress:null };
let updateCheckTimer = null;
const VIDEO_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;

const view = $('#view');
const audio = $('#audio');
const modalLayer = $('#modalLayer');

function allTracks() { return albums.flatMap(a => a.tracks); }
function albumById(id) { return albums.find(a => a.id === id); }
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
  if (playlist.children) return [...new Map(playlist.children.flatMap(child => playlistTracks(child)).map(track=>[track.id,track])).values()];
  const ids = playlist.trackIds || [];
  return ids.map(id => allTracks().find(t => t.id === id)).filter(Boolean);
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
  $$('.album-card[data-album]',view).forEach(card=>card.classList.toggle('bulk-selected',selectedAlbumIds.has(card.dataset.album)));
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
  const detail=albumCount?`${albumCount} album${albumCount===1?'':'s'} and ${tracks.length} track${tracks.length===1?'':'s'} will be removed from Firefly.`:`${tracks.length} selected track${tracks.length===1?'':'s'} will be removed from Firefly.`;
  confirmRemove('Delete selected items?',`${detail} Source files stay untouched.`,()=>{if(albumCount)albums=albums.filter(album=>!selectedAlbumIds.has(album.id));else albums.forEach(album=>album.tracks=album.tracks.filter(track=>!trackIds.has(track.id)));customPlaylists.forEach(playlist=>removePlaylistTrackReferences(playlist,trackIds));clearBulkSelection(false);saveLibrary();render();renderBulkSelectionBar();toast('Selection removed')});
}
function runBulkAction(action){
  if(action==='clear'){clearBulkSelection();return}
  if(action==='play'){playTrackQueue(selectedBulkTracks());return}
  if(action==='playlist'){addBulkSelectionToPlaylist();return}
  if(action==='delete')deleteBulkSelection();
}
function saveLibrary() {
  pruneEmptyAlbums();
  syncShelves();
  const state = { albums, playlists:customPlaylists, shelves, artistProfiles, sunoConnected, settings };
  try { localStorage.setItem('firefly-library-v1', JSON.stringify(state)); }
  catch { toast('Library is too large to cache','Your current session is safe, but large uploaded artwork may not persist.'); }
  if (persistenceReady && window.firefly?.saveState) {
    clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => window.firefly.saveState(state).catch(() => toast('Could not save library','Firefly will retry after the next change.')), 120);
  }
  renderSidebarPlaylists();
}
function saveCredentials() {
  if (persistenceReady && window.firefly?.saveCredentials) window.firefly.saveCredentials(credentials).catch(() => toast('Could not save connection credentials'));
}
function applySavedState(saved = {}) {
  if (Array.isArray(saved.albums)) albums = saved.albums;
  if (Array.isArray(saved.playlists)) customPlaylists = saved.playlists;
  if (Array.isArray(saved.shelves)) shelves = saved.shelves;
  if (saved.artistProfiles && typeof saved.artistProfiles === 'object' && !Array.isArray(saved.artistProfiles)) artistProfiles = saved.artistProfiles;
  sunoConnected = Boolean(saved.sunoConnected);
  settings = { ...defaultSettings, ...(saved.settings || {}) };
}
function applySettings() {
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--accent-rgb', settings.accentRgb);
  $('.ambient').style.display = settings.ambient ? '' : 'none';
  document.documentElement.style.scrollBehavior = settings.reducedMotion ? 'auto' : '';
  audio.volume = settings.volume / 100;
}
async function initializePersistence() {
  let durableState = null;
  if (window.firefly?.loadState) {
    try {
      const loaded = await window.firefly.loadState();
      durableState = loaded?.state;
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
  applySettings();
  setRange($('#progress'), 0);
  setRange($('#volume'), settings.volume);
  render();
  if (!durableState || migrateLegacy || removedEmptyAlbums) saveLibrary();
  initializeUpdater();
}
function toast(title, detail = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3400);
}
function updateChannelLabel(channel=settings.updateChannel){return channel==='beta'?'Test · beta':'Stable · main'}
function renderUpdateWidget(){
  const widget=$('#updateWidget');if(!widget)return;
  const labels={idle:'Updates',checking:'Checking for updates',current:'Firefly is up to date',available:`Version ${updateState.version} available`,downloading:updateState.progress==null?'Downloading update':`Downloading · ${updateState.progress}%`,ready:'Update ready to launch',error:'Update check unavailable'};
  widget.className=`update-widget ${updateState.status}`;widget.innerHTML=`${icon(updateState.status==='available'||updateState.status==='ready'?'spark':'upload')}<span><b>${labels[updateState.status]||labels.idle}</b><small>${updateChannelLabel(updateState.channel)}</small></span><i></i>`;
  widget.setAttribute('aria-label',`${labels[updateState.status]||labels.idle}. ${updateChannelLabel(updateState.channel)}`);
}
async function checkForUpdates(manual=false){
  if(!window.firefly?.checkForUpdates){updateState={status:'error',channel:settings.updateChannel,error:'Updates are available in the Windows app.'};renderUpdateWidget();return}
  updateState={...updateState,status:'checking',channel:settings.updateChannel,progress:null};renderUpdateWidget();
  try{const result=await window.firefly.checkForUpdates(settings.updateChannel);updateState={...result,status:result.available?'available':'current',progress:null};renderUpdateWidget();if(currentView==='settings')renderSettings();if(manual)toast(result.available?`Firefly ${result.version} is available`:'Firefly is up to date',updateChannelLabel(result.channel))}
  catch(error){updateState={status:'error',channel:settings.updateChannel,available:false,error:error?.message||'Update check failed.'};renderUpdateWidget();if(currentView==='settings')renderSettings();if(manual)toast('Could not check for updates',updateState.error)}
}
function updateModalMarkup(){
  const status=updateState.status,available=status==='available',downloading=status==='downloading',ready=status==='ready';
  const title=available?`Firefly ${esc(updateState.version)} is available`:ready?'Update ready':downloading?'Downloading update':status==='current'?'You’re up to date':'Firefly updates';
  const detail=available?(updateState.notes||`A new ${updateChannelLabel(updateState.channel).toLowerCase()} build is ready.`):ready?`${updateState.fileName} passed its integrity check and is ready to launch.`:downloading?'Keep Firefly open while the Windows build downloads.':status==='error'?updateState.error:`Firefly checks the ${updateChannelLabel(updateState.channel)} channel automatically.`;
  return `<div class="modal-head"><h2>${title}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="update-modal-hero ${status}">${icon(available||ready?'spark':'upload')}<div><span>${updateChannelLabel(updateState.channel)}</span><p>${esc(detail)}</p></div></div>${downloading?`<div class="update-progress"><span><i style="width:${updateState.progress||0}%"></i></span><small>${updateState.progress==null?'Preparing download…':`${updateState.progress}% downloaded`}</small></div>`:''}</div><div class="modal-actions"><button class="ghost close-modal">Close</button>${available?`<button class="primary" id="downloadUpdate">${icon('upload')} Download update</button>`:''}${ready?`<button class="primary" id="launchUpdate">Launch and restart</button>`:''}${['current','error','idle'].includes(status)?`<button class="primary" id="modalCheckUpdate">Check now</button>`:''}</div>`;
}
function openUpdateModal(){openModal(updateModalMarkup(),true);if($('#downloadUpdate'))$('#downloadUpdate').onclick=downloadAvailableUpdate;if($('#launchUpdate'))$('#launchUpdate').onclick=launchDownloadedUpdate;if($('#modalCheckUpdate'))$('#modalCheckUpdate').onclick=()=>{closeModal();checkForUpdates(true)}}
async function downloadAvailableUpdate(){
  updateState={...updateState,status:'downloading',progress:null};renderUpdateWidget();openUpdateModal();
  try{const result=await window.firefly.downloadUpdate(updateState.channel);updateState={...updateState,...result,status:'ready',progress:100};renderUpdateWidget();openUpdateModal()}
  catch(error){updateState={...updateState,status:'error',error:error?.message||'The update could not be downloaded.'};renderUpdateWidget();openUpdateModal()}
}
async function launchDownloadedUpdate(){try{await window.firefly.launchUpdate()}catch(error){toast('Could not launch update',error?.message||'Try downloading it again.')}}
function initializeUpdater(){
  updateState.channel=settings.updateChannel==='beta'?'beta':'stable';renderUpdateWidget();
  if(window.firefly?.onUpdateProgress)window.firefly.onUpdateProgress(progress=>{updateState={...updateState,status:'downloading',progress:progress.percent};renderUpdateWidget();if($('#modalLayer').classList.contains('open')&&$('.update-progress')){const fill=$('.update-progress i'),label=$('.update-progress small');if(fill&&progress.percent!=null)fill.style.width=`${progress.percent}%`;if(label)label.textContent=progress.percent==null?'Downloading update…':`${progress.percent}% downloaded`}});
  checkForUpdates(false);clearInterval(updateCheckTimer);updateCheckTimer=setInterval(()=>checkForUpdates(false),30*60*1000);
}
function setRange(el, value) { el.value = value; el.style.setProperty('--range', `${value}%`); }

function renderSidebarPlaylists() {
  const host = $('#miniPlaylists');
  if (!host) return;
  host.innerHTML = customPlaylists.length ? customPlaylists.slice(0,6).map((p,i) => `<button data-sidebar-playlist="${p.id}"><span class="mini-cover ${['sunset','violet','cyan'][i%3]}"></span><span><b>${esc(p.title)}</b><small>${playlistTracks(p).length} songs</small></span></button>`).join('') : `<div class="sidebar-empty">No playlists yet.<br>Use + to create one.</div>`;
}

function pageHead(eyebrow, title, description, tools = '') {
  return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${tools ? `<div class="head-tools">${tools}</div>`:''}</div>`;
}

function render() {
  renderSidebarPlaylists();
  view.style.animation = 'none';
  requestAnimationFrame(() => { view.style.animation = ''; });
  if (currentView === 'albums') renderAlbums();
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
  applySelectionClasses();renderBulkSelectionBar();
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
  return `<div class="artist-portrait ${profile.image?'has-artist-image':artistPortraitClass(name)} ${extra}" ${style}></div>`;
}

function dynamicCaseReady(album) {
  return Boolean(album?.dynamicCaseArt?.enabled && album.dynamicCaseArt?.backgroundUrl && album.dynamicCaseArt?.font?.fileUrl);
}
function dynamicFontName(font) { return font?.id ? `Firefly Dynamic ${font.id}` : 'Inter'; }
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
async function generateDynamicCaseFor(album) {
  if(!album.customCover){toast('Add front cover art first','Dynamic Case Art needs an existing cover to extend.');return}
  if(!credentials.openaiKey){toast('Connect OpenAI first','Save an API key in Settings, then try again.');return}
  if(!window.firefly?.ensureDynamicFonts||!window.firefly?.generateDynamicCaseArt){toast('Dynamic Case Art requires the Windows app');return}
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
    toast('Dynamic Case Art ready',`${font.family} was selected from ${library.fonts.length} downloaded typefaces.`);
  }catch(error){album.dynamicCaseArt={...album.dynamicCaseArt,enabled:true,status:'error',error:error?.message||'Generation failed.'};saveLibrary();refreshDynamicCaseSection(album);toast('Dynamic Case Art could not be created',album.dynamicCaseArt.error)}
}
function bindDynamicCaseControls(album){
  const toggle=$('#dynamicCaseToggle');if(!toggle)return;
  toggle.onclick=()=>{if(album.dynamicCaseArt?.enabled){album.dynamicCaseArt.enabled=false;saveLibrary();refreshDynamicCaseSection(album);toast('Dynamic Case Art disabled','Generated files remain cached for later.')}else if(album.dynamicCaseArt?.backgroundUrl&&album.dynamicCaseArt?.font){album.dynamicCaseArt.enabled=true;album.dynamicCaseArt.status=album.dynamicCaseArt.status==='stale'?'stale':'ready';activateDynamicFont(album);saveLibrary();refreshDynamicCaseSection(album)}else generateDynamicCaseFor(album)};
  const regenerate=$('#regenerateDynamicCase');if(regenerate)regenerate.onclick=()=>generateDynamicCaseFor(album);
}

function renderAlbums(filter = '') {
  currentView = 'albums';
  const q = filter.trim().toLowerCase();
  const shown = albums.filter(a => `${a.title} ${a.artist} ${a.genre}`.toLowerCase().includes(q));
  view.innerHTML = pageHead('YOUR LIBRARY','Albums',`${albums.length} albums · ${allTracks().length} songs`,
    `<button class="icon-button active" title="Grid view">${icon('grid')}</button><button class="icon-button" id="listView" title="Song list">${icon('list')}</button>`) +
    `<div class="filter-row"><button class="chip active">All albums</button><button class="chip">Recently added</button><button class="chip">Downloaded</button><button class="chip">Favorites</button></div>` +
    (shown.length ? `<div class="album-grid">${shown.map((a,i)=>`<article class="album-card" data-album="${a.id}" style="animation-delay:${i*35}ms"><div class="album-art-wrap">${albumCover(a)}${dynamicCaseReady(a)?'<span class="dynamic-album-badge">DYNAMIC CASE</span>':''}<button class="quick-play" data-play-album="${a.id}" aria-label="Play ${esc(a.title)}">${icon('play')}</button></div><h3>${esc(a.title)}</h3><p>${esc(a.artist)} · ${a.year}</p><button class="more" data-edit-album="${a.id}" aria-label="Edit album">${icon('more')}</button></article>`).join('')}</div>` : `<div class="empty-state">${icon('albums')}<h2>${q?'No albums found':'Your library is ready'}</h2><p>${q?'Try another title, artist, or genre.':'Import music files or a folder to begin building your collection.'}</p>${q?'':`<div class="empty-actions"><button class="primary" data-import="files">${icon('upload')} Import files</button><button class="ghost" data-import="folder">${icon('albums')} Import folder</button></div>`}</div>`);
  $('#listView')?.addEventListener('click', () => navigate('songs'));
  $$('.chip', view).forEach(c => c.onclick = () => { $$('.chip',view).forEach(x=>x.classList.remove('active')); c.classList.add('active'); toast(`${c.textContent} filter applied`); });
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
function renderAlbumDetail(id){
  const album=albumById(id);if(!album){navigate('albums',{record:false});return}
  const isOpen=openedAlbumCases.has(id),dynamic=dynamicCaseReady(album)?album.dynamicCaseArt:null;
  const backArt=dynamic?.backgroundUrl||album.fullArtParts?.back||album.customFullArt||album.customCover||'';
  const discArt=album.customCover||'';
  view.innerHTML=`<section class="entity-detail album-detail" data-album="${album.id}"><button class="detail-back" data-detail-back>${icon('prev')} All albums</button><div class="album-detail-hero"><div class="detail-case-stage"><button class="album-detail-case ${isOpen?'open':''}" data-detail-case aria-expanded="${isOpen}" aria-label="${isOpen?'Close':'Open'} ${esc(album.title)} jewel case"><span class="album-detail-case-back" ${backArt?`style="background-image:linear-gradient(#08080830,#08080830),url(&quot;${esc(backArt)}&quot;)"`:''}>${dynamic?`<span class="detail-back-copy" style="font-family:'${dynamicFontName(dynamic.font)}'">${dynamicTrackList(album)}</span>`:''}<i class="detail-disc" ${discArt?`style="--detail-disc:url(&quot;${esc(discArt)}&quot;)"`:''}></i></span><span class="album-detail-lid"><span class="detail-lid-front">${albumCover(album,'detail-cover')}</span><span class="detail-lid-inside"><b>${esc(album.title)}</b><small>${esc(album.artist)} · ${album.year}</small><ol>${album.tracks.slice(0,18).map(t=>`<li>${esc(t.title)}</li>`).join('')}</ol></span></span></button><p class="case-toggle-hint">Click the jewel case to ${isOpen?'close':'open'} it</p></div><div class="album-detail-copy"><div class="eyebrow">ALBUM · ${esc(album.genre||'UNCATEGORIZED')}</div><h1>${esc(album.title)}</h1><button class="artist-byline" data-open-artist="${esc(album.artist)}">${esc(album.artist)}</button><p>${album.year} · ${album.tracks.length} track${album.tracks.length===1?'':'s'} · ${album.tracks.reduce((sum,t)=>sum+(parseInt(t.duration)||0),0)}+ minutes</p><div class="detail-actions"><button class="primary" data-detail-play>${icon('play')} Play album</button><button class="ghost" data-detail-shuffle>${icon('shuffle')} Shuffle</button><button class="ghost" data-detail-add-playlist>${icon('playlist')} Add to playlist</button><button class="icon-button" data-detail-edit title="Edit album">${icon('settings')}</button></div></div></div><div class="detail-track-section"><div><div class="eyebrow">TRACK LIST</div><h2>On this album</h2></div>${songTable(album.tracks)}</div></section>`;
  $('[data-detail-back]').onclick=()=>navigate('albums');
  $('[data-open-artist]').onclick=()=>openArtistDetail(album.artist);
  $('[data-detail-case]').onclick=()=>{openedAlbumCases.has(id)?openedAlbumCases.delete(id):openedAlbumCases.add(id);const caseElement=$('[data-detail-case]'),opened=openedAlbumCases.has(id);caseElement.classList.toggle('open',opened);caseElement.setAttribute('aria-expanded',String(opened));caseElement.setAttribute('aria-label',`${opened?'Close':'Open'} ${album.title} jewel case`);$('.case-toggle-hint').textContent=`Click the jewel case to ${opened?'close':'open'} it`};
  $('[data-detail-play]').onclick=()=>playTrack(album.tracks.find(t=>!t.pending));
  $('[data-detail-shuffle]').onclick=()=>{const playable=album.tracks.filter(t=>!t.pending);if(playable.length)playTrack(playable[Math.floor(Math.random()*playable.length)])};
  $('[data-detail-add-playlist]').onclick=()=>addAlbumToPlaylist(album);
  $('[data-detail-edit]').onclick=()=>editAlbum(id);
}
function renderArtistDetail(name){
  const artistAlbums=albums.filter(album=>album.artist===name);if(!artistAlbums.length){navigate('artists',{record:false});return}
  const tracks=artistAlbums.flatMap(album=>album.tracks),profile=artistProfile(name);
  view.innerHTML=`<section class="entity-detail artist-detail"><button class="detail-back" data-detail-back>${icon('prev')} All artists</button><div class="artist-detail-hero" data-artist="${esc(name)}" ${profile.image?`style="--artist-hero:url(&quot;${esc(profile.image)}&quot;)"`:''}><div class="artist-hero-glow"></div>${artistPortraitMarkup(name,'artist-portrait-large')}<div class="artist-detail-copy"><div class="eyebrow">ARTIST</div><h1>${esc(name)}</h1><p>${artistAlbums.length} album${artistAlbums.length===1?'':'s'} · ${tracks.length} song${tracks.length===1?'':'s'}${profile.sourceUrl?` · <a href="${esc(profile.sourceUrl)}" target="_blank" rel="noreferrer">Image source</a>`:''}</p><div class="detail-actions"><button class="primary" data-artist-play>${icon('play')} Play</button><button class="ghost" data-artist-shuffle>${icon('shuffle')} Shuffle</button><button class="ghost" data-artist-image>${icon('image')} ${profile.image?'Change image':'Add image'}</button></div></div></div><section class="artist-albums"><div class="section-heading"><div><div class="eyebrow">DISCOGRAPHY</div><h2>Albums</h2></div></div><div class="album-grid">${artistAlbums.map((album,index)=>`<article class="album-card" data-album="${album.id}" style="animation-delay:${index*35}ms"><div class="album-art-wrap">${albumCover(album)}${dynamicCaseReady(album)?'<span class="dynamic-album-badge">DYNAMIC CASE</span>':''}<button class="quick-play" data-play-album="${album.id}" aria-label="Play ${esc(album.title)}">${icon('play')}</button></div><h3>${esc(album.title)}</h3><p>${album.year} · ${album.tracks.length} tracks</p><button class="more" data-edit-album="${album.id}" aria-label="Edit album">${icon('more')}</button></article>`).join('')}</div></section><section class="detail-track-section"><div><div class="eyebrow">ALL SONGS</div><h2>Popular tracks</h2></div>${songTable([...tracks].sort((a,b)=>(b.plays||0)-(a.plays||0)))}</section></section>`;
  $('[data-detail-back]').onclick=()=>navigate('artists');
  $('[data-artist-play]').onclick=()=>playTrack(tracks.find(t=>!t.pending));
  $('[data-artist-shuffle]').onclick=()=>{const playable=tracks.filter(t=>!t.pending);if(playable.length)playTrack(playable[Math.floor(Math.random()*playable.length)])};
  $('[data-artist-image]').onclick=()=>editArtistImage(name);
}

function renderSongs(filter = '') {
  const tracks = allTracks().filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(filter.toLowerCase()));
  view.innerHTML = pageHead('YOUR LIBRARY','Songs',`${tracks.length} tracks · ${Math.round(tracks.length*3.8/60)} hr ${Math.round(tracks.length*3.8%60)} min`) + (tracks.length ? songTable(tracks) : `<div class="empty-state">${icon('song')}<h2>No songs yet</h2><p>Import files or a music folder to add your first tracks.</p><div class="empty-actions"><button class="primary" data-import="files">${icon('upload')} Import files</button><button class="ghost" data-import="folder">${icon('albums')} Import folder</button></div></div>`);
  applySelectionClasses();renderBulkSelectionBar();
}
function songTable(tracks) {
  return `<table class="song-table"><thead><tr><th>#</th><th>TITLE</th><th>ALBUM</th><th>PLAYS</th><th>TIME</th><th></th></tr></thead><tbody>${tracks.map((t,i)=>{
    const a=albumById(t.albumId)||{cover:'cover-8'};
    return `<tr class="${t.pending?'pending-row':''}" data-track="${t.id}"><td>${t.pending?'—':i+1}</td><td><div class="song-title"><div class="thumb ${a.cover}" ${a.customCover?`style="background-image:url('${a.customCover}');background-size:cover"`:''}></div><span><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span>${t.pending?'<i class="pending-badge">PENDING</i>':''}</div></td><td>${esc(t.album)}</td><td>${t.pending?'—':t.plays}</td><td>${t.pending?'—':t.duration}</td><td><button class="row-action" data-row-action="${t.id}">${icon('more')}</button></td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderPlaylists() {
  view.innerHTML = pageHead('LISTEN YOUR WAY','Playlists','Drag one playlist onto another to create a master playlist.',`<button class="ghost" data-action="new-playlist">${icon('plus')} New playlist</button>`) +
  `<div class="playlist-layout"><div>${customPlaylists.length?`<div class="playlist-grid">${customPlaylists.map((p,i)=>`<button class="playlist-card" draggable="true" data-playlist-card="${p.id}" style="--card-color:${p.color}"><div class="orb"></div><small>${p.children?'MASTER PLAYLIST':'PLAYLIST'}</small><span class="stack">${p.children?'◫':'♫'}</span><h3>${esc(p.title)}</h3><p>${p.children?`${p.children.length} sub-playlists · `:''}${playlistTracks(p).length} songs</p></button>`).join('')}</div>`:`<div class="empty-state">${icon('playlist')}<h2>No playlists yet</h2><p>Create one, or import a screenshot to get started.</p><div class="empty-actions"><button class="primary" data-action="new-playlist">${icon('plus')} New playlist</button></div></div>`}</div>
  <aside><h2 class="side-heading">SMART PLAYLISTS</h2><div class="smart-list">
    <button class="smart-card" data-smart="backlog"><span class="smart-icon">◌</span><span><h3>The Backlog</h3><p>Added, but never played</p></span><b>${allTracks().filter(t=>!t.lastPlayed).length}</b></button>
    <button class="smart-card" data-smart="old"><span class="smart-icon">↶</span><span><h3>The Old Bangers</h3><p>Old favorites due a replay</p></span><b>${allTracks().filter(t=>t.plays>45&&t.lastPlayed>50).length}</b></button>
    <button class="smart-card" data-smart="hits"><span class="smart-icon">↗</span><span><h3>The Hits</h3><p>Your top 50 tracks</p></span><b>${Math.min(50,allTracks().length)}</b></button>
  </div><div class="screenshot-cta">${icon('camera')}<h3>Screenshot to playlist</h3><p>Drop in a playlist screenshot. Firefly identifies every track.</p><button class="primary" id="screenshotTrigger">Choose screenshot</button></div></aside></div>`;
  bindPlaylistDrag();
  $('#screenshotTrigger').onclick = () => $('#screenshotInput').click();
  $$('.smart-card',view).forEach(btn => btn.onclick = () => {
    const type=btn.dataset.smart; let tracks=allTracks();
    if(type==='backlog') tracks=tracks.filter(t=>!t.lastPlayed); if(type==='old') tracks=tracks.filter(t=>t.plays>45&&t.lastPlayed>50); if(type==='hits') tracks=tracks.sort((a,b)=>b.plays-a.plays).slice(0,50);
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
  const tracks = playlistTracks(playlist);
  const subPlaylistList=playlist.children?`<section class="master-subplaylists"><div class="section-heading"><div><span class="eyebrow">INSIDE THIS MASTER</span><h2>Sub-playlists</h2></div><small>${playlist.children.length} collection${playlist.children.length===1?'':'s'}</small></div><div class="master-subplaylist-list">${playlist.children.map((child,index)=>{const childTracks=playlistTracks(child),playable=childTracks.some(track=>!track.pending);return `<article class="master-subplaylist" style="--sub-color:${child.color||playlist.color||'var(--accent)'}"><button class="subplaylist-main" data-open-subplaylist="${child.id}"><span class="subplaylist-number">${String(index+1).padStart(2,'0')}</span><span class="subplaylist-icon">${child.children?'◫':'♫'}</span><span><b>${esc(child.title)}</b><small>${childTracks.length} songs${child.children?` · ${child.children.length} nested playlists`:''}</small></span></button><button class="subplaylist-play" data-play-subplaylist="${child.id}" aria-label="Play ${esc(child.title)}" ${playable?'':'disabled'}>${icon('play')}</button></article>`}).join('')}</div></section>`:'';
  const trackList=tracks.length?`${playlist.children?`<div class="master-track-heading"><span class="eyebrow">COMPLETE MASTER PLAYLIST</span><h2>All tracks</h2></div>`:''}${songTable(tracks)}`:`<div class="empty-state">${icon('song')}<h2>This playlist is empty</h2><p>Import tracks directly into a sub-playlist, or add tracks from their right-click menu.</p></div>`;
  view.innerHTML = `<button class="ghost" id="backToPlaylists" style="margin-bottom:18px">‹ ${parent?esc(parent.title):'All playlists'}</button><div class="playlist-detail-head"><div class="playlist-detail-art">${playlist.children?'◫':'♫'}</div><div><div class="eyebrow">${playlist.children?'MASTER PLAYLIST':'PLAYLIST'}</div><h1>${esc(playlist.title)}</h1><p>${tracks.length} songs${playlist.children?` · ${playlist.children.length} sub-playlists`:''}</p></div></div><div class="playlist-detail-actions"><button class="primary" id="playPlaylist">${icon('play')} ${playlist.children?'Play All':'Play'}</button><button class="ghost" id="shufflePlaylist">${icon('shuffle')} Shuffle</button>${playlist.children?'':`<button class="ghost" id="addPlaylistTracks">${icon('plus')} Add imported tracks</button>`}</div>${subPlaylistList}${trackList}`;
  $('#backToPlaylists').onclick=()=>parent?historyBack():navigate('playlists');
  $('#playPlaylist').onclick=()=>playTrackQueue(tracks);
  $('#shufflePlaylist').onclick=()=>playTrackQueue(tracks,true);
  $$('[data-open-subplaylist]',view).forEach(button=>button.onclick=()=>openPlaylist(button.dataset.openSubplaylist));
  $$('[data-play-subplaylist]',view).forEach(button=>button.onclick=event=>{event.stopPropagation();playTrackQueue(playlistTracks(findPlaylistById(button.dataset.playSubplaylist)))});
  if($('#addPlaylistTracks'))$('#addPlaylistTracks').onclick=()=>{playlistImportTarget=id;chooseFiles()};
  applySelectionClasses();renderBulkSelectionBar();
  updateHistoryControls();
}

function renamePlaylist(id) {
  const playlist=findPlaylistById(id);if(!playlist)return;
  openModal(`<div class="modal-head"><h2>Edit playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>PLAYLIST NAME</label><input id="renamePlaylistInput" value="${esc(playlist.title)}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="savePlaylistName">Save</button></div>`,true);
  $('#savePlaylistName').onclick=()=>{playlist.title=$('#renamePlaylistInput').value.trim()||playlist.title;saveLibrary();closeModal();currentView.startsWith('playlist:')?openPlaylist(id):render();toast('Playlist updated')};
}

function confirmRemove(title, detail, action) {
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
  const playlist=customPlaylists.find(p=>p.id===id);if(!playlist)return;
  showContextMenu([
    {label:'Open playlist',icon:'playlist',action:()=>openPlaylist(id)},
    {label:'Play',icon:'play',action:()=>{const t=playlistTracks(playlist).find(x=>!x.pending);t?playTrack(t):toast('No playable tracks')}},
    {label:'Rename',icon:'settings',action:()=>renamePlaylist(id)},
    {separator:true},
    {label:'Delete playlist',icon:'close',danger:true,action:()=>confirmRemove('Delete playlist?',`“${playlist.title}” will be removed. Your music files will not be deleted.`,()=>{customPlaylists=customPlaylists.filter(p=>p.id!==id);saveLibrary();navigate('playlists');toast('Playlist removed')})}
  ],x,y);
}

function albumContext(id,x,y) {
  const album=albumById(id);if(!album)return;
  showContextMenu([
    {label:'Open album',icon:'albums',action:()=>openAlbumDetail(id)},
    {label:'Play album',icon:'play',action:()=>{const t=album.tracks.find(x=>!x.pending);if(t)playTrack(t)}},
    {label:'Add album to playlist',icon:'playlist',action:()=>addAlbumToPlaylist(album)},
    {label:'Edit album',icon:'settings',action:()=>editAlbum(id)},
    {label:'Pull metadata & art',icon:'spark',action:()=>metadataLookup(album)},
    {label:'Find full case art',icon:'image',action:()=>caseArtLookup(album)},
    {separator:true},
    {label:'Remove from library',icon:'close',danger:true,action:()=>confirmRemove('Remove album?',`“${album.title}” and its tracks will be removed from Firefly. Source files stay untouched.`,()=>{const ids=new Set(album.tracks.map(t=>t.id));albums=albums.filter(a=>a.id!==id);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,ids));saveLibrary();render();toast('Album removed')})}
  ],x,y);
}

function artistContext(name,x,y) {
  const artistAlbums=albums.filter(a=>a.artist===name),tracks=artistAlbums.flatMap(a=>a.tracks);
  showContextMenu([
    {label:'Open artist',icon:'artist',action:()=>openArtistDetail(name)},
    {label:'Play artist',icon:'play',action:()=>playTrack(tracks.find(t=>!t.pending))},
    {label:'Edit artist image',icon:'image',action:()=>editArtistImage(name)},
    {label:'Rename artist',icon:'settings',action:()=>{openModal(`<div class="modal-head"><h2>Rename artist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>ARTIST NAME</label><input id="artistName" value="${esc(name)}"></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="saveArtist">Save</button></div>`,true);$('#saveArtist').onclick=()=>{const next=$('#artistName').value.trim()||name,oldKey=artistProfileKey(name),nextKey=artistProfileKey(next);artistAlbums.forEach(a=>{a.artist=next;a.tracks.forEach(t=>t.artist=next)});if(oldKey!==nextKey&&artistProfiles[oldKey]){artistProfiles[nextKey]={...artistProfiles[oldKey],...(artistProfiles[nextKey]||{})};delete artistProfiles[oldKey]}saveLibrary();closeModal();currentView=`artist:${encodeURIComponent(next)}`;renderArtistDetail(next);toast('Artist updated')}}},
    {separator:true},
    {label:'Remove artist',icon:'close',danger:true,action:()=>confirmRemove('Remove artist?',`All ${artistAlbums.length} albums by “${name}” will be removed from Firefly. Source files stay untouched.`,()=>{const ids=new Set(tracks.map(t=>t.id));albums=albums.filter(a=>a.artist!==name);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,ids));delete artistProfiles[artistProfileKey(name)];saveLibrary();navigate('artists');toast('Artist removed')})}
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
  openModal(`<div class="modal-head"><h2>Artist image</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="artist-image-editor"><label class="artist-image-slot ${profile.image?'has-image':''}">${profile.image?`<img src="${profile.image}" alt="${esc(name)}">`:artistPortraitMarkup(name,'artist-editor-fallback')}<span>${icon('upload')} Choose an image</span><input type="file" id="artistImageUpload" accept="image/*"></label><div><div class="eyebrow">${esc(name)}</div><h3>Artist portrait</h3><p>Use a square or portrait image. Firefly crops it responsively throughout the artist library.</p><button class="primary" id="findArtistImage">${icon('spark')} Find on the internet</button>${profile.image?`<button class="ghost" id="removeArtistImage">Remove image</button>`:''}</div></div></div><div class="modal-actions"><button class="ghost close-modal">Done</button></div>`);
  bindArtUpload('#artistImageUpload',data=>{artistProfiles[artistProfileKey(name)]={...profile,image:data,sourceUrl:null,sourceLabel:'Custom upload'};saveLibrary();closeModal();render();toast('Artist image updated',name)});
  $('#findArtistImage').onclick=()=>artistImageLookup(name);
  if($('#removeArtistImage'))$('#removeArtistImage').onclick=()=>{delete artistProfiles[artistProfileKey(name)];saveLibrary();closeModal();render();toast('Artist image removed',name)};
}
async function artistImageLookup(name){
  openModal(`<div class="modal-head"><h2>Finding artist images</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status"><span class="spinner"></span><span>Searching Wikidata and Wikimedia Commons for ${esc(name)}…</span></div></div>`);
  try{
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
    const results=pictured.map(item=>{const info=byFile.get(item.file.replaceAll('_',' '));return info?{...item,image:info.thumburl||info.url,sourceUrl:info.descriptionurl||`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(item.file.replaceAll(' ','_'))}`} : null}).filter(item=>item?.image).slice(0,6);
    if(!results.length)throw new Error('No downloadable image previews were available.');
    openModal(`<div class="modal-head"><h2>Choose an artist image</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status">${icon('spark')}<span>${results.length} reusable Wikimedia Commons result${results.length===1?'':'s'} for ${esc(name)}</span></div><div class="artist-image-results">${results.map((result,index)=>`<button data-artist-image-choice="${index}"><span style="background-image:url(&quot;${esc(result.image)}&quot;)"></span><b>${esc(result.label)}</b><small>${esc(result.description)}</small></button>`).join('')}</div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button></div>`);
    $$('[data-artist-image-choice]',modalLayer).forEach(button=>button.onclick=async()=>{const result=results[Number(button.dataset.artistImageChoice)];button.disabled=true;button.classList.add('loading');try{const cached=window.firefly?.cacheArtistImage?await window.firefly.cacheArtistImage({artist:name,url:result.image}):{imageUrl:result.image};artistProfiles[artistProfileKey(name)]={image:cached.imageUrl,sourceUrl:result.sourceUrl,sourceLabel:'Wikimedia Commons',cachedAt:cached.cachedAt};saveLibrary();closeModal();render();toast('Artist image updated',`${name} · saved for offline use`)}catch(error){button.disabled=false;button.classList.remove('loading');toast('Could not save artist image',error.message)}});
  }catch(error){openModal(`<div class="modal-head"><h2>No artist image found</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p class="modal-intro">${esc(error.message||'The image search could not be completed.')}</p></div><div class="modal-actions"><button class="ghost close-modal">Close</button><button class="primary" id="retryArtistImage">Try again</button></div>`,true);$('#retryArtistImage').onclick=()=>artistImageLookup(name)}
}

function addTrackToPlaylist(track) {
  const destinations=leafPlaylists();if(!destinations.length){toast('Create a playlist first');return}
  openModal(`<div class="modal-head"><h2>Add to playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="detected-list">${destinations.map(p=>`<button class="detected-track" data-add-to-playlist="${p.id}" style="background:transparent;color:inherit;text-align:left"><i class="status-dot"></i><span><b>${esc(p.title)}</b><small>${playlistTracks(p).length} songs</small></span><em>ADD</em></button>`).join('')}</div></div>`,true);
  $$('[data-add-to-playlist]',modalLayer).forEach(btn=>btn.onclick=()=>{const p=findPlaylistById(btn.dataset.addToPlaylist);p.trackIds=p.trackIds||[];if(!p.trackIds.includes(track.id))p.trackIds.push(track.id);saveLibrary();closeModal();toast('Added to playlist',p.title)});
}

function trackContext(track,x,y) {
  showContextMenu([
    {label:'Play',icon:'play',action:()=>playTrack(track)},
    {label:'Add to playlist',icon:'playlist',action:()=>addTrackToPlaylist(track)},
    {label:'Edit track',icon:'settings',action:()=>showTrackMenu(track)},
    {separator:true},
    {label:'Remove from library',icon:'close',danger:true,action:()=>confirmRemove('Remove track?',`“${track.title}” will be removed from Firefly. The source file stays untouched.`,()=>{const album=albumById(track.albumId);if(album)album.tracks=album.tracks.filter(t=>t.id!==track.id);customPlaylists.forEach(p=>removePlaylistTrackReferences(p,new Set([track.id])));albums=albums.filter(a=>a.tracks.length||a.id!=='loose-files');saveLibrary();render();toast('Track removed')})}
  ],x,y);
}

function renderSettings() {
  view.innerHTML = pageHead('MAKE IT YOURS','Settings','Tune the player, appearance, library, and connected services.') + `<div class="settings-grid"><nav class="settings-menu"><button class="active">Appearance</button><button>Playback</button><button>Library</button><button>Integrations</button><button>Privacy</button></nav><section class="settings-panel"><h2>Appearance & integrations</h2><p>Customize Firefly down to the smallest detail. Changes apply instantly.</p>
    <div class="setting-row"><div><b>Accent color</b><small>Used for actions, progress, and ambient light</small></div><span class="accent-swatches"><button class="${settings.accent==='#f55f45'?'active':''}" data-accent="#f55f45" data-rgb="245,95,69" style="--swatch:#f55f45"></button><button class="${settings.accent==='#9b7bff'?'active':''}" data-accent="#9b7bff" data-rgb="155,123,255" style="--swatch:#9b7bff"></button><button class="${settings.accent==='#53d6b6'?'active':''}" data-accent="#53d6b6" data-rgb="83,214,182" style="--swatch:#53d6b6"></button><button class="${settings.accent==='#f2b84b'?'active':''}" data-accent="#f2b84b" data-rgb="242,184,75" style="--swatch:#f2b84b"></button></span></div>
    <div class="setting-row"><div><b>Animated background</b><small>Slow reactive color fields across the app</small></div><button class="switch ${settings.ambient?'on':''}" data-toggle="ambient" aria-label="Toggle animated background"></button></div>
    <div class="setting-row"><div><b>Reduced motion</b><small>Minimize shelf, artwork, and navigation effects</small></div><button class="switch ${settings.reducedMotion?'on':''}" data-toggle="motion" aria-label="Toggle reduced motion"></button></div>
    <div class="setting-row"><div><b>Metadata provider</b><small>MusicBrainz with Cover Art Archive fallback</small></div><select><option>MusicBrainz + CAA</option><option>Discogs</option><option>Custom provider</option></select></div>
    <div class="setting-row"><div><b>OpenAI API key</b><small>Encrypted with Windows and kept outside the app installation</small></div><input id="openaiKey" type="password" value="${esc(credentials.openaiKey)}" placeholder="Not connected" autocomplete="off"/></div>
    <div class="setting-row"><div><b>Suno connection</b><small>Browse, create, and import from your Suno library</small></div><button class="ghost" id="connectSuno">${sunoConnected?'Manage connection':'Connect Suno'}</button></div>
    <div class="setting-row"><div><b>Gapless playback</b><small>Remove silence between supported tracks</small></div><button class="switch ${settings.gapless?'on':''}" data-toggle="gapless"></button></div>
    <div class="setting-row"><div><b>Audio crossfade</b><small>Blend the final seconds into the next track</small></div><input id="crossfadeSetting" type="range" value="${settings.crossfade}" style="width:170px;--range:${settings.crossfade}%"/></div>
    <div class="setting-row update-setting-row"><div><b>Update channel</b><small>Stable follows main; Test follows the beta branch</small></div><span class="update-setting-controls"><select id="updateChannel"><option value="stable" ${settings.updateChannel!=='beta'?'selected':''}>Stable · main</option><option value="beta" ${settings.updateChannel==='beta'?'selected':''}>Test · beta</option></select><button class="ghost" id="checkForUpdates">Check now</button></span></div>
    <div class="setting-row"><div><b>Update status</b><small>${updateState.status==='available'?`Version ${esc(updateState.version)} is available`:updateState.status==='error'?esc(updateState.error||'Update check failed'):updateState.status==='checking'?'Checking GitHub now…':updateState.status==='ready'?'Downloaded and ready to launch':'Firefly checks when it opens and every 30 minutes'}</small></div><button class="ghost" id="showUpdateDetails">Details</button></div>
    <div class="setting-row"><div><b>Firefly data folder</b><small>${esc(dataDirectory||'Browser local storage')}</small></div><button class="ghost" id="openDataFolder" ${dataDirectory?'':'disabled'}>Open folder</button></div>
  </section></div>`;
  $$('.accent-swatches button',view).forEach(btn=>btn.onclick=()=>{settings.accent=btn.dataset.accent;settings.accentRgb=btn.dataset.rgb;applySettings();$$('.accent-swatches button').forEach(b=>b.classList.remove('active'));btn.classList.add('active');saveLibrary();toast('Accent updated')});
  $$('.switch',view).forEach(btn=>btn.onclick=()=>{btn.classList.toggle('on');const enabled=btn.classList.contains('on');if(btn.dataset.toggle==='ambient')settings.ambient=enabled;if(btn.dataset.toggle==='motion')settings.reducedMotion=enabled;if(btn.dataset.toggle==='gapless')settings.gapless=enabled;applySettings();saveLibrary()});
  $('#crossfadeSetting').oninput=e=>{settings.crossfade=Number(e.target.value);setRange(e.target,e.target.value);saveLibrary()};
  $('#updateChannel').onchange=e=>{settings.updateChannel=e.target.value==='beta'?'beta':'stable';updateState={status:'idle',channel:settings.updateChannel,available:false,progress:null};saveLibrary();renderUpdateWidget();checkForUpdates(true)};
  $('#checkForUpdates').onclick=()=>checkForUpdates(true);
  $('#showUpdateDetails').onclick=openUpdateModal;
  $('#openaiKey').onchange=e=>{credentials.openaiKey=e.target.value.trim();saveCredentials();toast('OpenAI key saved','Stored with Windows encryption.')};
  if($('#openDataFolder'))$('#openDataFolder').onclick=()=>window.firefly?.openDataDirectory();
  $('#connectSuno').onclick=connectSunoModal;
  $$('.settings-menu button',view).forEach(btn=>btn.onclick=()=>{$$('.settings-menu button',view).forEach(b=>b.classList.remove('active'));btn.classList.add('active');toast(`${btn.textContent} preferences selected`)});
}

function renderSuno() {
  view.innerHTML = `<section class="suno-hero"><span class="connect-pill connection-status ${sunoConnected?'connected':''}"><i></i>${icon('suno')} SUNO STUDIO · ${sunoConnected?'CONNECTED':'NOT CONNECTED'}</span><h1>Make something unheard.</h1><p>Generate songs, explore the public feed, and bring your Suno library into Firefly without leaving your collection.</p><button class="primary" id="sunoConnect">${sunoConnected?'Manage connection':'Connect Suno'}</button></section><div class="suno-tabs"><button class="chip active">For you</button><button class="chip">Your library</button><button class="chip">Create</button></div><div class="empty-state">${icon('suno')}<h2>${sunoConnected?'Suno provider connected':'Connect to load Suno'}</h2><p>${sunoConnected?'Choose Your library or Create to begin using your configured provider.':'Connect a compatible provider to browse or generate music. No example tracks are shown.'}</p></div>`;
  $('#sunoConnect').onclick=connectSunoModal;
  $$('.suno-tabs .chip',view).forEach(b=>b.onclick=()=>{$$('.suno-tabs .chip',view).forEach(x=>x.classList.remove('active'));b.classList.add('active');toast(`${b.textContent} loaded`)});
}

function connectSunoModal() {
  openModal(`<div class="modal-head"><h2>${sunoConnected?'Suno connection':'Connect Suno'}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body">${sunoConnected?`<div class="lookup-status"><span class="status-dot"></span><span>Connected for this Firefly profile. Credentials are encrypted and stored outside the app installation.</span></div>`:''}<div class="form-grid"><div class="field full"><label>SUNO API / PROVIDER URL</label><input id="sunoEndpoint" value="${esc(settings.sunoEndpoint)}" placeholder="https://your-suno-provider.example"></div><div class="field full"><label>ACCESS TOKEN</label><input id="sunoToken" type="password" value="${esc(credentials.sunoToken)}" placeholder="Paste a provider token" autocomplete="off"></div></div><p style="color:#706c67;font-size:9px;margin:14px 0 0">Suno does not provide a universally available public API. Firefly supports provider-compatible endpoints and keeps this connection local to your profile.</p></div><div class="modal-actions">${sunoConnected?'<button class="ghost" id="disconnectSuno" style="margin-right:auto;color:#ef806f">Disconnect</button>':''}<button class="ghost close-modal">Cancel</button><button class="primary" id="finishSunoConnect">${sunoConnected?'Update':'Connect'}</button></div>`,true);
  $('#finishSunoConnect').onclick=()=>{const token=$('#sunoToken').value.trim();if(!sunoConnected&&!token){$('#sunoToken').focus();toast('Enter a provider token');return}settings.sunoEndpoint=$('#sunoEndpoint').value.trim()||defaultSettings.sunoEndpoint;credentials.sunoToken=token;sunoConnected=true;saveCredentials();saveLibrary();closeModal();if(currentView==='suno')renderSuno();else if(currentView==='settings')renderSettings();toast('Suno connected','Connection details will persist across upgrades.')};
  if($('#disconnectSuno'))$('#disconnectSuno').onclick=()=>{sunoConnected=false;credentials.sunoToken='';saveCredentials();saveLibrary();closeModal();if(currentView==='suno')renderSuno();else renderSettings();toast('Suno disconnected')};
}

function shelfAlbumMarkup(album,shelfId){
  const dynamic=dynamicCaseReady(album)?album.dynamicCaseArt:null;
  const scannedSpine=album.fullArtParts?.spine;
  const manualSpine=!album.fullArtParts&&album.customFullArt;
  const hasSpine=Boolean(dynamic||scannedSpine||manualSpine);
  const spineStyle=dynamic
    ? `background-image:url('${dynamic.backgroundUrl}');background-size:auto 100%;background-position:right center;font-family:'${dynamicFontName(dynamic.font)}';`
    : scannedSpine
    ? `background-image:url('${scannedSpine}');background-size:${album.fullArtParts.spineMode==='back-scan'?'auto 100%':'cover'};background-position:${album.fullArtParts.spineMode==='back-scan'?'right center':'center'};`
    : (manualSpine?`background-image:url('${album.customFullArt}');background-size:auto 100%;background-position:center;`:'');
  return `<div draggable="true" class="shelf-album ${dynamic?'dynamic-shelf-spine':hasSpine?'has-real-spine':'auto-spine'}" data-shelf-album="${album.id}" data-parent-shelf="${shelfId}" style="${spineStyle}">${dynamic||!hasSpine?`${esc(album.artist)} - ${esc(album.title)}`:''}</div>`;
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
function closeModal(){modalLayer.classList.remove('open');modalLayer.setAttribute('aria-hidden','true');setTimeout(()=>modalLayer.innerHTML='',200)}

function editAlbum(id) {
  const a=albumById(id);
  openModal(`<div class="modal-head"><h2>Customize album</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body">
    <div class="artwork-slots"><label class="art-slot" id="coverSlot">${a.customCover?`<img src="${a.customCover}">`:albumCover(a)}<span>${icon('image')}Cover art<br><small>Square · 1400px+</small></span><input type="file" id="coverUpload" accept="image/*"></label><label class="art-slot" id="fullArtSlot">${a.customFullArt?`<img src="${a.customFullArt}">`:''}<span>${icon('image')}Full case art<br><small>Front · spine · back</small></span><span class="full-art-labels"><i>BACK</i><i>SPINE</i><i>FRONT</i></span><input type="file" id="fullArtUpload" accept="image/*"></label></div>
    ${dynamicCaseSectionMarkup(a)}
    <div class="form-grid"><div class="field"><label>ALBUM TITLE</label><input id="editTitle" value="${esc(a.title)}"></div><div class="field"><label>ARTIST</label><input id="editArtist" value="${esc(a.artist)}"></div><div class="field"><label>YEAR</label><input id="editYear" type="number" value="${a.year}"></div><div class="field"><label>GENRE</label><input id="editGenre" value="${esc(a.genre)}"></div><div class="field full"><label>NOTES</label><textarea rows="2" placeholder="Personal notes, edition details, catalog number…"></textarea></div></div>
  </div><div class="modal-actions"><button class="ghost" id="lookupMetadata">${icon('spark')} Pull metadata & cover</button><button class="ghost" id="lookupCaseArt">${icon('image')} Find full case art</button><span style="flex:1"></span><button class="ghost close-modal">Cancel</button><button class="primary" id="saveAlbum">Save changes</button></div>`);
  bindDynamicCaseControls(a);
  bindArtUpload('#coverUpload', data=>{a.customCover=data;$('#coverSlot').insertAdjacentHTML('afterbegin',`<img src="${data}">`);markDynamicCaseStale(a)});
  bindArtUpload('#fullArtUpload', data=>{a.customFullArt=data;a.fullArtParts={front:null,back:data,spine:data,spineMode:'full-spread'};$('#fullArtSlot').insertAdjacentHTML('afterbegin',`<img src="${data}">`)});
  $('#lookupMetadata').onclick=()=>metadataLookup(a);
  $('#lookupCaseArt').onclick=()=>caseArtLookup(a);
  $('#saveAlbum').onclick=()=>{a.title=$('#editTitle').value.trim()||a.title;a.artist=$('#editArtist').value.trim()||a.artist;a.year=Number($('#editYear').value)||a.year;a.genre=$('#editGenre').value.trim()||a.genre;a.tracks.forEach(t=>{t.album=a.title;t.artist=a.artist});saveLibrary();closeModal();render();toast('Album updated',`${a.artist} — ${a.title}`)};
}
function bindArtUpload(selector, callback){$(selector).onchange=e=>{const file=e.target.files[0];if(!file)return;const r=new FileReader();r.onload=()=>callback(r.result);r.readAsDataURL(file)}}
async function metadataLookup(a){
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
  $$('[data-meta-index]',modalLayer).forEach(btn=>btn.onclick=()=>{const c=candidates[Number(btn.dataset.metaIndex)];a.title=c.title;a.artist=c.artist;a.year=c.year;if(c.art){a.customCover=c.art;a.cover=''}else{a.cover=c.cover;a.customCover=null}a.tracks.forEach(t=>{t.album=a.title;t.artist=a.artist});if(a.dynamicCaseArt?.enabled&&a.dynamicCaseArt?.backgroundUrl)a.dynamicCaseArt.status='stale';saveLibrary();closeModal();render();toast('Metadata applied',`Updated artwork and tags for ${a.title}`)});
}

function coverArtTypes(image){return (image?.types||[]).map(type=>String(type).toLowerCase())}
function coverArtUrl(image){return image?.thumbnails?.['1200']||image?.thumbnails?.large||image?.thumbnails?.['500']||image?.image||null}
function preferredCoverImage(images,type){
  const matches=images.filter(image=>coverArtTypes(image).includes(type)||Boolean(image?.[type]));
  return matches.find(image=>image.approved!==false)||matches[0]||null;
}
async function caseArtLookup(a){
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
    openModal(`<div class="modal-head"><h2>No case scans found</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="empty-state" style="padding:42px 20px">${icon('image')}<h2>No back-cover scans are available</h2><p>Try another album or release title. Firefly only shows editions with a genuine back-cover scan in full case-art results.</p></div></div><div class="modal-actions"><button class="ghost close-modal">Close</button><button class="primary" id="retryCaseArt">Retry search</button></div>`,true);$('#retryCaseArt').onclick=()=>caseArtLookup(a);return;
  }
  const realSpineCount=cases.filter(item=>item.spine).length;
  openModal(`<div class="modal-head"><h2>Choose full case artwork</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="lookup-status">${icon('spark')}<span>${cases.length} release${cases.length===1?'':'s'} with real back art found · ${realSpineCount} with scanned spine art. Editions with spines are listed first.</span></div><div class="case-art-grid">${cases.map((item,index)=>{const spineStyle=item.spine?`background-image:url('${item.spine}');background-size:${item.spineMode==='back-scan'?'auto 100%':'cover'};background-position:${item.spineMode==='back-scan'?'right center':'center'};`:'';return `<button class="case-art-choice" data-case-index="${index}"><div class="case-art-preview"><span style="background-image:url('${item.back}')"></span><i class="${item.spine?'scanned-spine':'auto-spine-preview'}" style="${spineStyle}">${item.spine?'':'AUTO'}</i><span style="background-image:url('${item.front||item.back}')"></span></div><b>${esc(item.title)}</b><small>${esc([item.country,item.date].filter(Boolean).join(' · ')||'Scanned release')} · Back ✓ · ${item.spine?'Spine scan ✓':'Auto spine'}</small></button>`}).join('')}</div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button></div>`);
  $$('[data-case-index]',modalLayer).forEach(btn=>btn.onclick=()=>{const item=cases[Number(btn.dataset.caseIndex)];a.fullArtParts={front:item.front,back:item.back,spine:item.spine,spineMode:item.spineMode,sourceReleaseId:item.id};a.customFullArt=item.back;if(!a.customCover&&item.front){a.customCover=item.front;a.cover=''}saveLibrary();closeModal();render();toast('Full case artwork applied',item.spine?'Real back and spine scans added.':'Real back cover added; no spine scan exists for this edition, so the text spine will be used.')});
}

function openMasterPlaylistModal(sourceId,targetId){
  const s=customPlaylists.find(p=>p.id===sourceId),t=customPlaylists.find(p=>p.id===targetId);
  openModal(`<div class="modal-head"><h2>Create master playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p style="color:#888;margin-top:0">Combine <b>${esc(s.title)}</b> and <b>${esc(t.title)}</b>. The master stays in sync while each sub-playlist remains playable on its own.</p><div class="field"><label>MASTER PLAYLIST NAME</label><input id="masterName" value="${esc(s.title)} + ${esc(t.title)}" autofocus></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="createMaster">Create master</button></div>`,true);
  $('#createMaster').onclick=()=>{const title=$('#masterName').value.trim();if(!title)return;customPlaylists=customPlaylists.filter(p=>![sourceId,targetId].includes(p.id));customPlaylists.unshift({id:`master-${Date.now()}`,title,color:'#f07157',children:[s,t]});saveLibrary();closeModal();renderPlaylists();toast('Master playlist created',`${title} combines ${s.title} and ${t.title}`)};
}
function newPlaylistModal(){openModal(`<div class="modal-head"><h2>New playlist</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="field"><label>PLAYLIST NAME</label><input id="playlistName" placeholder="Untitled playlist" autofocus></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="makePlaylist">Create</button></div>`,true);$('#makePlaylist').onclick=()=>{const title=$('#playlistName').value.trim()||'Untitled playlist';const playlist={id:`playlist-${Date.now()}`,title,trackIds:[],color:'#6f8fab'};customPlaylists.unshift(playlist);saveLibrary();closeModal();openPlaylist(playlist.id);toast('Playlist created',title)}}

function openTrackCollection(title,tracks){openModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body" style="padding-top:10px">${songTable(tracks)}</div><div class="modal-actions"><button class="primary" id="playCollection">${icon('play')} Play all</button></div>`);$('#playCollection').onclick=()=>{const playable=tracks.find(t=>!t.pending);if(playable)playTrack(playable);closeModal()}}

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
function makeTrack(entry,album,index=0){const meta=entry.metadata||{};return{id:`local-${Date.now()}-${index}-${Math.random().toString(36).slice(2,7)}`,title:meta.title||cleanTrackTitle(entry.name),artist:meta.artist||album.artist,album:album.title,albumId:album.id,duration:displayDuration(meta.duration),trackNumber:meta.track||index+1,discNumber:meta.disc||1,plays:0,lastPlayed:null,added:Date.now(),pending:false,url:entry.url||null,path:entry.path||null}}

function normalizeBrowserFiles(files){return [...files].map(file=>({name:file.name,relativePath:file.webkitRelativePath||file.name,url:URL.createObjectURL(file),kind:file.type.startsWith('image/')?'image':'audio'}))}
function importAudioEntries(entries,targetTrack=null){
  const audioEntries=entries.filter(e=>e.kind!=='image');if(!audioEntries.length){toast('No supported audio files found');return}
  const added=[];
  audioEntries.forEach((entry,index)=>{
    const meta=entry.metadata||{};
    if(targetTrack&&index===0){
      targetTrack.title=meta.title||cleanTrackTitle(entry.name);targetTrack.artist=meta.artist||targetTrack.artist;targetTrack.url=entry.url;targetTrack.path=entry.path||null;targetTrack.pending=false;targetTrack.duration=displayDuration(meta.duration);targetTrack.trackNumber=meta.track||targetTrack.trackNumber||1;targetTrack.discNumber=meta.disc||targetTrack.discNumber||1;
      if(meta.album){const artist=meta.albumArtist||meta.artist||'Unknown Artist';let destination=albums.find(a=>a.title.toLowerCase()===meta.album.toLowerCase()&&a.artist.toLowerCase()===artist.toLowerCase());if(!destination){destination={id:`tagged-${Date.now()}-${index}`,title:meta.album,artist,year:meta.year||new Date().getFullYear(),genre:meta.genre||'Unknown',cover:meta.artwork?'':'cover-8',customCover:meta.artwork||null,fullArt:null,tracks:[]};albums.push(destination)}const source=albumById(targetTrack.albumId);if(source&&source.id!==destination.id)source.tracks=source.tracks.filter(t=>t.id!==targetTrack.id);if(!destination.tracks.includes(targetTrack))destination.tracks.push(targetTrack);targetTrack.album=destination.title;targetTrack.albumId=destination.id}
      added.push(targetTrack);return;
    }
    let album;
    if(meta.album){
      const artist=meta.albumArtist||meta.artist||'Unknown Artist';
      album=albums.find(a=>a.title.toLowerCase()===meta.album.toLowerCase()&&a.artist.toLowerCase()===artist.toLowerCase());
      if(!album){album={id:`tagged-${Date.now()}-${index}`,title:meta.album,artist,year:meta.year||new Date().getFullYear(),genre:meta.genre||'Unknown',cover:meta.artwork?'':'cover-8',customCover:meta.artwork||null,fullArt:null,tracks:[]};albums.push(album)}
    } else album=ensureLooseAlbum();
    const track=makeTrack(entry,album,index);album.tracks.push(track);album.tracks.sort((a,b)=>(a.discNumber||1)-(b.discNumber||1)||(a.trackNumber||999)-(b.trackNumber||999));added.push(track);
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
    const album={id,title,artist,year:mostCommon(tracks.map(t=>t.metadata?.year))||new Date().getFullYear(),genre:mostCommon(tracks.map(t=>t.metadata?.genre))||'Imported',cover:(preferred||embeddedArt)?'':'cover-8',customCover:preferred?.url||embeddedArt||null,fullArt:null,tracks:[]};
    album.tracks=tracks.map((entry,index)=>makeTrack(entry,album,index)).sort((a,b)=>(a.discNumber||1)-(b.discNumber||1)||(a.trackNumber||999)-(b.trackNumber||999));albums.push(album);albumCount++;
  });
  saveLibrary();navigate('albums');toast('Folder imported',`${albumCount} album${albumCount===1?'':'s'} · ${looseCount} loose track${looseCount===1?'':'s'}`);
}

async function chooseFiles(targetTrackId=null){
  if(window.firefly?.chooseMusicFiles){const entries=await window.firefly.chooseMusicFiles();if(entries.length)importAudioEntries(entries,targetTrackId?allTracks().find(t=>t.id===targetTrackId):null)}
  else{$('#audioInput').dataset.targetTrack=targetTrackId||'';$('#audioInput').click()}
}
async function chooseFolder(){
  if(window.firefly?.chooseMusicFolder){const folder=await window.firefly.chooseMusicFolder();if(folder)importFolderEntries(folder)}
  else $('#folderInput').click();
}
function showImportMenu(){const rect=$('#importTrigger').getBoundingClientRect();showContextMenu([{label:'Import music files',icon:'song',action:()=>chooseFiles()},{label:'Import a folder',icon:'albums',action:chooseFolder}],rect.right-205,rect.bottom+7)}

function showTrackMenu(track){
  if(track.pending){openModal(`<div class="modal-head"><h2>Pending track</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><p style="color:#888">${esc(track.title)} by ${esc(track.artist)} is in the playlist but not in your library. Import the matching audio file to activate it and auto-tag its metadata.</p></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="importPending">${icon('upload')} Import audio</button></div>`,true);$('#importPending').onclick=()=>{closeModal();chooseFiles(track.id)};return}
  const sourceAlbum=albumById(track.albumId);
  openModal(`<div class="modal-head"><h2>Edit song</h2><button class="close-modal">${icon('close')}</button></div><div class="modal-body"><div class="form-grid"><div class="field full"><label>SONG TITLE</label><input id="trackTitle" value="${esc(track.title)}"></div><div class="field"><label>ARTIST</label><input id="trackArtist" value="${esc(track.artist)}"></div><div class="field"><label>ALBUM</label><input id="trackAlbum" value="${esc(track.album)}" list="albumNames"><datalist id="albumNames">${albums.map(a=>`<option value="${esc(a.title)}"></option>`).join('')}</datalist></div><div class="field"><label>TRACK NUMBER</label><input id="trackNumber" type="number" min="1" value="${sourceAlbum?sourceAlbum.tracks.indexOf(track)+1:1}"></div><div class="field"><label>GENRE</label><input id="trackGenre" value="${esc(sourceAlbum?.genre||'')}" /></div></div></div><div class="modal-actions"><button class="ghost close-modal">Cancel</button><button class="primary" id="saveTrack">Save song</button></div>`);
  $('#saveTrack').onclick=()=>{
    const albumName=$('#trackAlbum').value.trim()||track.album;
    let destination=albums.find(a=>a.title.toLowerCase()===albumName.toLowerCase());
    if(!destination){destination={id:`album-${Date.now()}`,title:albumName,artist:$('#trackArtist').value.trim()||'Unknown Artist',year:new Date().getFullYear(),genre:$('#trackGenre').value.trim()||'Unknown',cover:'cover-8',tracks:[]};albums.push(destination)}
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

function playTrackQueue(tracks,shuffle=false){
  playbackQueue=tracks.filter(track=>!track.pending);
  if(shuffle){for(let index=playbackQueue.length-1;index>0;index--){const swap=Math.floor(Math.random()*(index+1));[playbackQueue[index],playbackQueue[swap]]=[playbackQueue[swap],playbackQueue[index]]}}
  if(!playbackQueue.length){toast('No playable tracks');return}
  playTrack(playbackQueue[0],true);
}
function playTrack(track,preserveQueue=false){
  if(!track){toast('Nothing to play','Import music first.');return}
  if(track.pending){toast('Skipped pending track','Import the audio file to make this track playable.');return}
  if(!preserveQueue)playbackQueue=[];
  currentTrack=track;const a=albumById(track.albumId);$('#nowTitle').textContent=track.title;$('#nowArtist').textContent=`${track.artist} · ${track.album}`;$('#fullTitle').textContent=track.title;$('#fullArtist').textContent=`${track.artist} · ${track.album}`;
  $$('.now-cover').forEach(c=>{c.className=`now-cover ${a?.cover||'cover-8'}`;if(a?.customCover){c.style.backgroundImage=`url('${a.customCover}')`;c.style.backgroundSize='cover'}});
  updateFullscreenArtistBackdrop(track);
  if(track.url){audio.src=track.url;audio.play().then(()=>setPlaying(true)).catch(()=>toast('Playback needs a click','Press play once to allow local audio.'));}else{simProgress=0;setRange($('#progress'),0);setPlaying(true)}
  if($('#fullscreenPlayer').classList.contains('open'))prepareTrackVideo(track);
}
function setPlaying(value){isPlaying=value;const name=value?'pause':'play';$('#playBtn').innerHTML=icon(name);$('#fullPlay').innerHTML=icon(name);clearInterval(simTimer);if(value&&!currentTrack.url){simTimer=setInterval(()=>{simProgress=(simProgress+.22)%100;setRange($('#progress'),simProgress);$('#elapsed').textContent=formatTime(simProgress*2.72)},1000)}}
function togglePlay(){if(!currentTrack){toast('Nothing to play','Import music first.');return}if(currentTrack.url){if(audio.paused)audio.play();else audio.pause()}else setPlaying(!isPlaying)}
function formatTime(s){s=Math.floor(s);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`}
function nextTrack(dir=1){const tracks=playbackQueue.length?playbackQueue:allTracks().filter(t=>!t.pending);if(!tracks.length){toast('Nothing to play','Import music first.');return}const idx=currentTrack?tracks.findIndex(t=>t.id===currentTrack.id):-1;playTrack(tracks[(idx+dir+tracks.length)%tracks.length],Boolean(playbackQueue.length))}

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
const waitForMusicBrainz=()=>new Promise(resolve=>setTimeout(resolve,1100));
async function discoverExistingMusicVideo(track){
  const cached=track.video;
  if(cached?.status==='found'&&cached.embedUrl)return cached;
  if(cached?.status==='not-found'&&Date.now()-(cached.searchedAt||0)<VIDEO_RECHECK_MS)return cached;
  if(cached?.status==='generating'&&cached.searchedAt)return cached;
  const luceneValue=value=>String(value||'').replace(/["\\]/g,' ').trim();
  const baseQuery=`recording:"${luceneValue(track.title)}" AND artist:"${luceneValue(track.artist)}"`;
  const rememberPlayable=(recording,playable)=>{track.video={status:'found',searchedAt:Date.now(),recordingId:recording.id,...playable};saveLibrary();return track.video};
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
  if(!recordings.length){track.video={status:'not-found',searchedAt:Date.now()};saveLibrary();return track.video}
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
  track.video={status:'not-found',searchedAt:Date.now()};saveLibrary();return track.video;
}
function renderVideoStatus(kind,video={}){
  const stage=$('#videoStage'),host=$('#onlineVideoHost'),card=$('#videoStatusCard');
  stage.classList.toggle('online-video',kind==='found');stage.classList.toggle('ai-video',kind==='generating');
  host.innerHTML='';
  if(kind==='searching')card.innerHTML=`<span class="spinner"></span><div><b>Searching for an existing music video</b><small>Checking verified recording links before AI generation</small></div>`;
  if(kind==='found'){
    const playerOrigin=location.origin.startsWith('http')?location.origin:'https://firefly.local';
    const embedUrl=video.provider==='YouTube'?`${video.embedUrl}&origin=${encodeURIComponent(playerOrigin)}`:video.embedUrl;
    host.innerHTML=window.firefly?.platform==='win32'
      ? `<webview class="online-video-frame" src="${embedUrl}" title="${esc(currentTrack?.artist)} — ${esc(currentTrack?.title)} music video" webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"></webview>`
      : `<iframe class="online-video-frame" src="${embedUrl}" title="${esc(currentTrack?.artist)} — ${esc(currentTrack?.title)} music video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    card.innerHTML=`<span class="video-found-dot"></span><div><b>Existing video found on ${esc(video.provider)}</b><small>Matched through verified recording metadata · <a href="${video.sourceUrl}" target="_blank" rel="noreferrer">Open source</a></small></div><button data-video-action="search-again">Search again</button>`;
    if($('#fullscreenPlayer').classList.contains('video')){if(currentTrack?.url&&!audio.paused)audio.pause();else if(!currentTrack?.url)setPlaying(false)}
  }
  if(kind==='generating')card.innerHTML=`<span class="spinner"></span><div><b>No existing video found · generating with AI</b><small>Search completed first · generation continues in the background</small></div>`;
  if(kind==='no-key')card.innerHTML=`<span class="video-missing-dot"></span><div><b>No existing music video found</b><small>Connect OpenAI to generate one after this completed search</small></div><button data-video-action="open-settings">Open settings</button><button data-video-action="search-again">Retry</button>`;
  if(kind==='error')card.innerHTML=`<span class="video-missing-dot"></span><div><b>Couldn’t complete the online video search</b><small>AI generation has not started · ${esc(video.message||'Check your connection and retry.')}</small></div><button data-video-action="search-again">Retry search</button>`;
}
function queueAIVideo(track){
  if(!credentials.openaiKey){renderVideoStatus('no-key');return}
  if(track.video?.status!=='generating'){track.video={status:'generating',searchedAt:track.video?.searchedAt||Date.now(),queuedAt:Date.now(),prompt:`Music video for ${track.artist} — ${track.title}, inspired by the album artwork and musical style.`};saveLibrary()}
  renderVideoStatus('generating',track.video);
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
function setFullscreenMode(mode){
  $$('.full-mode button').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));
  const player=$('#fullscreenPlayer');player.classList.toggle('video',mode==='video');
  if(mode==='visualizer'){$('#onlineVideoHost').innerHTML='';drawVisualizer();return}
  if(currentTrack?.video?.status==='found')renderVideoStatus('found',currentTrack.video);
  else if(currentTrack?.video?.status==='generating')renderVideoStatus('generating',currentTrack.video);
}
function updateFullscreenArtistBackdrop(track=currentTrack){const backdrop=$('#fullscreenArtistBackdrop'),image=track?artistProfile(track.artist).image:'';backdrop.style.backgroundImage=image?`url("${String(image).replace(/["\\]/g,'\\$&')}")`:'';backdrop.classList.toggle('has-image',Boolean(image))}
function openFullscreen(){const fp=$('#fullscreenPlayer');updateFullscreenArtistBackdrop();fp.classList.add('open');fp.setAttribute('aria-hidden','false');document.body.requestFullscreen?.().catch(()=>{});resizeCanvas();drawVisualizer();if(currentTrack)prepareTrackVideo(currentTrack)}
function closeFullscreen(){const fp=$('#fullscreenPlayer');videoLookupToken++;$('#onlineVideoHost').innerHTML='';fp.classList.remove('open');fp.setAttribute('aria-hidden','true');if(document.fullscreenElement)document.exitFullscreen?.()}
let visualFrame=null;
function resizeCanvas(){const c=$('#visualizer');const dpr=Math.min(devicePixelRatio,2);c.width=innerWidth*dpr;c.height=innerHeight*dpr;c.getContext('2d').setTransform(dpr,0,0,dpr,0,0)}
function drawVisualizer(){cancelAnimationFrame(visualFrame);const canvas=$('#visualizer'),ctx=canvas.getContext('2d');let phase=0;const loop=()=>{if(!$('#fullscreenPlayer').classList.contains('open'))return;phase+=isPlaying?.018:.006;const w=innerWidth,h=innerHeight;ctx.globalCompositeOperation='destination-out';ctx.fillStyle='rgba(0,0,0,.2)';ctx.fillRect(0,0,w,h);ctx.globalCompositeOperation='source-over';const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();for(let band=0;band<4;band++){ctx.beginPath();for(let x=0;x<=w;x+=8){const amp=(35+band*17)*(isPlaying?1:.35);const y=h*.47+Math.sin(x*.008+phase*(2+band*.25)+band)*amp+Math.sin(x*.019-phase)*20;if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.strokeStyle=band===0?accent:`rgba(210,130,100,${.36-band*.07})`;ctx.lineWidth=2-band*.25;ctx.shadowColor=accent;ctx.shadowBlur=band===0?20:6;ctx.stroke()}ctx.shadowBlur=0;visualFrame=requestAnimationFrame(loop)};loop()}

// Global interactions
$('#primaryNav').addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)navigate(btn.dataset.view)});
$('.sidebar-bottom').addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)navigate(btn.dataset.view)});
$('#updateWidget').onclick=openUpdateModal;
$('#miniPlaylists').addEventListener('click',e=>{const btn=e.target.closest('[data-sidebar-playlist]');if(btn)openPlaylist(btn.dataset.sidebarPlaylist)});
document.addEventListener('click',e=>{
  if(!e.target.closest('#contextMenu')&&!e.target.closest('#importTrigger'))hideContextMenu();
  const selectableAlbum=e.target.closest('.album-card[data-album]'),selectableTrack=e.target.closest('tr[data-track]'),modifier=e.ctrlKey||e.metaKey||e.shiftKey;
  if(modifier&&!e.target.closest('button')&&(selectableAlbum||selectableTrack)){e.preventDefault();handleBulkSelection(selectableAlbum?'album':'track',selectableAlbum?.dataset.album||selectableTrack.dataset.track,e);return}
  if(!modifier&&!e.target.closest('button')&&(selectableAlbum||selectableTrack)&&(selectedTrackIds.size||selectedAlbumIds.size))clearBulkSelection();
  const videoAction=e.target.closest('[data-video-action]');
  if(videoAction?.dataset.videoAction==='search-again'&&currentTrack)prepareTrackVideo(currentTrack,true);
  if(videoAction?.dataset.videoAction==='open-settings'){closeFullscreen();navigate('settings')}
  const newBtn=e.target.closest('[data-action="new-playlist"]');if(newBtn)newPlaylistModal();
  const importBtn=e.target.closest('[data-import]');if(importBtn){importBtn.dataset.import==='folder'?chooseFolder():chooseFiles()}
  const edit=e.target.closest('[data-edit-album]');if(edit){e.stopPropagation();editAlbum(edit.dataset.editAlbum)}
  const play=e.target.closest('[data-play-album]');if(play){e.stopPropagation();playTrack(albumById(play.dataset.playAlbum)?.tracks[0])}
  const album=e.target.closest('.album-card');if(album&&!e.target.closest('button'))openAlbumDetail(album.dataset.album);
  const row=e.target.closest('[data-track]');if(row&&!e.target.closest('button')){const t=allTracks().find(x=>x.id===row.dataset.track);if(t)playTrack(t)}
  const rowAction=e.target.closest('[data-row-action]');if(rowAction){const t=allTracks().find(x=>x.id===rowAction.dataset.rowAction),rect=rowAction.getBoundingClientRect();if(t)trackContext(t,rect.right-205,rect.bottom+4)}
});
document.addEventListener('contextmenu',e=>{
  const playlist=e.target.closest('[data-playlist-card],[data-sidebar-playlist]');if(playlist){e.preventDefault();playlistContext(playlist.dataset.playlistCard||playlist.dataset.sidebarPlaylist,e.clientX,e.clientY);return}
  const row=e.target.closest('[data-track]');if(row){e.preventDefault();const t=allTracks().find(x=>x.id===row.dataset.track);if(t)trackContext(t,e.clientX,e.clientY);return}
  const artist=e.target.closest('[data-artist]');if(artist){e.preventDefault();artistContext(artist.dataset.artist,e.clientX,e.clientY);return}
  const album=e.target.closest('[data-album]');if(album){e.preventDefault();albumContext(album.dataset.album,e.clientX,e.clientY)}
});
$('#shelfToggle').onclick=()=>currentView==='shelf'?navigate('albums'):navigate('shelf');
const historyButtons=$$('.history button');if(historyButtons.length>=2){historyButtons[0].onclick=historyBack;historyButtons[1].onclick=historyForward;updateHistoryControls()}
$('#bulkSelectionBar').addEventListener('click',event=>{const action=event.target.closest('[data-bulk-action]');if(action)runBulkAction(action.dataset.bulkAction)});
$('#importTrigger').onclick=showImportMenu;
$('#audioInput').onchange=e=>{const target=e.target.dataset.targetTrack?allTracks().find(t=>t.id===e.target.dataset.targetTrack):null;if(e.target.files.length)importAudioEntries(normalizeBrowserFiles(e.target.files),target);e.target.value='';e.target.dataset.targetTrack=''};
$('#folderInput').onchange=e=>{if(e.target.files.length){const entries=normalizeBrowserFiles(e.target.files),first=(entries[0].relativePath||'Imported folder').split('/')[0];importFolderEntries({name:first,entries})}e.target.value=''};
$('#screenshotInput').onchange=e=>{if(e.target.files[0])screenshotWorkflow(e.target.files[0]);e.target.value=''};
$('#playBtn').onclick=togglePlay;$('#fullPlay').onclick=togglePlay;$('#prevBtn').onclick=()=>nextTrack(-1);$('#nextBtn').onclick=()=>nextTrack(1);$('#fullscreenBtn').onclick=openFullscreen;$('#closeFull').onclick=closeFullscreen;
audio.onplay=()=>setPlaying(true);audio.onpause=()=>setPlaying(false);audio.onended=()=>nextTrack(1);audio.ontimeupdate=()=>{if(!audio.duration)return;const p=audio.currentTime/audio.duration*100;setRange($('#progress'),p);$('#elapsed').textContent=formatTime(audio.currentTime);$('#duration').textContent=formatTime(audio.duration)};
$('#progress').oninput=e=>{setRange(e.target,e.target.value);if(currentTrack?.url&&audio.duration)audio.currentTime=audio.duration*e.target.value/100;else simProgress=Number(e.target.value)};
$('#volume').oninput=e=>{setRange(e.target,e.target.value);settings.volume=Number(e.target.value);audio.volume=settings.volume/100;saveLibrary()};
$('#shuffleBtn').onclick=()=>{const tracks=allTracks().filter(t=>!t.pending);if(!tracks.length){toast('Nothing to shuffle','Import music first.');return}playTrack(tracks[Math.floor(Math.random()*tracks.length)]);toast('Shuffling your library')};
$('#searchInput').oninput=e=>{if(currentView==='albums')renderAlbums(e.target.value);else if(currentView==='artists')renderArtists(e.target.value);else if(currentView==='songs')renderSongs(e.target.value)};
$('#searchInput').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';render()}});
$$('.full-mode button').forEach(btn=>btn.onclick=()=>setFullscreenMode(btn.dataset.mode));
window.addEventListener('resize',()=>{hideContextMenu();if($('#fullscreenPlayer').classList.contains('open'))resizeCanvas()});
$('.content').addEventListener('scroll',hideContextMenu,{passive:true});
document.addEventListener('keydown',e=>{
  const editing=['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#searchInput').focus()}
  if(e.code==='Space'&&!editing){e.preventDefault();togglePlay()}
  if((e.key==='Delete'||e.key==='Backspace')&&!editing&&(selectedTrackIds.size||selectedAlbumIds.size)){e.preventDefault();deleteBulkSelection();return}
  if(e.key==='Escape'){hideContextMenu();if(modalLayer.classList.contains('open'))closeModal();else if($('#fullscreenPlayer').classList.contains('open'))closeFullscreen();else if(selectedTrackIds.size||selectedAlbumIds.size)clearBulkSelection()}
});

initializePersistence();
