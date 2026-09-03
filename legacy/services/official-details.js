const cheerio = require('cheerio');
const { safeFetchText } = require('./remote');
const { hostnameOf } = require('../utils/text');

function normalizeIdentity(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitIdentityWords(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}
function stopWords() {
  return new Set(['app','application','software','desktop','windows','win','official','download','free','client','tool','tools','manager','setup','installer','edition','home','pro','lite','beta','bit','build','release']);
}
function tokensFrom(value) {
  const stop = stopWords();
  return normalizeIdentity(splitIdentityWords(value)).split(/\s+/).filter(t => t.length >= 3 && !stop.has(t));
}
function productTokens(software) {
  const parts = String(software.package_id || '').split('.').slice(1);
  return [...new Set(parts.flatMap(tokensFrom))].slice(0, 8);
}
function identityEvidence(text, software) {
  const hay = normalizeIdentity(splitIdentityWords(text));
  const name = normalizeIdentity(splitIdentityWords(software.name));
  const packageProduct = normalizeIdentity(splitIdentityWords(String(software.package_id || '').split('.').slice(1).join(' ')));
  const phrases = [name, packageProduct].filter(v => v.length >= 4);
  const core = productTokens(software);
  const coreHits = core.filter(t => hay.includes(t));
  return phrases.some(v => hay.includes(v)) || (core.length === 1 ? coreHits.length === 1 : core.length > 1 && coreHits.length === core.length);
}
function absoluteUrl(value, base) {
  try {
    const u = new URL(value, base);
    return ['http:','https:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
}
function pageIdentityContext($, pageUrl) {
  return [
    $('title').first().text(),
    $('h1,h2').slice(0, 4).map((_, el) => $(el).text()).get().join(' '),
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="twitter:title"]').attr('content'),
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('link[rel="canonical"]').attr('href'),
    pageUrl
  ].filter(Boolean).join(' ');
}
function sameProductArea(link, productPage, software) {
  try {
    const a = new URL(link), root = new URL(productPage);
    if (a.hostname.toLowerCase() !== root.hostname.toLowerCase()) return false;
    const rootPath = root.pathname.replace(/\/+$/, '') || '/';
    const path = a.pathname.replace(/\/+$/, '') || '/';
    if (path === rootPath) return true;
    if (rootPath !== '/' && path.startsWith(`${rootPath}/`)) return true;
    return identityEvidence(`${path} ${a.search}`, software);
  } catch { return false; }
}
function hostKey(value) {
  const host = String(value || '').toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}
function sameHost(link, productPage) {
  try { return hostKey(new URL(link).hostname) === hostKey(new URL(productPage).hostname); }
  catch { return false; }
}
function cleanText(value, max = 1800) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function descriptionsFromPage($) {
  const values = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content')
  ];
  for (const node of structuredNodes($)) if (node.description) values.push(node.description);
  return [...new Set(values.map(v => cleanText(v)).filter(v => v.length >= 60))];
}
function structuredNodes($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        nodes.push(node);
        for (const v of Object.values(node)) {
          if (Array.isArray(v)) stack.push(...v);
          else if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch {}
  });
  return nodes;
}
function cleanRequirementValue(value, max = 800) {
  const v = String(value || '').replace(/\s+/g, ' ').replace(/^[:\-–—\s]+/, '').trim();
  return v && v.length >= 2 ? v.slice(0, max) : null;
}
function addEntry(entries, label, value) {
  const l = cleanRequirementValue(label, 120);
  const v = cleanRequirementValue(value, 1000);
  if (l && v && l.toLowerCase() !== v.toLowerCase()) entries.push([l, v]);
}
function requirementEntries($) {
  const entries = [];
  $('tr').each((_, el) => {
    const cells = $(el).find('th,td').map((__, c) => cleanRequirementValue($(c).text(), 1000)).get().filter(Boolean);
    if (cells.length >= 2) addEntry(entries, cells[0], cells.slice(1).join(' '));
  });
  $('dt').each((_, el) => addEntry(entries, $(el).text(), $(el).next('dd').text()));
  $('li,p').each((_, el) => {
    const text = cleanRequirementValue($(el).text(), 1200);
    if (!text) return;
    const m = text.match(/^([^:–—]{2,60})\s*[:–—]\s*(.{2,1000})$/);
    if (m) addEntry(entries, m[1], m[2]);
    const strong = $(el).find('strong,b').first();
    if (strong.length) {
      const label = cleanRequirementValue(strong.text(), 100);
      const whole = cleanRequirementValue($(el).text(), 1200);
      if (label && whole && whole.length > label.length) addEntry(entries, label, whole.slice(whole.indexOf(label) + label.length));
    }
  });
  return entries;
}
function requirementSectionText($) {
  const sections = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const heading = cleanRequirementValue($(el).text(), 160) || '';
    if (!/(system\s+requirements?|minimum\s+requirements?|hardware\s+requirements?|technical\s+requirements?|requirements?|specifications?|system\s+specs?)/i.test(heading)) return;
    const chunks = [heading];
    let next = $(el).next();
    let count = 0;
    while (next.length && count < 14 && !/^H[1-6]$/i.test(next[0]?.tagName || '')) {
      const text = cleanRequirementValue(next.text(), 1600);
      if (text) chunks.push(text);
      next = next.next();
      count++;
    }
    const combined = cleanRequirementValue(chunks.join(' | '), 7000);
    if (combined) sections.push(combined);
  });
  return sections;
}
function firstMatch(texts, regexes, max = 500) {
  for (const text of texts) {
    for (const re of regexes) {
      const m = String(text || '').match(re);
      if (m?.[1]) return cleanRequirementValue(m[1], max);
    }
  }
  return null;
}
function parseRequirementBlob(text) {
  const source = cleanRequirementValue(text, 7000);
  if (!source) return {};
  const boundaries = '(?=$|[|•;]|(?:\\s{2,})|(?:operating\\s+system|os(?:\\s+version)?|processor|cpu|ram|memory|storage|disk\\s+space|hard\\s+drive|graphics|gpu|video\\s+card|language(?:s)?)\\s*[:–—-])';
  const capture = label => new RegExp(`(?:^|[|•;])\\s*(?:${label})\\s*(?:minimum|required|requirement(?:s)?)?\\s*[:–—-]?\\s*(.{2,500}?)${boundaries}`, 'i');
  const out = {
    minimumOsVersion: firstMatch([source], [capture('operating\\s+system|minimum\\s+os|os(?:\\s+version)?')]),
    processor: firstMatch([source], [capture('processor|cpu')]),
    ram: firstMatch([source], [capture('ram|system\\s+memory|memory')]),
    storage: firstMatch([source], [capture('storage|disk\\s+space|available\\s+space|hard\\s+disk|hard\\s+drive')]),
    graphics: firstMatch([source], [capture('graphics(?:\\s+card)?|gpu|video\\s+card|display')]),
    language: firstMatch([source], [capture('language(?:s)?|supported\\s+languages?')], 300)
  };
  if (!out.ram) out.ram = firstMatch([source], [/\b((?:\d+(?:\.\d+)?)\s*(?:GB|MB)\s*(?:of\s+)?(?:RAM|memory))\b/i]);
  if (!out.storage) out.storage = firstMatch([source], [/\b((?:\d+(?:\.\d+)?)\s*(?:GB|MB|TB)\s*(?:of\s+)?(?:available\s+)?(?:disk\s+space|storage|hard\s+(?:disk|drive)\s+space))\b/i]);
  return out;
}
function structuredRequirements($) {
  const out = {};
  const acceptedTypes = new Set(['softwareapplication','desktopapplication','webapplication','mobileapplication','application','product']);
  for (const node of structuredNodes($)) {
    const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).filter(Boolean).map(v => String(v).toLowerCase());
    if (types.length && !types.some(t => acceptedTypes.has(t))) continue;
    const candidates = {
      minimumOsVersion: node.operatingSystem || null,
      processor: node.processorRequirements || node.processor || null,
      ram: node.memoryRequirements || node.memory || null,
      storage: node.storageRequirements || node.storage || null,
      graphics: node.graphicsRequirements || node.graphics || null,
      language: node.inLanguage || node.availableLanguage || null
    };
    for (const [key, raw] of Object.entries(candidates)) {
      if (out[key] || raw == null) continue;
      const value = Array.isArray(raw) ? raw.map(v => typeof v === 'string' ? v : v?.name).filter(Boolean).join(', ') : (typeof raw === 'object' ? raw.name || raw.value || null : raw);
      if (value) out[key] = cleanRequirementValue(value, 800);
    }
    for (const raw of [node.systemRequirements, node.softwareRequirements]) {
      const parsed = parseRequirementBlob(typeof raw === 'object' ? JSON.stringify(raw) : raw);
      for (const [key, value] of Object.entries(parsed)) if (!out[key] && value) out[key] = value;
    }
  }
  return out;
}
function requirementsFromPage($, pageUrl) {
  const entries = requirementEntries($);
  const pick = patterns => {
    for (const [label, value] of entries) {
      const key = normalizeIdentity(label);
      if (patterns.some(re => re.test(key))) return cleanRequirementValue(value);
    }
    return null;
  };
  const structured = structuredRequirements($);
  const sectionParsed = requirementSectionText($).map(parseRequirementBlob);
  const fromSections = key => sectionParsed.find(x => x[key])?.[key] || null;
  const minimumOsVersion = pick([/^(operating system|os|os version|minimum os|minimum operating system)$/, /minimum windows/, /windows version/]) || structured.minimumOsVersion || fromSections('minimumOsVersion');
  const processor = pick([/^(processor|cpu)$/, /minimum processor/, /processor cpu/, /cpu requirement/]) || structured.processor || fromSections('processor');
  const ram = pick([/^(ram|memory)$/, /system memory/, /minimum ram/, /minimum memory/, /memory requirement/]) || structured.ram || fromSections('ram');
  const storage = pick([/^(storage|disk space|hard disk|hard drive|available space)$/, /minimum storage/, /disk requirement/, /storage requirement/]) || structured.storage || fromSections('storage');
  const graphics = pick([/^(graphics|gpu|graphics card|video card|video memory|display)$/, /minimum graphics/, /graphics processor/, /gpu requirement/]) || structured.graphics || fromSections('graphics');
  const language = pick([/^(language|languages|supported languages)$/, /interface language/, /available languages/]) || structured.language || fromSections('language');
  const found = [minimumOsVersion, processor, ram, storage, graphics, language].filter(Boolean).length;
  return found ? { minimumOsVersion, processor, ram, storage, graphics, language, sourceUrl: pageUrl, found } : null;
}
function requirementLinks($, pageUrl, productPage, software) {
  const out = [];
  $('a[href]').each((_, el) => {
    const text = `${$(el).text()} ${$(el).attr('title') || ''} ${$(el).attr('href') || ''}`.toLowerCase();
    if (!/system[-_ ]?requirements?|minimum[-_ ]?requirements?|hardware[-_ ]?requirements?|technical[-_ ]?requirements?|specifications?|system[-_ ]?specs?/.test(text)) return;
    const url = absoluteUrl($(el).attr('href'), pageUrl);
    // Requirement/support pages are often outside the product URL path. We may
    // follow them on the same host, but the destination still has to pass the
    // exact software-identity check before any metadata is accepted.
    if (url && sameHost(url, productPage)) out.push(url);
  });
  return [...new Set(out)];
}
function betterDescription(current, candidate) {
  const a = cleanText(current);
  const b = cleanText(candidate);
  if (!b) return a || null;
  if (!a) return b;
  return b.length >= Math.max(180, a.length + 80) ? b : a;
}

