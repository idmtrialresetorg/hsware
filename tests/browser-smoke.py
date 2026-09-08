"""Real Chromium UI smoke test against original assets and a deterministic mock API.
No live MySQL, LiteAPKs, or production-build success is implied.
"""
import json, threading, os, sys, re
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
record={'id':7,'slug':'binance-7','url':'/apps/binance-7','name':'Binance','packageId':'liteapks:binance','sourcePackageId':'com.binance.dev','sourcePageUrl':'https://liteapks.com/binance.html','sourceUpdatedAt':'2026-09-01','sourceMeta':{'iconUrl':'https://images.example/icon.png','coverImageUrl':'https://images.example/cover.png','screenshots':['https://images.example/1.png','https://images.example/2.png'],'playStoreUrl':'https://play.google.com/store/apps/details?id=com.binance.dev'},'media':{'iconUrl':'https://images.example/icon.png','coverImageUrl':'https://images.example/cover.png','screenshots':['https://images.example/1.png','https://images.example/2.png']},'developer':'Example Developer','version':'3.19.5','category':'Finance','sourceSection':'apps','ratingValue':3.4,'description':'Exact description to copy.\nSecond paragraph.','officialUrl':'https://play.google.com/store/apps/details?id=com.binance.dev','apkType':'Free','fileSizeBytes':10000000,'published':False,'versions':[{'version':'3.19.5','updatedDate':'2026-09-01','fileSizeBytes':10000000},{'version':'3.18.0','updatedDate':'2026-08-01','fileSizeBytes':9000000}]}
requests=[]
counts={'total':1853,'drafts':1853,'published':0,'updates':0,'ready':1853}
bootstrap={'csrfToken':'test-token','user':{'id':1,'name':'Test Admin','email':'admin@example.test','role':'admin'},'counts':counts,'notificationSummary':{'unreadCount':0}}

