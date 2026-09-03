function validateSvgBuffer(buffer) {
  const text=Buffer.isBuffer(buffer)?buffer.toString('utf8'):String(buffer||'');
  if(!/<svg\b/i.test(text)) throw new Error('Remote content is not an SVG image.');
  const blocked=[
    /<!DOCTYPE\b/i,
    /<!ENTITY\b/i,
    /<\s*script\b/i,
    /<\s*foreignObject\b/i,
    /<\s*(?:iframe|object|embed)\b/i,
    /\son[a-z0-9_-]+\s*=/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
    /data\s*:\s*text\/html/i,
    /<\s*style\b/i,
    /\bstyle\s*=\s*["'][^"']*(?:url\s*\(|@import|expression\s*\()/i
  ];
  if(blocked.some(rx=>rx.test(text))) throw new Error('Unsafe active content was detected in the SVG.');
  const refRx=/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/ig;
  let match;
  while((match=refRx.exec(text))){
    const value=String(match[2]||'').trim();
    if(value && !value.startsWith('#')) throw new Error('External SVG references are not allowed.');
  }
  const urlRx=/url\s*\(\s*(["']?)(.*?)\1\s*\)/ig;
  while((match=urlRx.exec(text))){
    const value=String(match[2]||'').trim();
    if(value && !value.startsWith('#')) throw new Error('External SVG URL references are not allowed.');
  }
  return Buffer.from(text,'utf8');
}
module.exports={validateSvgBuffer};
