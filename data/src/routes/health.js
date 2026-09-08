const express=require('express');
const config=require('../config');
const state=require('../state');
const{hasDbConfig,getPool}=require('../db');
const router=express.Router();
router.get('/health',async(req,res,next)=>{try{
  if(state.dbReady){const userId=Number(req.session?.user?.id||0);if(!userId)return res.redirect('/login?next=%2Fhealth');const[[user]]=await getPool().query('SELECT role,is_active FROM users WHERE id=? LIMIT 1',[userId]);if(!user||!user.is_active){req.session=null;return res.redirect('/login?next=%2Fhealth')}if(user.role!=='admin')return res.status(403).render('error',{title:'Access denied',active:'',message:'Database Health is available to the Admin only.'})}
  const checks=[
    ['Node.js version','pass',process.version],
    ['Database environment',hasDbConfig()?'pass':'fail',hasDbConfig()?'Configured':'DB_HOST / DB_NAME / DB_USER required'],
    ['Database connection',state.dbReady?'pass':'fail',state.dbReady?'Connected':(state.dbError||'Waiting for connection')],
    ['Schema',state.schemaVersion>=100?'pass':'fail',state.schemaVersion?`Appbit schema ${state.schemaVersion}`:'Not initialized'],
    ['Workspace','pass','Android APK publishing only'],
    ['APK resolver','pass','Public Android source metadata resolver enabled'],
    ['Theme','pass','Dark-only Appbit interface'],
    ['Admin account',state.adminReady?'pass':'fail',state.adminReady?'Ready':'Set ADMIN_EMAIL and ADMIN_PASSWORD before first run'],
    ['Session secret',config.sessionSecret.length>=24?'pass':'fail',config.sessionSecret.length>=24?'Configured':'SESSION_SECRET should be at least 24 characters']
  ];
  const ok=!checks.some(x=>x[1]==='fail');res.status(state.dbReady?200:503).render('health',{title:'Health',checks:checks.map(x=>[x[0],x[1]!=='fail',x[2]]),ok,state,layout:false});
}catch(err){next(err)}});
module.exports=router;
