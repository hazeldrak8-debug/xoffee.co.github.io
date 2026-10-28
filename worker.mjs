const CATALOG={'coffee-50':{name:'Instant Coffee (50 g)',price:999},glass:{name:'Iced Coffee',price:400},'coffee-100':{name:'Instant Coffee (100 g)',price:1850}};
const TYPES=new Set(['page_view','add_to_cart','begin_checkout','details_submitted']);
const validId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(s);
const text=(s,max)=>typeof s==='string'?s.trim().slice(0,max):'';
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');
export function normalizeOrder(b){
 if(!validId(b.id)||!validId(b.visitorId))throw Error('Invalid order reference.');
 const customer=text(b.customer,100),phone=text(b.phone,40),address=text(b.address,1000),payment=text(b.payment,50);
 if(customer.length<2||!/[0-9]{3}/.test(phone.replace(/\D/g,''))||phone.replace(/\D/g,'').length<7||address.length<8)throw Error('Please enter your name, phone and complete delivery address.');
 if(!['Cash on Delivery (COD)','Bank transfer'].includes(payment))throw Error('Invalid payment method.');
 if(!b.selection||typeof b.selection!=='object'||Array.isArray(b.selection))throw Error('Cart is missing.');
 const entries=Object.entries(b.selection).sort();if(!entries.length||entries.length>3)throw Error('Select a product.');
 const items=entries.map(([id,qty])=>{if(!CATALOG[id]||!Number.isInteger(qty)||qty<1||qty>99)throw Error('Invalid product or quantity.');return{id,...CATALOG[id],qty}});
 const email=text(b.email,200);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Invalid email.');
 return{id:b.id,visitorId:b.visitorId,customer,phone,address,payment,email,city:text(b.city,100),province:text(b.province,100),postalCode:text(b.postalCode,20),country:text(b.country,100)||'Pakistan',notes:text(b.notes,1000),items,shipping:200,status:'Pending'};
}
export default {async fetch(req,env,ctx){
 const url=new URL(req.url),origin=req.headers.get('Origin'),allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
 if(origin&&allowed.includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='GET, POST, OPTIONS';headers['Access-Control-Allow-Headers']='Content-Type, Authorization';}
 const reply=(b,status=200)=>new Response(JSON.stringify(b),{status,headers});
 if(origin&&!allowed.includes(origin))return reply({error:'Origin not allowed.'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
 if(url.pathname==='/health')return reply({ok:true});
 if(url.pathname==='/admin/status'){
  if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24||await hash(req.headers.get('Authorization')||'')!==await hash('Bearer '+env.ADMIN_TOKEN))return reply({error:'Unauthorized.'},401);
  if(req.method!=='POST')return reply({error:'POST required.'},405);
  const raw=await req.text();if(raw.length>2000)return reply({error:'Too large.'},413);let b;try{b=JSON.parse(raw)}catch{return reply({error:'Invalid JSON.'},400)}
  if(!validId(b.id)||!['Pending','Paid','Processing','Delivered','Cancelled'].includes(b.status))return reply({error:'Invalid status.'},400);
  const result=await env.DB.prepare("UPDATE orders SET data=json_set(data,'$.status',?) WHERE id=?").bind(b.status,b.id).run();
  return result.meta.changes?reply({ok:true}):reply({error:'Order not found.'},404);
 }
 if(url.pathname==='/admin/snapshot'){
  if(!env.ADMIN_TOKEN||env.ADMIN_TOKEN.length<24)return reply({error:'Admin is not configured.'},503);
  const supplied=req.headers.get('Authorization')||'';
  if(await hash(supplied)!==await hash('Bearer '+env.ADMIN_TOKEN))return reply({error:'Incorrect admin password.'},401);
  const days=Math.min(365,Math.max(1,Number(url.searchParams.get('days'))||30)),cutoff=new Date(Date.now()-days*86400000).toISOString();
  const ev=await env.DB.prepare('SELECT id, visitor_id AS visitorId, type, at FROM events WHERE at >= ? ORDER BY at LIMIT 200001').bind(cutoff).all();
  const os=await env.DB.prepare('SELECT data, at FROM orders WHERE at >= ? ORDER BY at DESC LIMIT 20001').bind(cutoff).all();
  if(ev.results.length>200000||os.results.length>20000)return reply({error:'Too much data. Choose a shorter date range.'},413);
  return reply({events:ev.results,orders:os.results.map(r=>({...JSON.parse(r.data),at:r.at})),fetchedAt:new Date().toISOString(),days});
 }
 if(req.method!=='POST'||!['/events','/orders'].includes(url.pathname))return reply({error:'Not found.'},404);
 if(!env.DB)return reply({error:'Database not configured.'},503);
 if(!req.headers.get('Content-Type')?.includes('application/json'))return reply({error:'JSON required.'},415);
 if(Number(req.headers.get('Content-Length')||0)>20000)return reply({error:'Request too large.'},413);
 const raw=await req.text();if(raw.length>20000)return reply({error:'Request too large.'},413);let b;try{b=JSON.parse(raw)}catch{return reply({error:'Invalid JSON.'},400)}
 // The anonymous IP bucket is hashed; raw IPs are never stored.
 const ip=req.headers.get('CF-Connecting-IP')||'unknown',minute=Math.floor(Date.now()/60000),key=await hash(ip+':'+minute+':'+(env.RATE_SALT||''));
 const rate=await env.DB.prepare('INSERT INTO rate_limits (id, count, expires) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count').bind(key,Date.now()+120000).first();
 if(rate.count>120)return reply({error:'Please wait a minute and retry.'},429);
 ctx.waitUntil(env.DB.prepare('DELETE FROM rate_limits WHERE expires < ?').bind(Date.now()).run());
 const at=new Date().toISOString();
 if(url.pathname==='/events'){
  if(!validId(b.id)||!validId(b.visitorId)||!TYPES.has(b.type))return reply({error:'Invalid event.'},400);
  await env.DB.prepare('INSERT OR IGNORE INTO events(id,visitor_id,type,at) VALUES(?,?,?,?)').bind(b.id,b.visitorId,b.type,at).run();return reply({ok:true});
 }
 let order;try{order=normalizeOrder(b)}catch(e){return reply({error:e.message},400)}
 const fingerprint=await hash(JSON.stringify(order));
 const previous=await env.DB.prepare('SELECT fingerprint FROM orders WHERE id=?').bind(order.id).first();
 if(previous)return previous.fingerprint===fingerprint?reply({success:true,reference:order.id,duplicate:true}):reply({error:'This reference was already used for a different order.'},409);
 order.at=at;const inserted=await env.DB.prepare('INSERT OR IGNORE INTO orders(id,visitor_id,at,data,fingerprint) VALUES(?,?,?,?,?)').bind(order.id,order.visitorId,at,JSON.stringify(order),fingerprint).run();
 if(!inserted.meta.changes){const existing=await env.DB.prepare('SELECT fingerprint FROM orders WHERE id=?').bind(order.id).first();return existing?.fingerprint===fingerprint?reply({success:true,reference:order.id,duplicate:true}):reply({error:'Order reference conflict.'},409)}
 // An accepted request is a saved Pending order, not a paid or dispatched order.
 await env.DB.prepare('INSERT OR IGNORE INTO events(id,visitor_id,type,at) VALUES(?,?,?,?)').bind('details_'+order.id,order.visitorId,'details_submitted',at).run().catch(()=>{});
 if(env.WEB3FORMS_KEY)ctx.waitUntil((async()=>{try{const response=await fetch('https://api.web3forms.com/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_key:env.WEB3FORMS_KEY,subject:'New XOFFEE.CO order '+order.id,from_name:'XOFFEE.CO Orders',name:order.customer,phone:order.phone,email:order.email||undefined,message:JSON.stringify(order,null,2)})});const body=await response.json();if(!response.ok||!body.success)throw Error('rejected');await env.DB.prepare('UPDATE orders SET notification=? WHERE id=?').bind('sent',order.id).run()}catch{await env.DB.prepare('UPDATE orders SET notification=? WHERE id=?').bind('failed',order.id).run()}})());
 return reply({success:true,reference:order.id},201);
 }catch(e){return reply({error:'Service unavailable. Your cart has been kept. Retry using the same order reference.'},503)}
}};
