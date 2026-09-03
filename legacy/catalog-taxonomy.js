'use strict';

// HSWare v11.4 market-ready catalog taxonomy.
// Ten parent groups × twenty subcategories = exactly 200 selectable categories.
// Categories are intentionally end-user oriented. Packages that cannot be placed
// with reasonable confidence are not surfaced in Discover, but remain available
// through exact/manual WinGet import.

const GROUPS = [
  ['Internet & Browsers', [
    ['Web Browsers',['browser','chrome','chromium','firefox','edge','brave','vivaldi','opera','waterfox','librewolf']],
    ['Download Managers',['download manager','downloader','idm','jdownloader','aria2','wget','curl']],
    ['FTP & SFTP Clients',['ftp','sftp','winscp','filezilla','cyberduck']],
    ['Torrent Clients',['torrent','bittorrent','qbittorrent','transmission','deluge']],
    ['Email Clients',['email client','mail client','thunderbird','outlook','mailspring']],
    ['RSS & Feed Readers',['rss','feed reader','feedreader','fluent reader']],
    ['Cloud Storage Clients',['cloud storage','onedrive','dropbox','google drive','nextcloud','owncloud','syncthing']],
    ['Network Utilities',['network tool','network utility','nettool','ip scanner','ping','traceroute','whois']],
    ['DNS Tools',['dns','dnscrypt','nextdns','adguard home']],
    ['Proxy Clients',['proxy','proxifier','shadowsocks','clash','v2ray']],
    ['Web Servers',['web server','nginx','apache http','caddy','iis']],
    ['API Clients',['api client','postman','insomnia','hoppscotch','bruno']],
    ['SSH Clients',['ssh','putty','termius','mobaxterm']],
    ['Remote File Access',['remote file','webdav','rclone','mount cloud']],
    ['Website Tools',['website','webmaster','site audit','seo tool']],
    ['URL & Link Tools',['url','link checker','bookmark manager','shortener']],
    ['Internet Privacy Tools',['tor browser','i2p','privacy browser','anonymous browser']],
    ['Network Monitoring',['network monitor','packet capture','wireshark','tcpview']],
    ['Bandwidth & Speed Tools',['speedtest','bandwidth','iperf','internet speed']],
    ['General Internet Tools',['internet tool','online client','web client']]
  ]],
  ['Communication & Collaboration', [
    ['Team Chat',['team chat','chat client','discord','slack','mattermost','zulip']],
    ['Messaging',['messaging','messenger','telegram','signal','whatsapp','wechat']],
    ['Video Conferencing',['video conference','meeting','zoom','webex','teams meeting','jitsi']],
    ['Voice & VoIP',['voip','voice call','softphone','sip','teamspeak','mumble']],
    ['Remote Collaboration',['collaboration','whiteboard','miro','mural']],
    ['Project Communication',['project communication','basecamp','clickup','asana','monday']],
    ['Community Clients',['community client','matrix client','element']],
    ['IRC Clients',['irc','hexchat','weechat']],
    ['Social Media Clients',['social media','mastodon','tweetdeck','social client']],
    ['Screen Sharing',['screen sharing','screen share']],
    ['Webinar Tools',['webinar','livestorm','gotowebinar']],
    ['Contact Management',['contact manager','address book']],
    ['Calendar Collaboration',['shared calendar','calendar client']],
    ['Team Knowledge',['knowledge base','wiki client','notion']],
    ['Online Classroom',['classroom','virtual classroom']],
    ['Customer Communication',['customer chat','support desk','helpdesk client']],
    ['Forum Clients',['forum client','discourse client']],
    ['Push & Notification Clients',['push notification','notification client']],
    ['Presence & Status Tools',['presence','status tool']],
    ['General Communication',['communication','collaboration tool']]
  ]],
  ['Productivity & Office', [
    ['Office Suites',['office suite','libreoffice','openoffice','onlyoffice','wps office']],
    ['Word Processing',['word processor','document editor','writer']],
    ['Spreadsheets',['spreadsheet','excel','calc']],
    ['Presentations',['presentation','powerpoint','slides']],
    ['PDF Tools',['pdf','acrobat','sumatrapdf','pdf reader','pdf editor']],
    ['Notes & Knowledge',['notes','note taking','obsidian','joplin','evernote','onenote']],
    ['Task Management',['task manager','todo','to-do','ticktick','todoist']],
    ['Time Management',['time tracking','pomodoro','timer','productivity timer']],
    ['Calendar & Scheduling',['calendar','scheduler','scheduling']],
    ['Clipboard Tools',['clipboard','copyq','ditto']],
    ['Text Expansion',['text expander','autotext','phraseexpress']],
    ['OCR & Scanning',['ocr','scanner','scanning','naps2']],
    ['Document Conversion',['document converter','converter office']],
    ['Mind Mapping',['mind map','mindmapping','xmind','freemind']],
    ['Diagramming',['diagram','flowchart','draw.io','yed']],
    ['Reference Managers',['reference manager','citation','zotero','mendeley']],
    ['Desktop Publishing',['desktop publishing','scribus']],
    ['Ebook Readers',['ebook','epub reader','calibre']],
    ['Typing & Writing Tools',['typing','writing assistant','grammar']],
    ['General Productivity',['productivity','organizer','workspace']]
  ]],
  ['Development & IT', [
    ['Code Editors',['code editor','vscode','visual studio code','notepad++','sublime text','atom editor']],
    ['IDEs',[' ide ','integrated development','visual studio','intellij','pycharm','webstorm','rider','eclipse','netbeans']],
    ['Version Control',['git','github desktop','gitlab','mercurial','svn','subversion']],
    ['Terminals & Shells',['terminal','shell','powershell','windows terminal','wezterm','alacritty','kitty']],
    ['Database Clients',['database client','sql client','dbeaver','heidisql','datagrip','mysql workbench','pgadmin']],
    ['API Development',['api development','postman','insomnia','bruno']],
    ['Containers',['docker','podman','container desktop','rancher desktop']],
    ['Virtualization',['virtualbox','vmware','hyper-v','virtual machine','qemu']],
    ['Cloud & DevOps',['devops','kubernetes','kubectl','terraform','ansible','helm','azure cli','aws cli','gcloud']],
    ['Web Development',['web development','webdev','node.js','deno','bun']],
    ['Mobile Development',['android studio','mobile development','flutter','react native']],
    ['Data Engineering',['data engineering','etl','airflow','dbt']],
    ['Data Science',['data science','jupyter','anaconda','miniconda','rstudio']],
    ['Debugging & Profiling',['debugger','profiler','debugging','process explorer']],
    ['Package Managers',['package manager','chocolatey','scoop','wingetui','npm client']],
    ['Build Tools',['build tool','cmake','ninja','make','gradle','maven']],
    ['Developer Documentation',['documentation generator','docs tool','doxygen']],
    ['Serial & Embedded Tools',['serial monitor','embedded','arduino ide','platformio']],
    ['IT Administration',['sysadmin','administration','active directory','server manager']],
    ['General Developer Tools',['developer tool','development tool','programming tool']]
  ]],
  ['Media & Entertainment', [
    ['Video Players',['video player','vlc','mpv','potplayer','mpc-hc']],
    ['Audio Players',['audio player','music player','foobar2000','musicbee','aimp']],
    ['Streaming Clients',['streaming','spotify','tidal','deezer','netflix client']],
    ['Media Centers',['media center','kodi','plex','jellyfin client']],
    ['Screen Recording',['screen recorder','obs studio','record screen']],
    ['Audio Recording',['audio recorder','voice recorder','audacity']],
    ['Video Editing',['video editor','davinci resolve','shotcut','kdenlive','openshot']],
    ['Audio Editing',['audio editor','wave editor','audacity']],
    ['Media Conversion',['media converter','handbrake','ffmpeg frontend']],
    ['Codecs & Playback',['codec','lav filters','codec pack']],
    ['Podcast Tools',['podcast','podcast client']],
    ['Radio Clients',['internet radio','radio client']],
    ['Music Production',['music production','daw','lmms','reaper','studio one']],
    ['DJ Software',['dj software','mixxx','virtualdj']],
    ['Subtitle Tools',['subtitle','aegisub','subtitle edit']],
    ['Disc & Optical Media',['dvd','blu-ray','disc burning','imgburn']],
    ['Media Tagging',['media tag','music tag','mp3tag']],
    ['Game Launchers',['steam','epic games launcher','gog galaxy','battle.net','itch']],
    ['Game Utilities',['game utility','gaming tool','mod manager','vortex']],
    ['General Media Tools',['media tool','multimedia']]
  ]],
  ['Design & Creative', [
    ['Image Editors',['image editor','photo editor','gimp','paint.net','krita','photoshop']],
    ['Vector Graphics',['vector graphics','inkscape','illustrator']],
    ['3D Modeling',['3d modeling','blender','3d model','maya','3ds max']],
    ['CAD',[' cad ','autocad','freecad','librecad','solidworks']],
    ['UI & UX Design',['ui design','ux design','figma','penpot']],
    ['Digital Painting',['digital painting','painting','krita']],
    ['Photo Management',['photo manager','photo organizer','digikam','darktable']],
    ['RAW Photography',['raw photo','rawtherapee','darktable']],
    ['Screenshot Tools',['screenshot','sharex','greenshot','flameshot','snipping']],
    ['Color Tools',['color picker','palette','colour picker']],
    ['Font Tools',['font manager','font viewer','typeface']],
    ['Icon Tools',['icon editor','ico editor','icon tool']],
    ['Animation',['animation','2d animation','3d animation','synfig']],
    ['Motion Graphics',['motion graphics','after effects']],
    ['Desktop Capture',['screen capture','capture tool']],
    ['Layout & Publishing',['layout design','publishing','scribus']],
    ['Laser & CNC Design',['laser design','cnc design','lightburn']],
    ['3D Printing',['3d printing','slicer','cura','prusaslicer','orcaslicer']],
    ['Creative Asset Management',['asset manager','creative assets']],
    ['General Creative Tools',['creative tool','design tool','graphics tool']]
  ]],
  ['System & Utilities', [
    ['File Managers',['file manager','explorer','total commander','double commander','files app']],
    ['Archive & Compression',['archive','compression','7-zip','7zip','winrar','peazip']],
    ['Search Utilities',['desktop search','everything search','voidtools everything','file search']],
    ['System Information',['system information','cpu-z','gpu-z','hwinfo','speccy']],
    ['Hardware Monitoring',['hardware monitor','temperature monitor','fan control','open hardware monitor']],
    ['Disk Management',['disk management','partition','gparted','diskgenius']],
    ['Disk Health',['disk health','crystaldiskinfo','smart monitor']],
    ['Benchmarking',['benchmark','crystaldiskmark','cinebench','geekbench']],
    ['Backup & Restore',['backup','restore','macrium','veeam agent','duplicati']],
    ['File Synchronization',['file sync','synchronization','freefilesync','syncthing']],
    ['Uninstallers',['uninstaller','bulk crap uninstaller','revo uninstaller']],
    ['Cleanup & Optimization',['cleanup','cleaner','bleachbit','optimizer']],
    ['Startup Management',['startup manager','autoruns','startup utility']],
    ['Window Management',['window manager','powertoys','fancyzones','window utility']],
    ['Keyboard & Mouse Tools',['keyboard tool','mouse tool','autohotkey','key remap','powertoys']],
    ['Desktop Customization',['desktop customization','wallpaper','rainmeter','theme tool']],
    ['Power & Battery Tools',['battery','power plan','power management']],
    ['Driver Utilities',['driver updater','driver utility']],
    ['Recovery & Rescue',['recovery tool','rescue','boot repair']],
    ['General Utilities',['utility','utilities','system tool','desktop tool']]
  ]],
  ['Security & Privacy', [
    ['Password Managers',['password manager','bitwarden','keepass','1password']],
    ['Antivirus & Anti-Malware',['antivirus','anti-malware','malwarebytes','security scanner']],
    ['VPN Clients',['vpn','openvpn','wireguard','mullvad','protonvpn']],
    ['Encryption',['encryption','veracrypt','cryptomator','gpg']],
    ['Authentication',['authenticator','2fa','two factor','yubikey']],
    ['Firewall Tools',['firewall','simplewall','portmaster']],
    ['Privacy Tools',['privacy tool','privacy','o&o shutup','privatezilla']],
    ['Secure Messaging',['secure messaging','signal']],
    ['Network Security',['network security','nmap','wireshark','security audit']],
    ['Vulnerability Tools',['vulnerability','scanner security','nessus','openvas']],
    ['Certificate Tools',['certificate','ssl tool','tls tool']],
    ['File Integrity',['file integrity','checksum','hash tool']],
    ['Secure Erase',['secure erase','file shredder','wipe']],
    ['Sandboxing',['sandbox','sandboxie','application isolation']],
    ['DNS Privacy',['dns privacy','dnscrypt','nextdns']],
    ['Anti-Tracking',['anti tracking','tracker blocker']],
    ['Privacy Browsers',['privacy browser','tor browser','librewolf']],
    ['Secrets Management',['secrets manager','vault client']],
    ['Security Administration',['security administration','security console']],
    ['General Security Tools',['security tool','cybersecurity','privacy utility']]
  ]],
  ['Business & Finance', [
    ['Accounting',['accounting','bookkeeping','gnucash','quickbooks']],
    ['Personal Finance',['personal finance','budget','money manager']],
    ['Trading & Markets',['trading','stock market','broker client']],
    ['Cryptocurrency Wallets',['crypto wallet','cryptocurrency wallet','bitcoin wallet']],
    ['Invoicing',['invoice','invoicing','billing']],
    ['CRM',[' crm ','customer relationship']],
    ['ERP',[' erp ','enterprise resource planning']],
    ['Point of Sale',['point of sale',' pos ']],
    ['Inventory',['inventory','stock management']],
    ['Business Intelligence',['business intelligence','power bi','tableau']],
    ['Data Visualization',['data visualization','visual analytics']],
    ['Remote Work',['remote work','work from home']],
    ['HR & Workforce',['human resources','hr tool','workforce']],
    ['Payroll',['payroll']],
    ['Expense Management',['expense','expenses']],
    ['Legal & Compliance',['legal tool','compliance']],
    ['E-Signature',['electronic signature','e-signature','docusign']],
    ['Customer Support',['helpdesk','customer support','ticketing']],
    ['Business Planning',['business plan','planning tool']],
    ['General Business Tools',['business tool','enterprise client']]
  ]],
  ['Education & Science', [
    ['Learning Platforms',['learning platform','education','learning app']],
    ['Language Learning',['language learning','duolingo','anki']],
    ['Flashcards & Study',['flashcard','study tool','anki']],
    ['Mathematics',['mathematics','math tool','geogebra']],
    ['Statistics',['statistics','statistical','spss','jamovi']],
    ['Scientific Computing',['scientific computing','matlab','octave','scilab']],
    ['Chemistry',['chemistry','chemical','chemdraw']],
    ['Biology',['biology','bioinformatics']],
    ['Astronomy',['astronomy','stellarium']],
    ['GIS & Mapping',['gis','mapping','qgis','arcgis']],
    ['Electronics',['electronics','circuit','kicad','ltspice']],
    ['Robotics',['robotics','robot simulator']],
    ['Simulation',['simulation','simulator']],
    ['Research Tools',['research tool','research manager']],
    ['Academic Writing',['academic writing','latex','texstudio','texmaker']],
    ['Reference & Dictionaries',['dictionary','reference tool','encyclopedia']],
    ['Exam & Classroom Tools',['exam tool','classroom tool']],
    ['Accessibility & Assistive Tech',['accessibility','assistive','screen reader','nvda']],
    ['Geography & Earth Science',['geography','earth science','geology']],
    ['General Education Tools',['education tool','learning tool','science tool']]
  ]]
];

