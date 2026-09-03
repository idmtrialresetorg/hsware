'use strict';

// HSWare v11.4 Catalog Intelligence
//
// WinGet is treated as a verification/install source, not as a popularity feed.
// Discover eligibility is decided here using explicit market anchors plus bounded
// heuristics. Unknown long-tail packages remain searchable/importable by exact
// WinGet ID, but do not automatically enter Discover.

const { starterPackages } = require('./starter-catalog');
const { inferCatalogCategory } = require('./catalog-taxonomy');

const PRICING = Object.freeze({
  FREE: 'free',
  FREEMIUM: 'freemium',
  FREE_TIER: 'free-tier',
  FREE_TRIAL: 'free-trial',
  PAID: 'paid',
  SUBSCRIPTION: 'subscription',
  OPEN_SOURCE: 'open-source',
  UNKNOWN: 'unknown'
});

const COMMERCIAL_PUBLISHERS = [
  'adobe','microsoft','google','apple','jetbrains','docker','oracle','vmware','zoom','slack','discord','spotify','dropbox','cisco',
  'teamviewer','anydesk','autodesk','wondershare','blackmagic design','techsmith','notion','figma','canva','grammarly','todoist','doist',
  'appest','evernote','malwarebytes','agilebits','1password','nord security','nordsecurity','proton','tailscale','cloudflare','piriform',
  'revouninstaller','sublime hq','sublimehq','dbeaver','heidisql','tableau','cockos','atomix','plex','tidal','deezer','gog','blizzard',
  'electronic arts','ubisoft','parsec','foxit','tracker software','kingsoft','elsevier','unity','github','postman','insomnia','atlassian'
];

const OPEN_SOURCE_LEADERS = [
  'mozilla','videolan','7zip','obsproject','git','audacity','gimp','blenderfoundation','inkscape','handbrake','qbittorrent','bitwarden',
  'rustdesk','sharex','flameshot','sumatrapdf','libreoffice','openjs','python','wireguard','keepassxc','peazip','nanazip','signal',
  'kde','qgis','kicad','arduino','zotero','calibre','obsidian','joplin','winscp','putty','notepad++'
];

const HARD_REJECT_PATTERNS = [
  /(?:^|[\s._-])(runtime|redistributable|redist|sdk|devkit|headers?|symbols?|lang(?:uage)?[\s._-]*pack|driver[\s._-]*pack|plugin|extension|addon|module|libraries?|samples?|tests?|testdata|debug)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(nightly|alpha|beta|preview|canary|snapshot|experimental|devbuild|unstable)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(sample|example|demo|template|skeleton|starter[\s._-]*kit)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(toolchain|compiler[\s._-]*runtime|server[\s._-]*core|headless|daemon|service[\s._-]*only)(?:$|[\s._-])/i
];

const LOW_SIGNAL_PATTERNS = [
  /\b(unofficial|fork|legacy|deprecated|old version|portable build|community build)\b/i,
  /\b(cli|command line|library|framework|runtime|sdk|developer kit)\b/i
];

