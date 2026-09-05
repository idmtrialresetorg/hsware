const winget = require('./winget');
const liteapks = require('./liteapks');

function sourceType(row) {
  return String(row?.source_type || row?.sourceType || 'winget').toLowerCase();
}

async function prepareSoftware(id) {
  const { getPool } = require('../db');
  const [[row]] = await getPool().query('SELECT id,source_type FROM software WHERE id=? LIMIT 1',[Number(id)]);
  if(!row) throw new Error('Software not found.');
  return sourceType(row)==='liteapks' ? liteapks.prepareSoftware(Number(id)) : winget.prepareSoftware(Number(id));
}

async function enrichManagedSoftwareById(id, options={}) {
  const { getPool } = require('../db');
  const [[row]] = await getPool().query('SELECT id,source_type FROM software WHERE id=? LIMIT 1',[Number(id)]);
  if(!row) throw new Error('Software not found.');
  return sourceType(row)==='liteapks' ? liteapks.enrichManagedSoftwareById(Number(id),options) : winget.enrichManagedSoftwareById(Number(id),options);
}

async function markUpdated(id) {
  const { getPool } = require('../db');
  const [[row]] = await getPool().query('SELECT id,source_type FROM software WHERE id=? LIMIT 1',[Number(id)]);
  if(!row) throw new Error('Software not found.');
  if(sourceType(row)==='liteapks') return liteapks.markUpdated(Number(id));
  const updates=require('./updates');
  return updates.markUpdatedWinget(Number(id));
}

module.exports={sourceType,prepareSoftware,enrichManagedSoftwareById,markUpdated,winget,liteapks};