async function fetchOfficialDetails(software) {
  // media_source_url is a legacy database column name; in v3.6.7 it stores only
  // the exact WinGet PackageUrl used for verified text/specification enrichment.
  const productPage = software.media_source_url || software.official_url || null;
  if (!productPage) return null;
  const rootHost = hostKey(hostnameOf(productPage));
  const queue = [productPage];
  const visited = new Set();
  const descriptions = [];
  const requirements = [];
  let pagesScanned = 0;

  while (queue.length && pagesScanned < 5) {
    const requested = queue.shift();
    if (!requested || visited.has(requested) || hostKey(hostnameOf(requested)) !== rootHost) continue;
    visited.add(requested);
    let result;
    try { result = await safeFetchText(requested); }
    catch { pagesScanned++; continue; }
    pagesScanned++;
    const $ = cheerio.load(result.text);
    const context = pageIdentityContext($, result.url);
    if (!sameHost(result.url, productPage) || !identityEvidence(context, software)) continue;
    descriptions.push(...descriptionsFromPage($));
    const req = requirementsFromPage($, result.url);
    if (req) requirements.push(req);
    for (const link of requirementLinks($, result.url, productPage, software)) {
      if (!visited.has(link) && queue.length < 8) queue.push(link);
    }
  }

  const rankedRequirements = requirements.sort((a,b) => b.found - a.found);
  let mergedRequirements = null;
  if (rankedRequirements.length) {
    mergedRequirements = { sourceUrl: rankedRequirements[0].sourceUrl, found: 0 };
    for (const key of ['minimumOsVersion','processor','ram','storage','graphics','language']) {
      const value = rankedRequirements.find(r => r[key])?.[key] || null;
      if (value) { mergedRequirements[key] = value; mergedRequirements.found++; }
    }
  }
  return {
    pagesScanned,
    description: descriptions.sort((a,b) => b.length - a.length)[0] || null,
    requirements: mergedRequirements
  };
}

module.exports = { fetchOfficialDetails, betterDescription };