const END_USER_SIGNALS = /\b(browser|desktop|client|studio|editor|viewer|player|manager|office|suite|vpn|meeting|chat|messenger|backup|sync|remote|recorder|capture|designer|ide|terminal|database|password|security|photo|video|audio|music|pdf|calendar|notes?|launcher|game|drive|cloud|mail|download|archive|monitor|benchmark|finance|accounting|diagram|task|project)\b/i;

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[_+./-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function commercialPublisher(value) {
  const v = normalize(value);
  return Boolean(v) && COMMERCIAL_PUBLISHERS.some(p => v === p || v.includes(p));
}
function openSourcePublisher(value) {
  const v = normalize(value);
  return Boolean(v) && OPEN_SOURCE_LEADERS.some(p => v === p || v.includes(p));
}

const EXTRA_MARKET_SEEDS = [
  // Browsers / Internet
  ['Vivaldi.Vivaldi','Vivaldi','Vivaldi','free'],
  ['Opera.Opera','Opera','Opera','free'],
  ['TorProject.TorBrowser','Tor Browser','Tor Project','open-source'],
  ['Mozilla.Thunderbird','Mozilla Thunderbird','Mozilla','open-source'],
  ['iterate.Cyberduck','Cyberduck','iterate','open-source'],
  ['TimKosse.FileZilla.Client','FileZilla Client','Tim Kosse','open-source'],
  ['JDownloader.JDownloader','JDownloader 2','AppWork','free'],
  ['Tailscale.Tailscale','Tailscale','Tailscale','free-tier'],
  ['NordSecurity.NordVPN','NordVPN','Nord Security','subscription'],
  ['MullvadVPN.MullvadVPN','Mullvad VPN','Mullvad','subscription'],
  ['ExpressVPN.ExpressVPN','ExpressVPN','ExpressVPN','subscription'],

  // Productivity / collaboration
  ['Notion.Notion','Notion','Notion','freemium'],
  ['Obsidian.Obsidian','Obsidian','Obsidian','freemium'],
  ['Joplin.Joplin','Joplin','Joplin','open-source'],
  ['Doist.Todoist','Todoist','Doist','freemium'],
  ['Appest.TickTick','TickTick','Appest','freemium'],
  ['Evernote.Evernote','Evernote','Evernote','freemium'],
  ['DigitalScholar.Zotero','Zotero','Digital Scholar','open-source'],
  ['Elsevier.MendeleyReferenceManager','Mendeley Reference Manager','Elsevier','free'],
  ['Figma.Figma','Figma','Figma','freemium'],
  ['Canva.Canva','Canva','Canva','freemium'],
  ['Grammarly.Grammarly','Grammarly','Grammarly','freemium'],
  ['Cisco.Webex','Cisco Webex','Cisco','freemium'],
  ['Loom.Loom','Loom','Loom','freemium'],

  // Creative / media
  ['KDE.Krita','Krita','KDE','open-source'],
  ['dotPDN.PaintDotNet','paint.net','dotPDN','free'],
  ['Cockos.REAPER','REAPER','Cockos','free-trial'],
  ['TechSmith.Snagit','Snagit','TechSmith','free-trial'],
  ['TechSmith.Camtasia','Camtasia','TechSmith','free-trial'],
  ['Plex.Plex','Plex','Plex','freemium'],
  ['XBMCFoundation.Kodi','Kodi','Kodi','open-source'],
  ['TIDALMusicAS.TIDAL','TIDAL','TIDAL','subscription'],
  ['Deezer.Deezer','Deezer','Deezer','freemium'],
  ['AtomixProductions.VirtualDJ','VirtualDJ','Atomix Productions','freemium'],
  ['Adobe.CreativeCloud','Adobe Creative Cloud','Adobe','subscription'],

  // Development / IT
  ['SublimeHQ.SublimeText.4','Sublime Text','Sublime HQ','free-trial'],
  ['JetBrains.IntelliJIDEA.Community','IntelliJ IDEA Community','JetBrains','free'],
  ['JetBrains.PyCharm.Community','PyCharm Community','JetBrains','free'],
  ['Axosoft.GitKraken','GitKraken','GitKraken','freemium'],
  ['dbeaver.dbeaver','DBeaver','DBeaver','freemium'],
  ['HeidiSQL.HeidiSQL','HeidiSQL','HeidiSQL','open-source'],
  ['Oracle.MySQLWorkbench','MySQL Workbench','Oracle','free'],
  ['PostgreSQL.pgAdmin','pgAdmin 4','PostgreSQL','open-source'],
  ['Google.AndroidStudio','Android Studio','Google','free'],
  ['Anaconda.Anaconda3','Anaconda Distribution','Anaconda','free'],
  ['ArduinoSA.IDE.stable','Arduino IDE','Arduino','open-source'],
  ['Unity.UnityHub','Unity Hub','Unity','freemium'],
  ['VMware.WorkstationPro','VMware Workstation Pro','VMware','free'],

  // Utilities / security
  ['AgileBits.1Password','1Password','1Password','subscription'],
  ['Piriform.CCleaner','CCleaner','Piriform','freemium'],
  ['RevoUninstaller.RevoUninstaller','Revo Uninstaller','Revo Uninstaller','freemium'],
  ['REALiX.HWiNFO','HWiNFO','REALiX','free'],
  ['Rem0o.FanControl','Fan Control','Rem0o','free'],
  ['Foxit.FoxitReader','Foxit PDF Reader','Foxit','free'],
  ['TrackerSoftware.PDF-XChangeEditor','PDF-XChange Editor','Tracker Software','freemium'],
  ['Kingsoft.WPSOffice','WPS Office','Kingsoft','freemium'],

  // Games / launchers
  ['GOG.Galaxy','GOG GALAXY','GOG','free'],
  ['Blizzard.BattleNet','Battle.net','Blizzard','free'],
  ['Ubisoft.Connect','Ubisoft Connect','Ubisoft','free'],
  ['ElectronicArts.EADesktop','EA app','Electronic Arts','free'],
  ['Parsec.Parsec','Parsec','Parsec','freemium'],

  // Business / data / education
  ['Microsoft.PowerBI','Microsoft Power BI Desktop','Microsoft','free'],
  ['Tableau.TableauPublic','Tableau Public','Tableau','free'],
  ['Anki.Anki','Anki','Anki','open-source'],
  ['GeoGebra.GeoGebra','GeoGebra','GeoGebra','free'],
  ['QGIS.QGIS','QGIS','QGIS','open-source'],
  ['KiCad.KiCad','KiCad','KiCad','open-source']
];


const CATEGORY_OVERRIDES = new Map([
  ['TeamViewer.TeamViewer','Communication & Collaboration › Screen Sharing'],
  ['AnyDeskSoftwareGmbH.AnyDesk','Communication & Collaboration › Screen Sharing'],
  ['RustDesk.RustDesk','Communication & Collaboration › Screen Sharing'],
  ['Parsec.Parsec','Communication & Collaboration › Screen Sharing'],
  ['Python.Python.3.13','Development & IT › General Developer Tools'],
  ['JetBrains.Toolbox','Development & IT › IDEs'],
  ['Cloudflare.Warp','Security & Privacy › VPN Clients'],
  ['Tailscale.Tailscale','Security & Privacy › VPN Clients'],
  ['NordSecurity.NordVPN','Security & Privacy › VPN Clients'],
  ['ExpressVPN.ExpressVPN','Security & Privacy › VPN Clients'],
  ['KeePassXCTeam.KeePassXC','Security & Privacy › Password Managers'],
  ['NanaZip.NanaZip','System & Utilities › Archive & Compression'],
  ['Apple.iTunes','Media & Entertainment › Audio Players'],
  ['Apple.iCloud','Internet & Browsers › Cloud Storage Clients'],
  ['Microsoft.Teams','Communication & Collaboration › Team Chat'],
  ['Wondershare.Filmora','Media & Entertainment › Video Editing'],
  ['Canva.Canva','Design & Creative › General Creative Tools'],
  ['Grammarly.Grammarly','Productivity & Office › Typing & Writing Tools'],
  ['Loom.Loom','Media & Entertainment › Screen Recording'],
  ['TechSmith.Snagit','Design & Creative › Screenshot Tools'],
  ['TechSmith.Camtasia','Media & Entertainment › Video Editing'],
  ['Adobe.CreativeCloud','Design & Creative › General Creative Tools'],
  ['Axosoft.GitKraken','Development & IT › Version Control'],
  ['Unity.UnityHub','Development & IT › General Developer Tools'],
  ['Piriform.CCleaner','System & Utilities › Cleanup & Optimization'],
  ['Ubisoft.Connect','Media & Entertainment › Game Launchers'],
  ['ElectronicArts.EADesktop','Media & Entertainment › Game Launchers']
]);

const PRICING_OVERRIDES = new Map([
  ['RARLab.WinRAR', PRICING.FREE_TRIAL],
  ['Google.Chrome', PRICING.FREE], ['Mozilla.Firefox', PRICING.OPEN_SOURCE], ['Microsoft.Edge', PRICING.FREE], ['Brave.Brave', PRICING.OPEN_SOURCE],
  ['VideoLAN.VLC', PRICING.OPEN_SOURCE], ['7zip.7zip', PRICING.OPEN_SOURCE], ['Notepad++.Notepad++', PRICING.OPEN_SOURCE],
  ['Microsoft.VisualStudioCode', PRICING.FREE], ['OBSProject.OBSStudio', PRICING.OPEN_SOURCE], ['Discord.Discord', PRICING.FREEMIUM],
  ['Telegram.TelegramDesktop', PRICING.FREE], ['Zoom.Zoom', PRICING.FREEMIUM], ['Spotify.Spotify', PRICING.FREEMIUM],
  ['Valve.Steam', PRICING.FREE], ['EpicGames.EpicGamesLauncher', PRICING.FREE], ['Git.Git', PRICING.OPEN_SOURCE], ['GitHub.GitHubDesktop', PRICING.FREE],
  ['Audacity.Audacity', PRICING.OPEN_SOURCE], ['GIMP.GIMP', PRICING.OPEN_SOURCE], ['BlenderFoundation.Blender', PRICING.OPEN_SOURCE], ['Inkscape.Inkscape', PRICING.OPEN_SOURCE],
  ['HandBrake.HandBrake', PRICING.OPEN_SOURCE], ['qBittorrent.qBittorrent', PRICING.OPEN_SOURCE], ['Bitwarden.Bitwarden', PRICING.FREEMIUM], ['voidtools.Everything', PRICING.FREE],
  ['Oracle.VirtualBox', PRICING.FREE], ['Docker.DockerDesktop', PRICING.FREE_TIER], ['PuTTY.PuTTY', PRICING.OPEN_SOURCE], ['WinSCP.WinSCP', PRICING.OPEN_SOURCE],
  ['TeamViewer.TeamViewer', PRICING.FREE_TIER], ['AnyDeskSoftwareGmbH.AnyDesk', PRICING.FREE_TRIAL], ['RustDesk.RustDesk', PRICING.OPEN_SOURCE],
  ['Adobe.Acrobat.Reader.64-bit', PRICING.FREE], ['LibreOffice.LibreOffice', PRICING.OPEN_SOURCE], ['ONLYOFFICE.DesktopEditors', PRICING.FREE],
  ['Postman.Postman', PRICING.FREEMIUM], ['Insomnia.Insomnia', PRICING.FREEMIUM], ['JetBrains.Toolbox', PRICING.FREE], ['Microsoft.VisualStudio.2022.Community', PRICING.FREE],
  ['Proton.ProtonVPN', PRICING.FREEMIUM], ['Malwarebytes.Malwarebytes', PRICING.FREEMIUM], ['Microsoft.OneDrive', PRICING.FREEMIUM], ['Dropbox.Dropbox', PRICING.FREEMIUM], ['Google.GoogleDrive', PRICING.FREEMIUM],
  ['Microsoft.Teams', PRICING.FREEMIUM], ['SlackTechnologies.Slack', PRICING.FREEMIUM], ['Signal.Signal', PRICING.OPEN_SOURCE], ['WhatsApp.WhatsApp', PRICING.FREE],
  ['Wondershare.Filmora', PRICING.FREE_TRIAL], ['BlackmagicDesign.DaVinciResolve', PRICING.FREEMIUM]
]);

function pricingFlags(pricingModel) {
  const p = pricingModel || PRICING.UNKNOWN;
  return {
    pricingModel: p,
    hasFreeTier: [PRICING.FREE, PRICING.FREEMIUM, PRICING.FREE_TIER, PRICING.OPEN_SOURCE].includes(p),
    hasFreeTrial: p === PRICING.FREE_TRIAL,
    commercialProduct: ![PRICING.OPEN_SOURCE].includes(p) && p !== PRICING.UNKNOWN
  };
}

function extraSeedObjects() {
  return EXTRA_MARKET_SEEDS.map(([packageId,name,publisher,pricingModel], index) => ({
    rank: 200 + index,
    packageId,
    name,
    publisher,
    pricingModel,
    category: CATEGORY_OVERRIDES.get(packageId) || null,
    marketScore: Math.max(72, 90 - Math.floor(index / 12)),
    qualityScore: 82
  }));
}

function marketSeeds() {
  const base = starterPackages().map((item, index) => ({
    ...item,
    category: inferCatalogCategory(item),
    pricingModel: PRICING_OVERRIDES.get(item.packageId) || (openSourcePublisher(item.publisher) ? PRICING.OPEN_SOURCE : commercialPublisher(item.publisher) ? PRICING.FREEMIUM : PRICING.UNKNOWN),
    marketScore: Math.max(78, 98 - Math.floor(index / 7)),
    qualityScore: 88
  }));
  const merged = new Map();
  for (const item of [...base, ...extraSeedObjects()]) merged.set(item.packageId, item);
  return [...merged.values()];
}

const SEED_MAP = new Map(marketSeeds().map(item => [String(item.packageId).toLowerCase(), item]));

function productSeed(item = {}) {
  const id = String(item.packageId || item.package_id || '').toLowerCase();
  return SEED_MAP.get(id) || null;
}

function inferPricing(item = {}, seed = productSeed(item)) {
  if (seed?.pricingModel) return pricingFlags(seed.pricingModel);
  const publisher = item.publisher || String(item.packageId || item.package_id || '').split('.')[0] || '';
  if (openSourcePublisher(publisher)) return pricingFlags(PRICING.OPEN_SOURCE);
  if (commercialPublisher(publisher)) return { ...pricingFlags(PRICING.UNKNOWN), commercialProduct:true };
  return pricingFlags(PRICING.UNKNOWN);
}

function intelligenceFor(item = {}, options = {}) {
  const packageId = String(item.packageId || item.package_id || '');
  const name = String(item.name || packageId.split('.').pop() || packageId);
  const publisher = String(item.publisher || packageId.split('.')[0] || '');
  const seed = productSeed({ packageId });
  const explicitCategory = String(item.category || '').includes(' › ') ? item.category : null;
  const category = explicitCategory || seed?.category || CATEGORY_OVERRIDES.get(packageId) || inferCatalogCategory({ packageId, name, publisher, searchAliases:item.searchAliases || item.search_aliases });
  const hay = normalize([packageId,name,publisher,category,item.searchAliases,item.search_aliases].filter(Boolean).join(' '));
  const pricing = inferPricing({ packageId,name,publisher }, seed);

  if (!hay || HARD_REJECT_PATTERNS.some(re => re.test(hay))) {
    return { status:'rejected', category, marketScore:0, qualityScore:20, relevanceScore:0, ...pricing, sourceConfidence:'rule', reason:'Excluded infrastructure, prerelease, sample, runtime, SDK or component package.' };
  }

  let marketScore = seed?.marketScore ?? 0;
  let qualityScore = seed?.qualityScore ?? 0;
  const reasons = [];

  if (seed) {
    reasons.push('High-confidence market anchor');
  } else {
    marketScore += category ? 18 : 0;
    if (commercialPublisher(publisher)) { marketScore += 34; reasons.push('Established commercial publisher'); }
    else if (openSourcePublisher(publisher)) { marketScore += 24; reasons.push('Established end-user open-source publisher'); }
    if (END_USER_SIGNALS.test(hay)) { marketScore += 16; reasons.push('Strong end-user product signal'); }
    if (/\b(pro|professional|desktop|studio|reader|editor|browser|client|office|vpn|backup|manager|player|launcher)\b/i.test(hay)) marketScore += 8;
    if (/^[a-z0-9][a-z0-9 .+&'()_-]{2,120}$/i.test(name.trim())) marketScore += 4;

    qualityScore = 35;
    if (category) qualityScore += 18;
    if (commercialPublisher(publisher) || openSourcePublisher(publisher)) qualityScore += 24;
    if (END_USER_SIGNALS.test(hay)) qualityScore += 12;
  }

  if (LOW_SIGNAL_PATTERNS.some(re => re.test(hay))) {
    marketScore -= 20;
    qualityScore -= 12;
    reasons.push('Long-tail/developer-component penalty');
  }
  if (/\b(portable|unofficial|fork|legacy|deprecated)\b/i.test(hay)) marketScore -= 15;

  marketScore = Math.max(0, Math.min(100, Math.round(marketScore)));
  qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));
  const relevanceScore = Math.max(0, Math.min(100, Math.round((marketScore * 0.72) + (qualityScore * 0.28))));

  let status = 'rejected';
  if (seed && category) status = 'curated';
  else if (category && marketScore >= 55 && relevanceScore >= 62) status = 'curated';
  else if (category && marketScore >= 35 && relevanceScore >= 42) status = 'candidate';

  if (options.forceCurated && category) status = 'curated';

  return {
    status,
    category,
    canonicalName: seed?.name || name,
    marketScore,
    qualityScore,
    relevanceScore,
    ...pricing,
    sourceConfidence: seed ? 'market-anchor' : commercialPublisher(publisher) || openSourcePublisher(publisher) ? 'publisher-heuristic' : 'heuristic',
    reason: reasons.join('; ') || (status === 'rejected' ? 'Insufficient independent market relevance evidence.' : 'End-user product signals met the Catalog Intelligence threshold.')
  };
}

function demandRankFromIntelligence(info, fallbackRank = 999999) {
  if (!info || info.status !== 'curated') return null;
  // Lower ranks sort first. Exact market anchors get deterministic leading ranks;
  // heuristic products follow based on relevance without pretending this is a
  // real-world download-count ranking.
  const rankBase = info.sourceConfidence === 'market-anchor' ? 1000 : 100000;
  return rankBase + ((100 - Number(info.relevanceScore || 0)) * 1000) + (Number(fallbackRank || 0) % 1000);
}

module.exports = {
  PRICING,
  marketSeeds,
  productSeed,
  intelligenceFor,
  demandRankFromIntelligence,
  commercialPublisher,
  openSourcePublisher
};
