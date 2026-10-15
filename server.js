const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'itrenthub.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 phone TEXT DEFAULT '', password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('admin','staff','customer')),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT '🧰', description TEXT NOT NULL DEFAULT '', daily_rate REAL NOT NULL DEFAULT 0,
 deposit REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), product_id INTEGER REFERENCES products(id),
 customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, start_date TEXT NOT NULL,
 days INTEGER NOT NULL, pincode TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL,
 notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','completed','cancelled')),
 staff_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS complaints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
 phone TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
 staff_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const catalog = [
['Laptop','Computers','💻','Business and personal laptops'],['Desktop Computer','Computers','🖥️','Desktop computer systems'],['MacBook','Computers','💻','Apple MacBook laptops'],['iMac','Computers','🖥️','Apple all-in-one desktop'],['Workstation','Computers','🖥️','Professional workstation computers'],['Computer Monitor','Computers','🖥️','LED monitors in multiple sizes'],['Keyboard & Mouse','Accessories','⌨️','Wired and wireless sets'],['Tablet/iPad','Computers','📱','Tablets and iPads'],['Printer','Printing','🖨️','Office printers'],['Photocopier Machine','Printing','🖨️','High-volume photocopiers'],['Scanner','Printing','📠','Document scanners'],['Multifunction Printer','Printing','🖨️','Print, scan and copy devices'],['Barcode Printer','Printing','🏷️','Label and barcode printers'],['Barcode Scanner','Accessories','🔎','Handheld barcode scanners'],['Plotter Machine','Printing','📐','Large-format plotters'],['Projector','Display & AV','📽️','Meeting and presentation projectors'],['Projector Screen','Display & AV','📺','Portable and fixed projection screens'],['LED Display','Display & AV','📺','LED display panels'],['Interactive Display','Display & AV','🖥️','Interactive touch displays'],['Video Conferencing System','Display & AV','🎥','Video meetings and conference devices'],['Wi-Fi Router','Networking','📡','Wireless routers'],['Network Switch','Networking','🔌','Managed and unmanaged switches'],['Wi-Fi Access Point','Networking','📶','Business Wi-Fi access points'],['Server','Servers & Storage','🗄️','Business server systems'],['NAS / Network Storage','Servers & Storage','💾','Shared network storage'],['Firewall Equipment','Networking','🛡️','Network security appliances'],['Modem','Networking','🌐','Internet modems'],['CCTV Camera','Security','📹','Indoor and outdoor CCTV cameras'],['CCTV Monitor','Security','🖥️','Security monitoring displays'],['DVR','Security','📼','Digital video recorders'],['NVR','Security','📹','Network video recorders'],['Video Surveillance System','Security','🎦','Complete camera and recording kits'],['Professional Speakers','Audio','🔊','Professional audio speakers'],['Microphone','Audio','🎙️','Wired and wireless microphones'],['Amplifier','Audio','🔉','Audio amplifiers'],['Audio Mixer','Audio','🎚️','Audio mixing consoles'],['Conference Microphone System','Audio','🎤','Meeting-room microphone systems'],['UPS','Power Backup','🔋','Uninterruptible power supply'],['Inverter','Power Backup','🔌','Power inverters'],['Battery Backup System','Power Backup','🔋','Backup batteries and systems'],['Rack Server','Servers & Storage','🗄️','Rack-mounted servers'],['Tower Server','Servers & Storage','🗄️','Tower servers'],['External Hard Drive','Servers & Storage','💽','Portable external drives'],['Network Storage System','Servers & Storage','💾','Business shared storage'],['Home Theatre 5.1 System','Home Audio','🔊','5.1 surround sound for home entertainment'],['TV Soundbar','Home Audio','📺','Soundbars for TV and living rooms'],['Home Subwoofer','Home Audio','🔉','Home audio bass subwoofers'],['Bluetooth Home Speaker','Home Audio','🔊','Wireless speakers for home use'],['Wireless Home Speaker Set','Home Audio','🎶','Multi-speaker wireless home audio'],['Bookshelf Speakers','Home Audio','🔈','Compact stereo bookshelf speakers'],['Floor-Standing Tower Speakers','Home Audio','🔊','Tower speakers for living-room sound'],['Home Audio Receiver','Home Audio','🎛️','AV receivers for home theatre']
];
const addProduct = db.prepare('INSERT OR IGNORE INTO products(name,category,icon,description,daily_rate,deposit) VALUES(?,?,?,?,?,?)');
for (const p of catalog) addProduct.run(...p, 0, 0);