const CATEGORY_ENTRIES = GROUPS.flatMap(([group, children]) => children.map(([name, keywords]) => ({
  group,
  name,
  fullName: `${group} › ${name}`,
  keywords
})));

if (CATEGORY_ENTRIES.length !== 200) throw new Error(`HSWare taxonomy must contain exactly 200 categories; found ${CATEGORY_ENTRIES.length}.`);

const CATEGORY_NAME_SET = new Set(CATEGORY_ENTRIES.map(entry => entry.fullName));

const TRUSTED_PUBLISHERS = [
  'microsoft','google','mozilla','videolan','7zip','rarlab','notepad++','github','git','docker','jetbrains','oracle','vmware','canonical',
  'obsproject','discord','telegram','zoom','spotify','valve','epicgames','audacity','gimp','blenderfoundation','inkscape','handbrake','bitwarden',
  'voidtools','cpuid','techpowerup','crystaldewworld','rustdesk','teamviewer','anydesk','adobe','cisco','apple','proton','mullvad','tailscale',
  'cloudflare','openvpn','wireguard','qgis','kicad','calibre','obsidian','joplin','zotero','libreoffice','onlyoffice','plex','jellyfin','kodi'
];

const NOISE_PATTERNS = [
  /(?:^|[\s._-])(runtime|redistributable|redist|sdk|devkit|framework|headers?|symbols?|language[\s._-]*pack|langpack|driver[\s._-]*pack|plugin|extension|addon|module|libraries?|samples?|tests?|testdata|debug|benchmark[\s._-]*suite)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(nightly|alpha|beta|preview|canary|snapshot|insiders?|experimental|devbuild|unstable)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(server[\s._-]*core|headless|daemon|service[\s._-]*only|toolchain|compiler[\s._-]*runtime)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(sample|example|demo|template|skeleton|starter[\s._-]*kit)(?:$|[\s._-])/i
];

