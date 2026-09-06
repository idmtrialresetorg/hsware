const { getPool }=require('../db');
async function clearDraftApps(){const db=getPool();const [[row]]=await db.query('SELECT COUNT(*) c FROM apps WHERE published=0');const count=Number(row?.c||0);await db.query('DELETE FROM apps WHERE published=0');return{cleared:count}}
async function resetAllData(){const db=getPool();await db.query('SET FOREIGN_KEY_CHECKS=0');try{for(const t of ['app_work_claims','notifications','activity_log','publish_queue','apk_metadata','apk_media','apk_versions','apk_update_state','apk_sync_state','apps','apk_categories'])await db.query(`DELETE FROM \`${t}\``)}finally{await db.query('SET FOREIGN_KEY_CHECKS=1')}return{ok:true}}
module.exports={clearDraftApps,resetAllData};