def png():
 # A small valid PNG, not an externally fetched or counterfeit product logo.
 import base64
 return base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def respond(self,status=200,body=b'',type='text/html'):
  self.send_response(status);self.send_header('Content-Type',type);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def json(self,data,status=200):self.respond(status,json.dumps(data).encode(),'application/json')
 def do_POST(self):
  length=int(self.headers.get('Content-Length','0'));body=json.loads(self.rfile.read(length) or b'{}')
  requests.append((self.path,body))
  if self.path.endswith('/claim'):return self.json({'ok':True,'claim':{'userId':1}})
  if self.path.endswith('/media/refresh'):
   assert body['kinds'] in [['icon'],['cover'],['cover','screenshot'],['screenshot']]
   return self.json({'ok':True,'icon':True,'cover':True,'screenshots':2,'refreshed':body['kinds']})
  if self.path.endswith('/toggle-published'):
   record['published']=not record['published'];return self.json({'ok':True,'published':record['published'],'counts':counts})
  if self.path.endswith('/import'):return self.json({'ok':True,'app':record})
  return self.json({'ok':True})
 def do_GET(self):
  u=urlsplit(self.path);path=u.path
  if path=='/api/bootstrap':return self.json(bootstrap)
  if path=='/api/apps':
   q=parse_qs(u.query);page=int(q.get('page',['1'])[0]);limit=int(q.get('perPage',['20'])[0]);total=45 if q.get('category',[''])[0]=='finance' else 1853
   n=max(0,min(limit,total-(page-1)*limit));apps=[{**record,'id':(page-1)*limit+i+1,'url':f'/apps/app-{(page-1)*limit+i+1}','name':f'App {(page-1)*limit+i+1}'} for i in range(n)]
   return self.json({'ok':True,'apps':apps,'pagination':{'page':page,'perPage':limit,'total':total,'pages':(total+limit-1)//limit,'from':(page-1)*limit+1,'to':(page-1)*limit+n},'counts':counts})
  if path=='/api/taxonomy':return self.json({'total':1853,'sections':{'apps':1200,'games':653},'categories':[{'section':'apps','name':'Finance','slug':'finance','parentSlug':'apps','count':45}], 'roots':[],'fetch':{'status':'complete','verified':True,'sourceCategoryCount':1}})
  if path=='/api/resolver/state':return self.json({'state':{'status':'idle'}})
  if path=='/api/updates/state':return self.json({'state':{'status':'idle'}})
  if path.startswith('/api/apps/by-slug/'):
   slug=path.split('/')[-1];return self.json({'ok':True,'id':7,'slug':'binance-7','url':'/apps/binance-7'})
  if path=='/api/apps/7':return self.json({'ok':True,'app':record})
  if '/media/' in path and path.startswith('/api/apps/'):
   if path.endswith('/media.zip'):return self.respond(200,b'PK\x03\x04','application/zip')
   return self.respond(200,png(),'image/png')
  if path=='/ui/app.js':return self.respond(200,(ROOT/'public/ui/app.js').read_bytes(),'text/javascript')
  if path=='/ui/app.css':return self.respond(200,(ROOT/'public/ui/app.css').read_bytes(),'text/css')
  if path=='/logo.svg':return self.respond(200,(ROOT/'public/logo.svg').read_bytes(),'image/svg+xml')
  if path=='/favicon.svg':return self.respond(200,(ROOT/'public/favicon.svg').read_bytes(),'image/svg+xml')
  if path=='/' or path in ['/library','/library/add','/publishing','/updates','/settings'] or re.fullmatch(r'/apps/[a-z0-9]+(?:-[a-z0-9]+)*',path):
   shell=(ROOT/'dist/server/entry.mjs').read_text().split('const shell = `',1)[1].split('`;\nexport',1)[0]
   return self.respond(200,shell.encode())
  return self.json({'error':'Not found'},404)

def run():
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/library',wait_until='domcontentloaded');page.locator('.app-card').first.wait_for(timeout=15000)
  assert page.locator('.app-card').count()==20
  assert '1,853' in page.locator('.library-results-head').inner_text()
  page.locator('.app-card .app-open').first.click();page.wait_for_url('**/apps/app-1');
  # Open a canonical record directly, as a normal browser deep link.
  page.goto(base+'/apps/binance-7');page.locator('.record-toolbar').wait_for()
  assert page.url.endswith('/apps/binance-7');assert page.locator('.app-record-page').count()==1
  assert page.locator('.modal-wrap').count()==0
  assert page.locator('.record-name-line h1').inner_text()=='Binance'
  assert page.locator('.record-cover-stage img').count()==1
  assert page.locator('.record-fields .field').count()==14
  assert page.locator('.record-version-row').count()==1
  assert page.get_by_text('Direct APK Link').count()==0
  assert page.get_by_text('Resolve Direct Download').count()==0
  assert page.locator('.record-links a[href*="play.google.com"]').count()==1
  assert page.locator('.record-description').inner_text()=='Exact description to copy.\nSecond paragraph.'
  assert page.locator('#refreshLogo').count()==1
  page.locator('#refreshLogo').click();page.get_by_text('Media metadata checked.',exact=False).first.wait_for()
  assert requests[-2][0]=='/api/apps/7/media/refresh' or any(x==('/api/apps/7/media/refresh',{'kinds':['icon']}) for x in requests)
  page.locator('#refreshScreenshots').click();page.get_by_text('Media metadata checked.',exact=False).first.wait_for()
  assert any(x==('/api/apps/7/media/refresh',{'kinds':['cover','screenshot']}) for x in requests)
  page.locator('#closeDetail').click();page.wait_for_url('**/library');
  page.goto(base+'/library/add');page.locator('#sourceUrl').wait_for()
  assert page.locator('.modal-wrap').count()==0
  page.locator('#sourceUrl').fill('https://liteapks.com/binance.html');page.locator('#importApp').click();page.wait_for_url('**/apps/binance-7')
  page.set_viewport_size({'width':390,'height':844});page.reload();page.locator('.record-toolbar').wait_for()
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1')
  out=Path('/mnt/data/appbit_detail_fix/tests');page.screenshot(path=str(out/'record-mobile.png'),full_page=True)
  page.set_viewport_size({'width':1440,'height':1000});page.screenshot(path=str(out/'record-desktop.png'),full_page=True)
  assert not errors,errors
  browser.close()
 server.shutdown()
 print('PASS: Chromium desktop/mobile, direct slug navigation, 20-row pagination, metadata order, removed download UI, individual refresh payloads, Add APK and browser back. No page errors.')
run()