const APP_SIGNALS = /\b(desktop|client|studio|editor|viewer|player|manager|browser|terminal|console|utility|tool|suite|launcher|recorder|converter|monitor|reader|designer|ide|vpn|chat|meeting|office|backup|sync|remote|capture|wallet|calendar|notes?|database|search|scanner|benchmark|browser|music|video|photo|graphics|security|password|file|download)\b/i;

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[_+.\-/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferCatalogCategory(item = {}) {
  const raw = [item.packageId, item.package_id, item.name, item.publisher, item.searchAliases, item.search_aliases]
    .filter(Boolean).join(' ');
  const hay = ` ${normalize(raw)} `;
  if (!hay.trim()) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of CATEGORY_ENTRIES) {
    let score = 0;
    for (const keyword of entry.keywords) {
      const term = normalize(keyword);
      if (!term) continue;
      if (hay.includes(` ${term} `)) score += term.length >= 10 ? 9 : term.length >= 6 ? 7 : 5;
      else if (term.length >= 5 && hay.includes(term)) score += 3;
    }
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= 5 ? best.fullName : null;
}

function fallbackCatalogCategory(item = {}) {
  const raw = [item.packageId, item.package_id, item.name, item.publisher, item.searchAliases, item.search_aliases]
    .filter(Boolean).join(' ');
  const hay = ` ${normalize(raw)} `;

  // These broad fallbacks are all real members of the 200-category taxonomy.
  // Specific keyword matches are handled first by inferCatalogCategory().
  if (/\b(driver|firmware|device driver)\b/i.test(hay)) return 'System & Utilities › Driver Utilities';
  if (/\b(font|typeface|ttf|otf)\b/i.test(hay)) return 'Design & Creative › Font Tools';
  if (/\b(accessibility|assistive|screen reader|speech to text)\b/i.test(hay)) return 'Education & Science › Accessibility & Assistive Tech';
  if (/\b(runtime|sdk|devkit|toolchain|compiler|framework|library|module|package manager|build tool|cmake|ninja|gradle|maven)\b/i.test(hay)) return 'Development & IT › General Developer Tools';
  if (/\b(server|daemon|service|sysadmin|administration|active directory)\b/i.test(hay)) return 'Development & IT › IT Administration';
  if (/\b(browser|internet|download|cloud|ftp|sftp|mail|email|torrent|web|url|dns|proxy|ssh|network)\b/i.test(hay)) return 'Internet & Browsers › General Internet Tools';
  if (/\b(chat|meeting|messenger|remote|team|collaboration|screen share|voip|community|forum)\b/i.test(hay)) return 'Communication & Collaboration › General Communication';
  if (/\b(office|notes|calendar|task|project|pdf|document|writing|productivity|clipboard|ocr|ebook)\b/i.test(hay)) return 'Productivity & Office › General Productivity';
  if (/\b(code|developer|development|git|database|sql|ide|terminal|api|docker|kubernetes|programming|debug|devops)\b/i.test(hay)) return 'Development & IT › General Developer Tools';
  if (/\b(audio|music|video|media|player|codec|stream|game|launcher|podcast|subtitle|recording)\b/i.test(hay)) return 'Media & Entertainment › General Media Tools';
  if (/\b(image|photo|design|graphics|3d|cad|font|icon|creative|paint|animation|screenshot)\b/i.test(hay)) return 'Design & Creative › General Creative Tools';
  if (/\b(password|vpn|security|privacy|firewall|encrypt|antivirus|malware|auth|certificate|sandbox)\b/i.test(hay)) return 'Security & Privacy › General Security Tools';
  if (/\b(accounting|finance|business|crm|erp|invoice|inventory|trading|payroll|expense|support|pos)\b/i.test(hay)) return 'Business & Finance › General Business Tools';
  if (/\b(education|learning|science|math|research|gis|chem|biology|astronomy|school|study|statistics|simulation)\b/i.test(hay)) return 'Education & Science › General Education Tools';

  // WinGet PackageIdentifier values are software identities. Unknown identities
  // are retained rather than hidden, using the neutral utilities bucket.
  return 'System & Utilities › General Utilities';
}

function resolveCatalogCategory(item = {}) {
  const current = String(item.category || '').trim();
  if (CATEGORY_NAME_SET.has(current)) return current;
  const inferred = inferCatalogCategory(item);
  if (inferred && CATEGORY_NAME_SET.has(inferred)) return inferred;
  return fallbackCatalogCategory(item);
}

function curationScore(item = {}, options = {}) {
  if (options.curated) return 100;
  const raw = [item.packageId, item.package_id, item.name, item.publisher, item.category].filter(Boolean).join(' ');
  const hay = normalize(raw);
  if (!hay) return 0;
  if (NOISE_PATTERNS.some(re => re.test(hay))) return 0;

  const category = item.category || inferCatalogCategory(item);
  let score = category ? 42 : 0;
  const publisher = normalize(item.publisher || String(item.packageId || item.package_id || '').split('.')[0]);
  if (publisher && TRUSTED_PUBLISHERS.some(p => publisher === p || publisher.includes(p))) score += 24;
  if (APP_SIGNALS.test(hay)) score += 16;
  if (/^[a-z0-9][a-z0-9 .+_-]{2,100}$/i.test(String(item.name || '').trim())) score += 6;
  if (/\.(desktop|client|studio|editor|browser|player|manager|viewer|launcher|terminal|tool)$/i.test(String(item.packageId || item.package_id || ''))) score += 8;
  if (/\b(portable|unofficial|fork|legacy|old version|deprecated)\b/i.test(hay)) score -= 15;
  return Math.max(0, Math.min(100, score));
}

function qualifiesForDiscover(item = {}, options = {}) {
  const category = item.category || inferCatalogCategory(item);
  const score = curationScore({ ...item, category }, options);
  return { ok: Boolean(category) && score >= 45, category, score };
}

function taxonomy() {
  return GROUPS.map(([group, children]) => ({
    group,
    categories: children.map(([name]) => `${group} › ${name}`)
  }));
}

module.exports = {
  GROUPS,
  CATEGORY_ENTRIES,
  inferCatalogCategory,
  fallbackCatalogCategory,
  resolveCatalogCategory,
  curationScore,
  qualifiesForDiscover,
  taxonomy
};
