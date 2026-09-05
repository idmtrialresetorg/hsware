function parseTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { const out = JSON.parse(value); return Array.isArray(out) ? out : []; } catch { return []; }
}

function textProfile(row) {
  return [
    row.name, row.package_id, row.publisher, row.author,
    row.description, ...parseTags(row.tags_json)
  ].filter(Boolean).join(' ').toLowerCase();
}

function bytesToMiB(bytes) {
  const n = Number(bytes || 0);
  return Number.isFinite(n) && n > 0 ? n / (1024 * 1024) : 0;
}

function isHeavyProfile(row) {
  const hay = textProfile(row);
  return /\b(game|gaming|3d|cad|render|renderer|video editor|video editing|animation|modeling|modelling|machine learning|deep learning|ai model|virtual machine|virtualization|emulator|game engine|unreal|unity|blender|davinci|premiere|after effects)\b/i.test(hay);
}

function isLightProfile(row) {
  const hay = textProfile(row);
  return /\b(cli|command line|terminal|shell|utility|utilities|launcher|plugin|extension|password manager|archive|compression|zip|text editor|markdown|clipboard|rename|checksum|sync tool)\b/i.test(hay);
}

function estimateStorage(bytes, row) {
  const mb = bytesToMiB(bytes);
  const heavy = isHeavyProfile(row);
  if (!mb) return heavy ? '8 GB available storage' : isLightProfile(row) ? '1 GB available storage' : '2 GB available storage';
  if (mb <= 25) return '1 GB available storage';
  if (mb <= 100) return '1.5 GB available storage';
  if (mb <= 250) return '2 GB available storage';
  if (mb <= 500) return '3 GB available storage';
  if (mb <= 750) return '4 GB available storage';
  if (mb <= 1024) return '5 GB available storage';
  if (mb <= 2048) return heavy ? '8 GB available storage' : '6 GB available storage';
  if (mb <= 4096) return heavy ? '12 GB available storage' : '10 GB available storage';
  const gb = Math.ceil((mb / 1024) * (heavy ? 2.5 : 2));
  return `${Math.max(12, gb)} GB available storage`;
}

function estimateRam(bytes, row) {
  const mb = bytesToMiB(bytes);
  if (isHeavyProfile(row)) {
    if (mb > 2048) return '16 GB RAM';
    return '8 GB RAM';
  }
  if (isLightProfile(row)) return mb > 500 ? '4 GB RAM' : '2 GB RAM';
  if (!mb) return '4 GB RAM';
  if (mb <= 100) return '2 GB RAM';
  if (mb <= 750) return '4 GB RAM';
  return '8 GB RAM';
}

function estimateGraphics(row) {
  const hay = textProfile(row);
  if (/\b(game|gaming|3d|cad|render|renderer|video editor|video editing|animation|modeling|modelling|game engine|unreal|unity|blender|davinci|premiere|after effects)\b/i.test(hay)) {
    return 'DirectX-compatible graphics';
  }
  if (/\b(machine learning|deep learning|cuda|gpu compute|ai model)\b/i.test(hay)) {
    return 'GPU recommended for acceleration';
  }
  return 'No dedicated GPU required';
}

function estimateOs(row) {
  const arch = String(row.architecture || '').toLowerCase();
  if (arch.includes('arm64')) return 'Windows 10/11 ARM64';
  return 'Windows 10 or newer';
}

function estimateProcessor(row) {
  const arch = String(row.architecture || '').toLowerCase();
  if (arch.includes('arm64')) return '64-bit ARM (ARM64) processor';
  if (arch.includes('x86') && !arch.includes('x64')) return '32-bit x86 processor';
  if (arch.includes('x64')) return '64-bit x86 (x64) processor';
  return '64-bit compatible processor';
}

function androidRequirementFallbacks(row) {
  const estimated = {};
  const pick = (key,current,fallback) => {
    if (String(current || '').trim()) return String(current).trim();
    estimated[key]=true;
    return fallback;
  };
  return {
    platform: pick('platform', row.platform, 'Android'),
    minimumOsVersion: pick('minimumOsVersion', row.minimum_os_version, 'Android version not reported'),
    processor: pick('processor', row.processor, row.architecture || 'Android-compatible CPU'),
    ramRequirement: pick('ram', row.ram_requirement, 'Not reported by source'),
    storageRequirement: pick('storage', row.storage_requirement, row.file_size_bytes ? estimateStorage(row.file_size_bytes,row) : 'Varies by app'),
    graphicsRequirement: pick('graphics', row.graphics_requirement, 'Device dependent'),
    language: pick('language', row.language, 'Varies by app'),
    estimated
  };
}

function withRequirementFallbacks(row) {
  if (String(row?.platform_key || '').toLowerCase() === 'android' || String(row?.source_type || '').toLowerCase() === 'liteapks') return androidRequirementFallbacks(row);
  const estimated = {};
  const pick = (key, current, fallback) => {
    if (String(current || '').trim()) return String(current).trim();
    estimated[key] = true;
    return fallback;
  };
  return {
    platform: pick('platform', row.platform, 'Windows Desktop'),
    minimumOsVersion: pick('minimumOsVersion', row.minimum_os_version, estimateOs(row)),
    processor: pick('processor', row.processor, estimateProcessor(row)),
    ramRequirement: pick('ram', row.ram_requirement, estimateRam(row.file_size_bytes, row)),
    storageRequirement: pick('storage', row.storage_requirement, estimateStorage(row.file_size_bytes, row)),
    graphicsRequirement: pick('graphics', row.graphics_requirement, estimateGraphics(row)),
    language: pick('language', row.language, 'English / system language'),
    estimated
  };
}

module.exports = {
  withRequirementFallbacks,
  androidRequirementFallbacks,
  estimateStorage,
  estimateRam,
  estimateGraphics,
  estimateOs,
  estimateProcessor
};