const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminEmail && adminPassword && !db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) {
 const hash = bcrypt.hashSync(adminPassword, 12);
 db.prepare('INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,?)').run(process.env.ADMIN_NAME || 'ITRentHub Owner', adminEmail, '', hash, 'admin');
 console.log('Initial admin account created from environment variables. Change its password after first login.');
}
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({limit:'100kb'}));
app.use(express.urlencoded({extended:false,limit:'100kb'}));
app.use(session({
 name:'itrenthub.sid', secret:process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deployment',
 resave:false, saveUninitialized:false, store:new SQLiteStore({db:'sessions.sqlite',dir:DATA_DIR}),
 cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000}
}));
const loginLimiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false,message:{error:'Too many attempts. Try again in 15 minutes.'}});
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||''));
const clean = (v,max=250) => String(v??'').trim().slice(0,max);
function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:'Please log in first.'}); next(); }
function roles(...allowed){ return (req,res,next)=>{ if(!req.session.user) return res.status(401).json({error:'Please log in first.'}); if(!allowed.includes(req.session.user.role)) return res.status(403).json({error:'You do not have permission for this action.'}); next(); }; }
function userSafe(u){return {id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role};}
app.get('/api/health',(req,res)=>res.json({ok:true,service:'ITRentHub'}));
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));
app.post('/api/register',loginLimiter, (req,res)=>{
 const name=clean(req.body.name,100), email=clean(req.body.email,180).toLowerCase(), phone=clean(req.body.phone,25), password=String(req.body.password||'');
 if(name.length<2||!emailOk(email)||password.length<10) return res.status(400).json({error:'Name, valid email and password of at least 10 characters are required.'});
 if(!/[A-Za-z]/.test(password)||!/[0-9]/.test(password)) return res.status(400).json({error:'Password must contain at least one letter and one number.'});
 try {const info=db.prepare('INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,?)').run(name,email,phone,bcrypt.hashSync(password,12),'customer'); const u=userSafe(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)); req.session.user=u; res.status(201).json({user:u});}
 catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'An account with this email already exists.'}); console.error(e);res.status(500).json({error:'Could not create account.'});}
});
app.post('/api/login',loginLimiter,(req,res)=>{
 const email=clean(req.body.email,180).toLowerCase(), password=String(req.body.password||'');
 const u=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
 if(!u||!bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:'Email or password is incorrect.'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start session.'}); req.session.user=userSafe(u);res.json({user:req.session.user});});
});
app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>{res.clearCookie('itrenthub.sid');res.json({ok:true});}));
app.get('/api/products',(req,res)=>res.json({products:db.prepare('SELECT id,name,category,icon,description,daily_rate,deposit FROM products WHERE active=1 ORDER BY category,name').all()}));
app.post('/api/bookings',auth,(req,res)=>{
 const productId=Number(req.body.productId), days=Number(req.body.days), startDate=clean(req.body.startDate,10), name=clean(req.body.name,100), phone=clean(req.body.phone,25), email=clean(req.body.email,180).toLowerCase(), pincode=clean(req.body.pincode,10), city=clean(req.body.city,100), address=clean(req.body.address,500), notes=clean(req.body.notes,1000);
 const product=db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId);
 if(!product||!Number.isInteger(days)||days<1||days>365||!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||startDate<new Date().toISOString().slice(0,10)||name.length<2||phone.length<7||!emailOk(email)||pincode.length<4||!city||address.length<5) return res.status(400).json({error:'Please check all required booking details.'});
 const info=db.prepare(`INSERT INTO bookings(user_id,product_id,customer_name,phone,email,start_date,days,pincode,city,address,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(req.session.user.id,productId,name,phone,email,startDate,days,pincode,city,address,notes);
 res.status(201).json({booking:{id:info.lastInsertRowid,status:'pending'},message:'Request received. It is pending owner/staff review; this is not a confirmed booking.'});
});
app.get('/api/my/bookings',auth,(req,res)=>res.json({bookings:db.prepare(`SELECT b.id,b.customer_name,b.phone,b.email,b.start_date,b.days,b.pincode,b.city,b.address,b.notes,b.status,b.staff_note,b.created_at,p.name AS product_name FROM bookings b JOIN products p ON p.id=b.product_id WHERE b.user_id=? ORDER BY b.id DESC`).all(req.session.user.id)}));
app.post('/api/complaints',auth,(req,res)=>{
 const name=clean(req.body.name,100), phone=clean(req.body.phone,25), subject=clean(req.body.subject,160), message=clean(req.body.message,2000);
 if(name.length<2||phone.length<7||subject.length<3||message.length<10)return res.status(400).json({error:'Please complete all complaint fields.'});
 const info=db.prepare('INSERT INTO complaints(user_id,name,phone,subject,message) VALUES(?,?,?,?,?)').run(req.session.user.id,name,phone,subject,message);
 res.status(201).json({id:info.lastInsertRowid,message:'Complaint submitted.'});
});
app.get('/api/my/complaints',auth,(req,res)=>res.json({complaints:db.prepare('SELECT id,subject,message,status,staff_note,created_at FROM complaints WHERE user_id=? ORDER BY id DESC').all(req.session.user.id)}));
app.get('/api/manage/overview',roles('admin','staff'),(req,res)=>{
 const counts={pending:db.prepare("SELECT COUNT(*) n FROM bookings WHERE status='pending'").get().n,approved:db.prepare("SELECT COUNT(*) n FROM bookings WHERE status='approved'").get().n,customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,openComplaints:db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','in_progress')").get().n};
 const bookings=db.prepare(`SELECT b.*,p.name product_name FROM bookings b JOIN products p ON p.id=b.product_id ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END,b.id DESC LIMIT 500`).all();
 const complaints=db.prepare('SELECT * FROM complaints ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'in_progress\' THEN 1 ELSE 2 END,id DESC LIMIT 300').all();
 const customers=req.session.user.role==='admin'?db.prepare("SELECT id,name,email,phone,active,created_at FROM users WHERE role='customer' ORDER BY id DESC LIMIT 500").all():[];
 const staff=req.session.user.role==='admin'?db.prepare("SELECT id,name,email,phone,active,created_at FROM users WHERE role='staff' ORDER BY id DESC").all():[];
 const products=req.session.user.role==='admin'?db.prepare('SELECT * FROM products ORDER BY category,name').all():[];
 res.json({counts,bookings,complaints,customers,staff,products});
});
app.patch('/api/manage/bookings/:id',roles('admin','staff'),(req,res)=>{
 const status=clean(req.body.status,20), note=clean(req.body.staffNote,1000);
 if(!['approved','rejected','completed','cancelled','pending'].includes(status))return res.status(400).json({error:'Invalid status.'});
 const info=db.prepare('UPDATE bookings SET status=?,staff_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,note,Number(req.params.id));
 if(!info.changes)return res.status(404).json({error:'Booking not found.'});res.json({ok:true});
});
app.patch('/api/manage/complaints/:id',roles('admin','staff'),(req,res)=>{
 const status=clean(req.body.status,20), note=clean(req.body.staffNote,1000);if(!['open','in_progress','resolved','closed'].includes(status))return res.status(400).json({error:'Invalid status.'});
 const info=db.prepare('UPDATE complaints SET status=?,staff_note=? WHERE id=?').run(status,note,Number(req.params.id));if(!info.changes)return res.status(404).json({error:'Complaint not found.'});res.json({ok:true});
});
app.post('/api/manage/staff',roles('admin'),(req,res)=>{
 const name=clean(req.body.name,100),email=clean(req.body.email,180).toLowerCase(),phone=clean(req.body.phone,25),password=String(req.body.password||'');
 if(name.length<2||!emailOk(email)||password.length<10||!/[A-Za-z]/.test(password)||!/[0-9]/.test(password))return res.status(400).json({error:'Enter name, valid email and password (10+ chars with letters and numbers).'});
 try{const info=db.prepare('INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,?)').run(name,email,phone,bcrypt.hashSync(password,12),'staff');res.status(201).json({id:info.lastInsertRowid});}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'Email already exists.'});res.status(500).json({error:'Could not add staff.'});}
});
app.patch('/api/manage/users/:id',roles('admin'),(req,res)=>{const active=Number(req.body.active);if(![0,1].includes(active))return res.status(400).json({error:'Invalid active value.'});const info=db.prepare("UPDATE users SET active=? WHERE id=? AND role IN ('customer','staff')").run(active,Number(req.params.id));if(!info.changes)return res.status(404).json({error:'Account not found.'});res.json({ok:true});});
app.patch('/api/manage/products/:id',roles('admin'),(req,res)=>{const rate=Number(req.body.dailyRate),deposit=Number(req.body.deposit),active=Number(req.body.active);if(!Number.isFinite(rate)||rate<0||rate>10000000||!Number.isFinite(deposit)||deposit<0||deposit>100000000||![0,1].includes(active))return res.status(400).json({error:'Invalid price or availability.'});const info=db.prepare('UPDATE products SET daily_rate=?,deposit=?,active=? WHERE id=?').run(rate,deposit,active,Number(req.params.id));if(!info.changes)return res.status(404).json({error:'Product not found.'});res.json({ok:true});});
app.get('/api/manage/export.csv',roles('admin','staff'),(req,res)=>{const rows=db.prepare(`SELECT b.id,b.customer_name,b.phone,b.email,p.name product,b.start_date,b.days,b.pincode,b.city,b.address,b.status,b.staff_note,b.created_at FROM bookings b JOIN products p ON p.id=b.product_id ORDER BY b.id DESC`).all();const cols=Object.keys(rows[0]||{id:'',customer_name:''});const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="itrenthub-bookings.csv"');res.send('\ufeff'+[cols.join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\r\n'));});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT,()=>console.log(`ITRentHub running at http://localhost:${PORT}`));
