'use strict';
function slugify(value) {
  const slug=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100).replace(/-+$/,'');
  return slug||'android-app';
}
function appSlug(row){
  const id=Number(row?.id);
  if(!Number.isSafeInteger(id)||id<1)throw new Error('A saved app ID is required.');
  return `${slugify(row.name)}-${id}`;
}
function appIdFromSlug(value){
  const s=String(value||'');
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))return null;
  const match=s.match(/(?:^|-)([1-9]\d*)$/);
  if(!match)return null;
  const id=Number(match[1]);return Number.isSafeInteger(id)?id:null;
}
module.exports={slugify,appSlug,appIdFromSlug};
