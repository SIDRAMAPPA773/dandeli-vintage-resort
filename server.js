// Dandeli Vintage Resorts - Booking & Payment Backend Server
// Automated Direct SMS Dispatch & Manager Portal with WhatsApp Confirmation + Room & Location Details

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
const MANAGER_PHONE = '6361185700';
const MANAGER_PHONE_FORMATTED = '+91 63611 85700';

// Storage paths
const BASE_DIR = __dirname;
const ASSETS_DIR = path.join(BASE_DIR, 'Booking & Payment');
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const SMS_LOG_FILE = path.join(BASE_DIR, 'sms_outbox.log');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── MongoDB Booking Schema ────────────────────────────────────────────────
const bookingSchema = new mongoose.Schema({
    id:             { type: String, required: true, unique: true },
    invoiceNumber:  { type: String },
    code:           { type: String },
    status:         { type: String, default: 'AWAITING_VERIFICATION' },
    createdAt:      { type: String },
    confirmedAt:    { type: String },
    name:           { type: String },
    mobNo:          { type: String },
    noOfPersons:    { type: mongoose.Schema.Types.Mixed },
    checkInDate:    { type: String },
    checkInTime:    { type: String },
    checkOutDate:   { type: String },
    checkOutTime:   { type: String, default: '11:00 AM' },
    noOfNights:     { type: mongoose.Schema.Types.Mixed },
    resort:         { type: String },
    package:        { type: String },
    ratePerPerson:  { type: Number },
    totalAmount:    { type: Number },
    advanceAmount:  { type: Number },
    balanceAmount:  { type: Number },
    hasScreenshot:  { type: Boolean, default: false },
    screenshotUrl:  { type: String, default: null },
    roomNumber:     { type: String },
    roomNotes:      { type: String },
    resortAddress:  { type: String },
    mapsLocation:   { type: String },
    managerPhone:   { type: String },
    riverActivities:{ type: String },
    landmark:       { type: String },
    managerName:    { type: String, default: 'Nakul' }
}, { strict: false });

// ─── Manager Schema & Model ────────────────────────────────────────────────
const managerSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    name:     { type: String, required: true },
    phone:    { type: String, required: true },
    role:     { type: String, default: 'manager' }, // 'admin' or 'manager'
    createdAt:{ type: String, default: () => new Date().toISOString() }
});

const Manager = mongoose.model('Manager', managerSchema);

// In-memory sessions store
const sessions = new Map();

function createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        username: user.username,
        name: user.name,
        phone: user.phone,
        role: user.role,
        expires: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
    });
    return token;
}

function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const val = rest.join('=').trim();
        list[name] = decodeURIComponent(val);
    });
    return list;
}

function getAuthenticatedManager(req) {
    const cookies = parseCookies(req);
    const token = cookies['dvr_session'];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires && session.expires < Date.now()) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function deleteSession(req) {
    const cookies = parseCookies(req);
    const token = cookies['dvr_session'];
    if (token) sessions.delete(token);
}

// Fallback manager storage
let localManagers = [
    { username: 'nakul', password: 'Nakul*64', name: 'Nakul', phone: '+91 63611 85700', role: 'admin' }
];

async function seedAdminManager() {
    try {
        if (mongoConnected) {
            const admin = await Manager.findOne({ username: 'nakul' });
            if (!admin) {
                await Manager.create({
                    username: 'nakul',
                    password: 'Nakul*64',
                    name: 'Nakul',
                    phone: '+91 63611 85700',
                    role: 'admin'
                });
                console.log('👑 Admin manager "nakul" seeded in MongoDB Atlas!');
            }
        }
    } catch (err) {
        console.error('Error seeding admin manager:', err.message);
    }
}

async function findManager(username) {
    const cleanUser = (username || '').toLowerCase().trim();
    if (mongoConnected) {
        return await Manager.findOne({ username: cleanUser }).lean();
    }
    return localManagers.find(m => m.username.toLowerCase() === cleanUser);
}

async function saveNewManager(data) {
    if (mongoConnected) {
        return await Manager.create(data);
    }
    localManagers.push(data);
    return data;
}

async function listAllManagers() {
    if (mongoConnected) {
        return await Manager.find({}, '-password').sort({ createdAt: -1 }).lean();
    }
    return localManagers.map(({ password, ...rest }) => rest);
}

const Booking = mongoose.model('Booking', bookingSchema);

// ─── Connect to MongoDB Atlas ─────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || '';

if (!MONGODB_URI || MONGODB_URI.includes('<username>')) {
    console.warn('\n⚠️  WARNING: MONGODB_URI not set in .env — running in LOCAL FILE fallback mode.');
    console.warn('   Set your MongoDB Atlas URI in .env to enable cloud database.\n');
}

let mongoConnected = false;

async function connectMongo() {
    if (!MONGODB_URI || MONGODB_URI.includes('<username>')) return;
    try {
        await mongoose.connect(MONGODB_URI);
        mongoConnected = true;
        console.log('✅ MongoDB Atlas connected successfully!');
        await seedAdminManager();
    } catch (err) {
        console.error('❌ MongoDB connection failed:', err.message);
        console.warn('   Falling back to local JSON file storage.\n');
    }
}

// ─── Local JSON Fallback (used when MongoDB not connected) ────────────────
const DATA_FILE = path.join(BASE_DIR, 'bookings.json');
let bookings = {};

function loadLocalBookings() {
    if (fs.existsSync(DATA_FILE)) {
        try { bookings = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
        catch (e) { bookings = {}; }
    }
}

function saveLocalBookings() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bookings, null, 2), 'utf8');
}

// ─── Unified DB Helpers ────────────────────────────────────────────────────

async function dbSave(record) {
    if (mongoConnected) {
        await Booking.findOneAndUpdate({ id: record.id }, record, { upsert: true, new: true });
    } else {
        bookings[record.id] = record;
        saveLocalBookings();
    }
}

async function dbFindById(id) {
    if (mongoConnected) {
        const doc = await Booking.findOne({ id }).lean();
        return doc || null;
    } else {
        return bookings[id] || null;
    }
}

async function dbFindByInvoice(invoiceNumber) {
    if (mongoConnected) {
        return await Booking.findOne({ invoiceNumber }).lean();
    } else {
        return Object.values(bookings).find(b => b.invoiceNumber === invoiceNumber) || null;
    }
}

async function dbFindByCode(code) {
    if (mongoConnected) {
        return await Booking.findOne({ code: { $regex: new RegExp('^' + code + '$', 'i') } }).lean();
    } else {
        return Object.values(bookings).find(b => b.code && b.code.toUpperCase() === code.toUpperCase()) || null;
    }
}

async function dbUpdate(id, updates) {
    if (mongoConnected) {
        const doc = await Booking.findOneAndUpdate({ id }, { $set: updates }, { new: true }).lean();
        return doc;
    } else {
        if (!bookings[id]) return null;
        Object.assign(bookings[id], updates);
        saveLocalBookings();
        return bookings[id];
    }
}

async function dbGetAll() {
    if (mongoConnected) {
        return await Booking.find({}).lean();
    } else {
        return Object.values(bookings);
    }
}

// Compatibility shim: keep bookings in sync for Manager Portal HTML template
async function refreshBookingsCache() {
    const all = await dbGetAll();
    bookings = {};
    all.forEach(b => { bookings[b.id] = b; });
}

// Generate random 5-digit verification code
function generateCode() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

// Log SMS Dispatch
function logSMS(to, body) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] TO: ${to}\n${body}\n${'-'.repeat(60)}\n`;
    fs.appendFileSync(SMS_LOG_FILE, logEntry, 'utf8');
    console.log('\n' + '='.repeat(70));
    console.log(`📡 [AUTOMATED DIRECT SMS DISPATCHED] -> Recipient: ${to}`);
    console.log('='.repeat(70));
    console.log(body);
    console.log('='.repeat(70) + '\n');
}

// Send SMS via Fast2SMS (if FAST2SMS_API_KEY environment variable is set)
async function sendSMSViaFast2SMS(apiKey, numbers, message) {
    return new Promise((resolve, reject) => {
        const query = new URLSearchParams({
            authorization: apiKey,
            route: 'q',
            message: message,
            language: 'english',
            flash: '0',
            numbers: numbers
        }).toString();

        const req = https.request({
            hostname: 'www.fast2sms.com',
            path: `/dev/bulkV2?${query}`,
            method: 'GET'
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.end();
    });
}

// Dispatch SMS to Manager (+91 63611 85700)
async function dispatchManagerSMS(booking) {
    const text = 
`DANDELI VINTAGE RESORTS: New Booking!
Inv: ${booking.invoiceNumber}
Guest: ${booking.name} (+91 ${booking.mobNo})
Guests: ${booking.noOfPersons} | Nights: ${booking.noOfNights}
Check-in: ${booking.checkInDate}
Total: Rs ${booking.totalAmount} | Advance: Rs ${booking.advanceAmount}
Balance: Rs ${booking.balanceAmount}
Payment Status: ${booking.hasScreenshot ? 'ATTACHED & UPLOADED' : 'Pending'}

Approval Code for Guest: ${booking.code}
(Open Manager Portal ${APP_URL}/manager to review registration, allocate room and send approval code to guest)`;

    const toPhone = booking.managerPhone || MANAGER_PHONE_FORMATTED;
    const cleanPhoneDigits = (toPhone || '').replace(/\D/g, '').slice(-10) || MANAGER_PHONE;
    logSMS(toPhone, text);

    if (process.env.FAST2SMS_API_KEY) {
        try {
            console.log('Dispatching live SMS directly to manager ' + (booking.managerName || 'Manager') + ' (' + cleanPhoneDigits + ')...');
            const res = await sendSMSViaFast2SMS(process.env.FAST2SMS_API_KEY, cleanPhoneDigits, text);
            console.log('Fast2SMS Response:', res);
        } catch (err) {
            console.error('Fast2SMS Error:', err.message);
        }
        return;
    }

    if (process.env.FAST2SMS_API_KEY) {
        try {
            console.log('Dispatching live SMS via Fast2SMS Gateway...');
            const res = await sendSMSViaFast2SMS(process.env.FAST2SMS_API_KEY, MANAGER_PHONE, text);
            console.log('Fast2SMS Response:', res);
        } catch (err) {
            console.error('Fast2SMS Error:', err.message);
        }
    }
}

// MIME Types
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf'
};

// Create Server
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // API: Submit Booking from Customer
    if (pathname === '/api/submit-booking' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const bookingId = 'BK-' + Date.now();
                const approvalCode = generateCode();

                let screenshotUrl = null;
                let hasScreenshot = false;

                // Save base64 screenshot if provided
                if (data.screenshotData && data.screenshotData.includes('base64,')) {
                    const parts = data.screenshotData.split(';base64,');
                    const mime = parts[0].replace('data:', '');
                    const ext = mime.includes('png') ? '.png' : (mime.includes('pdf') ? '.pdf' : '.jpg');
                    const fileName = `${bookingId}-payment${ext}`;
                    const filePath = path.join(UPLOADS_DIR, fileName);
                    fs.writeFileSync(filePath, Buffer.from(parts[1], 'base64'));
                    screenshotUrl = `/uploads/${fileName}`;
                    hasScreenshot = true;
                }

                const approachedMgrName = (data.managerName || 'Nakul').trim();
                const approachedMgrPhone = (data.managerPhone || '+91 63611 85700').trim();

                // Match registered manager by phone or username
                let assignedUsername = null;
                try {
                    const allMgrs = await listAllManagers();
                    const cleanPhone = approachedMgrPhone.replace(/\D/g, '').slice(-10);
                    const matched = allMgrs.find(m => {
                        const mPhone = (m.phone || '').replace(/\D/g, '').slice(-10);
                        return mPhone && mPhone === cleanPhone;
                    });
                    if (matched) {
                        assignedUsername = matched.username;
                    }
                } catch(e) {}

                const bookingRecord = {
                    id: bookingId,
                    invoiceNumber: data.invoiceNumber || ('DVR-' + Date.now().toString().slice(-6)),
                    code: approvalCode,
                    status: 'AWAITING_VERIFICATION',
                    createdAt: new Date().toISOString(),
                    name: data.name,
                    mobNo: data.mobNo,
                    noOfPersons: data.noOfPersons,
                    checkInDate: data.checkInDate,
                    checkInTime: data.checkInTime,
                    checkOutDate: data.checkOutDate,
                    noOfNights: data.noOfNights,
                    resort: data.resort,
                    package: data.package,
                    ratePerPerson: data.ratePerPerson,
                    totalAmount: data.totalAmount,
                    advanceAmount: data.advanceAmount,
                    balanceAmount: data.balanceAmount,
                    hasScreenshot,
                    screenshotUrl,
                    roomNumber: 'Cottage #101',
                    roomNotes: 'AC, River View, King Bed',
                    resortAddress: 'Dandeli Vintage Resorts, Near Kali River Bridge, Haliyal Road, Dandeli, Karnataka 581325',
                    mapsLocation: 'https://maps.app.goo.gl/9Dandelikali',
                    managerName: approachedMgrName,
                    managerPhone: approachedMgrPhone,
                    assignedManagerUsername: assignedUsername,
                    checkOutTime: '11:00 AM',
                    riverActivities: 'Kali River Rafting, Kayaking, Boating, Jacuzzi Bath, Zorbing, River Crossing'
                };

                await dbSave(bookingRecord);

                // Dispatch SMS directly to manager (+91 63611 85700)
                await dispatchManagerSMS(bookingRecord);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                // Code remains concealed from customer
                res.end(JSON.stringify({
                    success: true,
                    bookingId: bookingId,
                    invoiceNumber: bookingRecord.invoiceNumber,
                    message: `Booking request sent directly to Resort Management. Manager has been notified with your payment status.`
                }));
            } catch (err) {
                console.error('Error submitting booking:', err);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // API: Verify Approval Code entered by customer
    if (pathname === '/api/verify-code' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { bookingId, invoiceNumber, code } = data;
                const enteredCode = (code || '').trim().toUpperCase();

                // Check master codes
                if (enteredCode === '63611' || enteredCode === '9999' || enteredCode === 'VINTAGE2026' || enteredCode === 'DVR2026') {
                    let targetBooking = null;
                    if (bookingId) targetBooking = await dbFindById(bookingId);
                    if (!targetBooking && invoiceNumber) targetBooking = await dbFindByInvoice(invoiceNumber);
                    if (targetBooking) {
                        targetBooking = await dbUpdate(targetBooking.id, { status: 'CONFIRMED' });
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        approved: true,
                        booking: targetBooking,
                        note: 'Approved via Master Override Code'
                    }));
                }

                // Check by bookingId, invoiceNumber, or code
                let targetBooking = null;
                if (bookingId) targetBooking = await dbFindById(bookingId);
                if (!targetBooking && invoiceNumber) targetBooking = await dbFindByInvoice(invoiceNumber);
                if (!targetBooking) targetBooking = await dbFindByCode(enteredCode);

                if (targetBooking && targetBooking.code && targetBooking.code.toUpperCase() === enteredCode) {
                    targetBooking = await dbUpdate(targetBooking.id, {
                        status: 'CONFIRMED',
                        confirmedAt: new Date().toISOString()
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        approved: true,
                        booking: targetBooking,
                        message: `Payment confirmed by management. Scanned copy verified.`
                    }));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    approved: false,
                    message: `Incorrect code. Please contact the manager for the correct approval code.`
                }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // API: Manager update all booking details (editable check-in time, dates, guests, billing, room, activities)
    if (pathname === '/api/manager/update-and-confirm' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { bookingId } = data;

                const existing = await dbFindById(bookingId);
                if (!existing) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Booking not found' }));
                }

                const updates = { status: 'CONFIRMED', confirmedAt: new Date().toISOString() };

                // Editable Guest Info
                if (data.name !== undefined) updates.name = data.name;
                if (data.mobNo !== undefined) updates.mobNo = data.mobNo;

                // Editable Stay & Timing Details
                if (data.checkInDate !== undefined) updates.checkInDate = data.checkInDate;
                if (data.checkInTime !== undefined) updates.checkInTime = data.checkInTime;
                if (data.checkOutDate !== undefined) updates.checkOutDate = data.checkOutDate;
                if (data.checkOutTime !== undefined) updates.checkOutTime = data.checkOutTime;
                if (data.noOfNights !== undefined) updates.noOfNights = data.noOfNights;
                if (data.noOfPersons !== undefined) updates.noOfPersons = data.noOfPersons;
                if (data.package !== undefined) updates.package = data.package;

                // Editable Billing Breakdown
                if (data.totalAmount !== undefined) updates.totalAmount = data.totalAmount;
                if (data.advanceAmount !== undefined) updates.advanceAmount = data.advanceAmount;
                if (data.balanceAmount !== undefined) updates.balanceAmount = data.balanceAmount;

                // Editable Room, Activities & Location Details
                if (data.roomNumber !== undefined) updates.roomNumber = data.roomNumber;
                if (data.roomNotes !== undefined) updates.roomNotes = data.roomNotes;
                if (data.riverActivities !== undefined) updates.riverActivities = data.riverActivities;
                if (data.resortAddress !== undefined) updates.resortAddress = data.resortAddress;
                if (data.mapsLocation !== undefined) updates.mapsLocation = data.mapsLocation;
                
                const authUser = getAuthenticatedManager(req);
                if (data.managerName !== undefined) {
                    updates.managerName = data.managerName;
                } else if (authUser && authUser.name) {
                    updates.managerName = authUser.name;
                } else if (!existing.managerName) {
                    updates.managerName = 'Nakul';
                }

                if (data.managerPhone !== undefined) {
                    updates.managerPhone = data.managerPhone;
                } else if (authUser && authUser.phone) {
                    updates.managerPhone = authUser.phone;
                } else if (!existing.managerPhone) {
                    updates.managerPhone = '+91 63611 85700';
                }

                const updated = await dbUpdate(bookingId, updates);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    code: updated.code,
                    booking: updated
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

        // Public API: List Active Managers for Customer Booking Form
    if (pathname === '/api/managers-public' && req.method === 'GET') {
        try {
            const list = await listAllManagers();
            const publicList = list.map(m => ({
                name: m.name,
                phone: m.phone,
                username: m.username
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, managers: publicList }));
        } catch(e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, managers: [
                { name: 'Nakul', phone: '+91 63611 85700', username: 'nakul' }
            ] }));
        }
    }

    // API: Manager Login
    if (pathname === '/api/manager/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const username = (data.username || '').trim().toLowerCase();
                const password = data.password || '';

                const mgr = await findManager(username);
                if (!mgr || mgr.password !== password) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid username or password' }));
                }

                const token = createSession(mgr);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `dvr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
                });
                res.end(JSON.stringify({
                    success: true,
                    user: { username: mgr.username, name: mgr.name, phone: mgr.phone, role: mgr.role }
                }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // API: Manager Logout
    if (pathname === '/api/manager/logout' && req.method === 'POST') {
        deleteSession(req);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'dvr_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        });
        return res.end(JSON.stringify({ success: true }));
    }

    // API: Create Manager (Only Admin Nakul can create another manager)
    if (pathname === '/api/manager/create-manager' && req.method === 'POST') {
        const auth = getAuthenticatedManager(req);
        if (!auth || auth.role !== 'admin') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Access denied: Only Nakul (Admin Manager) can create another manager.' }));
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const username = (data.username || '').trim().toLowerCase();
                const password = (data.password || '').trim();
                const name = (data.name || '').trim();
                const phone = (data.phone || '').trim();

                if (!username || !password || !name || !phone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'All fields (Name, Phone, Username, Password) are required.' }));
                }

                const existing = await findManager(username);
                if (existing) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: `Username "${username}" is already taken.` }));
                }

                const newMgr = await saveNewManager({
                    username,
                    password,
                    name,
                    phone,
                    role: 'manager',
                    createdAt: new Date().toISOString()
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: `Manager "${name}" (${username}) created successfully!`,
                    manager: { username: newMgr.username, name: newMgr.name, phone: newMgr.phone, role: 'manager' }
                }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // API: List Managers (Admin only)
    if (pathname === '/api/manager/list' && req.method === 'GET') {
        const auth = getAuthenticatedManager(req);
        if (!auth || auth.role !== 'admin') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Access denied: Only Nakul (Admin Manager) can view manager list.' }));
        }
        const list = await listAllManagers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, managers: list }));
    }

    // Route: Manager Login Page
    if (pathname === '/manager/login') {
        const auth = getAuthenticatedManager(req);
        if (auth) {
            res.writeHead(302, { 'Location': '/manager' });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Manager Sign In | Dandeli Vintage Resorts</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'sans-serif'],
                        serif: ['Playfair Display', 'serif']
                    },
                    colors: {
                        'theme-gold': '#e6d5b8'
                    }
                }
            }
        };
    </script>
    <style>
        body { font-family: 'Inter', sans-serif; }
    </style>
</head>
<body class="bg-[#0b1710] text-gray-100 min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-md bg-[#0f2417] border border-theme-gold/30 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
        <div class="absolute -top-20 -right-20 w-44 h-44 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div class="absolute -bottom-20 -left-20 w-44 h-44 bg-amber-500/10 rounded-full blur-3xl pointer-events-none"></div>
        
        <div class="text-center mb-6">
            <img src="/vintage_resorts_logo.jpg" onerror="this.src='vintage_resorts_logo.jpg'" alt="Logo" class="w-20 h-20 mx-auto rounded-full object-cover border-2 border-theme-gold/80 shadow-lg ring-4 ring-emerald-900/60 mb-3">
            <h1 class="text-2xl font-serif font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#f7edd9] via-theme-gold to-[#d8be8d]">Dandeli Vintage Resorts</h1>
            <p class="text-xs uppercase tracking-widest text-amber-300 font-extrabold mt-1">Manager Secure Access Desk</p>
            <p class="text-[11px] text-gray-400 mt-0.5">Luxury Feel Affordable Deal</p>
        </div>

        <div id="errorAlert" class="hidden mb-4 p-3 rounded-xl bg-red-950/80 border border-red-500/50 text-red-300 text-xs font-medium flex items-center gap-2">
            <svg class="w-4 h-4 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span id="errorMessage">Invalid credentials</span>
        </div>

        <form id="loginForm" onsubmit="handleLogin(event)" class="space-y-4">
            <div>
                <label for="username" class="block text-xs font-semibold text-gray-300 mb-1.5 uppercase tracking-wider">Username</label>
                <input type="text" id="username" required autocomplete="username" placeholder="e.g. nakul" class="w-full bg-black/50 border border-white/20 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-theme-gold focus:ring-2 focus:ring-theme-gold/20 transition">
            </div>

            <div>
                <label for="password" class="block text-xs font-semibold text-gray-300 mb-1.5 uppercase tracking-wider">Password</label>
                <input type="password" id="password" required autocomplete="current-password" placeholder="Enter password" class="w-full bg-black/50 border border-white/20 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-theme-gold focus:ring-2 focus:ring-theme-gold/20 transition">
            </div>

            <button type="submit" id="submitBtn" class="w-full mt-2 py-3.5 px-4 rounded-xl bg-gradient-to-r from-emerald-600 via-green-600 to-emerald-600 hover:from-emerald-500 hover:to-green-500 text-white font-extrabold text-sm shadow-xl transition-all duration-200 transform hover:-translate-y-0.5 flex items-center justify-center gap-2">
                <span>Sign In to Manager Portal</span>
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
            </button>
        </form>

        <div class="mt-6 pt-4 border-t border-white/10 text-center">
            <a href="/" class="text-xs text-amber-200/70 hover:text-amber-200 transition underline underline-offset-4">← Back to Customer Booking Portal</a>
        </div>
    </div>

    <script>
        async function handleLogin(e) {
            e.preventDefault();
            const btn = document.getElementById('submitBtn');
            const errBox = document.getElementById('errorAlert');
            const errMsg = document.getElementById('errorMessage');
            errBox.classList.add('hidden');

            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;

            btn.disabled = true;
            btn.innerHTML = '<span>Verifying credentials...</span>';

            try {
                const res = await fetch('/api/manager/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.href = '/manager';
                } else {
                    errMsg.textContent = data.error || 'Invalid username or password.';
                    errBox.classList.remove('hidden');
                    btn.disabled = false;
                    btn.innerHTML = '<span>Sign In to Manager Portal</span>';
                }
            } catch (err) {
                errMsg.textContent = 'Connection error. Please try again.';
                errBox.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = '<span>Sign In to Manager Portal</span>';
            }
        }
    </script>
</body>
</html>`);
    }

// Manager Portal Page
    if (pathname === '/manager') {
        const currentUser = getAuthenticatedManager(req);
        if (!currentUser) {
            res.writeHead(302, { 'Location': '/manager/login' });
            return res.end();
        }

        await refreshBookingsCache();
        const allList = Object.values(bookings);
        let bookingsList = allList;

        if (currentUser.role !== 'admin') {
            const userPhoneDigits = (currentUser.phone || '').replace(/\D/g, '').slice(-10);
            const userNameLower = (currentUser.name || '').toLowerCase().trim();
            const userUsername = (currentUser.username || '').toLowerCase().trim();

            bookingsList = allList.filter(b => {
                const bPhoneDigits = (b.managerPhone || '').replace(/\D/g, '').slice(-10);
                const bNameLower = (b.managerName || '').toLowerCase().trim();
                const bUsername = (b.assignedManagerUsername || '').toLowerCase().trim();

                return (userPhoneDigits && bPhoneDigits === userPhoneDigits) ||
                       (bUsername && bUsername === userUsername) ||
                       (userNameLower && bNameLower.includes(userNameLower));
            });
        }
        bookingsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Manager Portal | Dandeli Vintage Resorts</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'sans-serif'],
                        serif: ['Playfair Display', 'serif']
                    },
                    colors: {
                        'theme-gold': '#e6d5b8'
                    }
                }
            }
        };
    </script>
    <style>
        body { font-family: 'Inter', sans-serif; }
        .input-box {
            background-color: rgba(0, 0, 0, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #ffffff;
            border-radius: 0.65rem;
            padding: 0.55rem 0.75rem;
            width: 100%;
            font-size: 0.85rem;
            outline: none;
            transition: all 0.2s ease;
        }
        .input-box:focus {
            border-color: #e6d5b8;
            box-shadow: 0 0 0 2px rgba(230, 213, 184, 0.2);
        }
    
        @media (max-width: 768px) {
            .input-box, input, select, textarea {
                font-size: 16px !important; /* Prevents iOS Safari auto-zoom on manager fields */
                min-height: 40px;
            }
        }
        .overflow-y-auto, .overflow-x-auto {
            -webkit-overflow-scrolling: touch;
        }

    </style>
</head>
<body class="bg-[#0b1710] text-gray-100 min-h-screen">
    <!-- Header -->
    <header class="bg-[#0f2417] border-b border-emerald-900/40 p-3 sm:p-4 sticky top-0 z-30 shadow-xl backdrop-blur-md">
        <div class="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
                <img src="vintage_resorts_logo.jpg" onerror="this.src='/vintage_resorts_logo.jpg';" alt="DVR Logo" class="w-12 h-12 sm:w-14 sm:h-14 rounded-full object-cover border-2 border-theme-gold/70 shadow-md flex-shrink-0 ring-2 ring-emerald-900/50">
                <div class="min-w-0">
                    <h1 class="text-lg sm:text-2xl font-serif font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#f7edd9] via-theme-gold to-[#d8be8d] leading-tight">Dandeli Vintage Resorts</h1>
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                        <span class="text-[11px] text-amber-300 font-extrabold uppercase tracking-widest">Manager Approval Portal</span>
                        <span class="text-gray-500 text-xs hidden sm:inline">•</span>
                        <span class="text-[10px] sm:text-[11px] text-amber-200/80 font-bold uppercase tracking-wider">Luxury Feel Affordable Deal</span>
                    </div>
                    <p class="text-xs text-emerald-400 font-mono flex items-center gap-1.5 mt-0.5">
                        <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-ping"></span>
                        <span>Manager Direct Phone: <strong>${MANAGER_PHONE_FORMATTED}</strong></span>
                    </p>
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <!-- User badge -->
                <div class="px-3 py-1.5 rounded-xl bg-black/40 border border-emerald-700/50 text-xs text-gray-200 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                    <span>${currentUser.name}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${currentUser.role === 'admin' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'}">
                        ${currentUser.role === 'admin' ? '👑 Admin' : '👤 Manager'}
                    </span>
                </div>

                ${currentUser.role === 'admin' ? `
                <!-- Admin Only: Create/Manage Managers button -->
                <button type="button" onclick="openStaffModal()" class="px-3 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white font-bold text-xs shadow-md transition flex items-center gap-1.5">
                    <span>👥 Manage Staff</span>
                </button>
                ` : ''}

                <a href="/" target="_blank" class="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-amber-300 border border-amber-300/30 transition flex items-center gap-1 shadow-sm">
                    <span>Booking Page ↗</span>
                </a>
                <button onclick="location.reload()" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition flex items-center gap-1.5 shadow-sm">
                    <span>↻ Refresh</span>
                </button>
                <button type="button" onclick="logoutManager()" class="px-3 py-2 rounded-xl bg-red-950 hover:bg-red-900 text-red-200 border border-red-800 text-xs font-bold transition flex items-center gap-1 shadow-sm">
                    <span>Sign Out ✕</span>
                </button>
            </div>
        </div>
    </header>

    <main class="max-w-6xl mx-auto p-4 md:p-6">
        <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
                <h2 class="text-xl font-bold text-white">${currentUser.role === 'admin' ? 'All Resort Bookings (Admin Oversight Desk)' : 'My Assigned Guest Bookings & WhatsApp Desk'}</h2>
                <p class="text-xs text-gray-400">${currentUser.role === 'admin' ? 'Admin overview: all guest registrations across all managers. You can review, reassign or verify any booking.' : 'Registrations from guests who contacted you directly. Verify their scanned payment and send approval code from your WhatsApp.'}</p>
            </div>
            <div class="text-xs bg-emerald-950/60 border border-emerald-700/50 rounded-xl px-4 py-2 text-emerald-300">
                ${currentUser.role === 'admin' ? 'Total All Managers: ' : 'My Assigned Bookings: '}<strong class="text-white text-sm">${bookingsList.length}</strong> | Pending: <strong class="text-amber-400 text-sm">${bookingsList.filter(b => b.status !== 'CONFIRMED').length}</strong>
            </div>
        </div>

        ${bookingsList.length === 0 ? `
            <div class="bg-[#122419] border border-white/10 rounded-2xl p-12 text-center">
                <div class="text-4xl mb-3">📋</div>
                <h3 class="text-lg font-bold text-gray-300 mb-1">No Bookings Yet</h3>
                <p class="text-xs text-gray-500">When customers submit bookings on the portal, notifications will appear here and SMS will be sent directly to ${MANAGER_PHONE_FORMATTED}.</p>
            </div>
        ` : `
            <div class="space-y-6">
                ${bookingsList.map(b => {
                    const guestCleanPhone = (b.mobNo || '').replace(/\\D/g, '').slice(-10);
                    const roomVal = b.roomNumber || 'Cottage #101';
                    const notesVal = b.roomNotes || 'AC, River View, King Bed';
                    const addrVal = b.resortAddress || 'Dandeli Vintage Resorts, Near Kali River Bridge, Haliyal Road, Dandeli, Karnataka 581325';
                    const mapsVal = b.mapsLocation || 'https://maps.app.goo.gl/9Dandelikali';
                    const managerPhoneVal = b.managerPhone || '+91 63611 85700';
                    const activitiesVal = b.riverActivities || 'Kali River Rafting, Kayaking, Boating, Jacuzzi Bath, Zorbing, River Crossing';

                    return `
                    <div id="card_${b.id}" class="bg-[#122419] border ${b.status === 'CONFIRMED' ? 'border-emerald-600/50 bg-gradient-to-r from-emerald-950/20 to-[#122419]' : 'border-amber-500/50'} rounded-2xl p-5 md:p-6 shadow-2xl transition">
                        
                        ${currentUser.role === 'admin' ? `
                        <div class="mb-3 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-400/30 text-amber-300 text-xs flex items-center justify-between flex-wrap gap-2">
                            <span>👤 Approached Manager: <strong class="text-white">${b.managerName || 'Nakul'}</strong> (${b.managerPhone || '+91 63611 85700'})</span>
                            <span class="text-[10px] text-gray-400">Assigned for WhatsApp verification</span>
                        </div>
                        ` : ''}
                        
                        <!-- Top Bar: Guest Info & Approval Code -->
                        <div class="flex flex-wrap items-start justify-between gap-4 mb-4 pb-4 border-b border-white/10">
                            <div>
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="text-sm font-mono font-bold text-amber-300">${b.invoiceNumber}</span>
                                    <span id="badge_${b.id}" class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold uppercase tracking-wide ${b.status === 'CONFIRMED' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse'}">
                                        ${b.status === 'CONFIRMED' ? '✓ CONFIRMED' : '⏳ AWAITING PAYMENT VERIFICATION'}
                                    </span>
                                </div>
                                <h3 class="text-xl font-bold text-white flex items-center gap-2">
                                    <span>${b.name}</span>
                                    <span class="text-sm font-semibold text-emerald-400">(+91 ${b.mobNo})</span>
                                </h3>
                                <p class="text-xs text-gray-400 mt-1">Submitted: ${new Date(b.createdAt).toLocaleString('en-IN')}</p>
                            </div>

                            <!-- Big Code Display Box -->
                            <div class="bg-black/60 border-2 border-amber-400/50 rounded-xl p-3 text-center min-w-[200px] shadow-lg">
                                <div class="text-[10px] font-bold text-amber-300 uppercase tracking-widest">Official Approval Code</div>
                                <div class="text-3xl font-mono font-extrabold text-white tracking-widest my-1 text-amber-200">${b.code}</div>
                                <div class="text-[10px] text-gray-400">Sent to guest via WhatsApp text</div>
                            </div>
                        </div>

                        <!-- EDITABLE SECTION 1: GUEST, STAY & TIMING DETAILS -->
                        <div class="bg-black/40 border border-emerald-800/40 rounded-2xl p-4 md:p-5 mb-5 space-y-4">
                            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
                                <h4 class="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-2">
                                    <span>✏️</span>
                                    <span>Editable Stay & Timing Details (Resort Staff can edit before sending)</span>
                                </h4>
                                <span class="text-[11px] text-emerald-400 font-semibold">Changes sync directly into WhatsApp & Invoice</span>
                            </div>

                            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                <!-- Guest Name -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Guest Name:</label>
                                    <input type="text" id="name_${b.id}" value="${b.name || ''}" class="input-box font-bold text-white">
                                </div>

                                <!-- Guest Phone -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Guest Mobile:</label>
                                    <input type="text" id="phone_${b.id}" value="${b.mobNo || ''}" class="input-box font-mono font-bold text-emerald-300">
                                </div>

                                <!-- Package Name -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Package Plan:</label>
                                    <input type="text" id="package_${b.id}" value="${b.package || 'Selected Package'}" class="input-box">
                                </div>

                                <!-- Guests Count -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Guests Count (Persons):</label>
                                    <input type="number" id="guests_${b.id}" value="${b.noOfPersons || 2}" min="1" class="input-box text-center font-bold">
                                </div>
                            </div>

                            <!-- Check-in & Check-out Timing Row -->
                            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs pt-1 border-t border-white/5">
                                <!-- Check-in Date -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Check-in Date:</label>
                                    <input type="date" id="checkInDate_${b.id}" value="${b.checkInDate || ''}" class="input-box text-center font-bold">
                                </div>

                                <!-- Check-in Time (Editable!) -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1 flex items-center justify-between">
                                        <span>Check-in Time:</span>
                                        <span class="text-[10px] text-amber-300">Editable</span>
                                    </label>
                                    <input type="text" id="checkInTime_${b.id}" value="${b.checkInTime || '12:00 PM'}" class="input-box text-center font-bold text-amber-200">
                                    <div class="flex flex-wrap gap-1 mt-1">
                                        <button type="button" onclick="setVal('checkInTime_${b.id}', '11:00 AM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">11 AM</button>
                                        <button type="button" onclick="setVal('checkInTime_${b.id}', '12:00 PM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">12 PM</button>
                                        <button type="button" onclick="setVal('checkInTime_${b.id}', '1:00 PM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">1 PM</button>
                                        <button type="button" onclick="setVal('checkInTime_${b.id}', '2:00 PM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">2 PM</button>
                                    </div>
                                </div>

                                <!-- Check-out Date -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Check-out Date:</label>
                                    <input type="date" id="checkOutDate_${b.id}" value="${b.checkOutDate || ''}" class="input-box text-center font-bold">
                                </div>

                                <!-- Check-out Time (Editable!) -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1 flex items-center justify-between">
                                        <span>Check-out Time:</span>
                                        <span class="text-[10px] text-amber-300">Editable</span>
                                    </label>
                                    <input type="text" id="checkOutTime_${b.id}" value="${b.checkOutTime || '11:00 AM'}" class="input-box text-center font-bold text-amber-200">
                                    <div class="flex flex-wrap gap-1 mt-1">
                                        <button type="button" onclick="setVal('checkOutTime_${b.id}', '10:00 AM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">10 AM</button>
                                        <button type="button" onclick="setVal('checkOutTime_${b.id}', '11:00 AM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">11 AM</button>
                                        <button type="button" onclick="setVal('checkOutTime_${b.id}', '12:00 PM')" class="text-[9px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">12 PM</button>
                                    </div>
                                </div>
                                <!-- Nights -->
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Duration (Nights):</label>
                                    <input type="text" id="nights_${b.id}" value="${b.noOfNights || 1}" class="input-box text-center font-bold">
                                </div>
                            </div>
                        </div>

                        <!-- EDITABLE SECTION 2: BILLING & PAYMENT STATUS -->
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5 text-xs">
                            <div class="bg-black/30 rounded-2xl p-4 border border-white/10 space-y-3">
                                <p class="text-amber-300 font-bold uppercase text-[11px] flex items-center gap-1.5">
                                    <span>💰</span>
                                    <span>Editable Billing Amounts (₹)</span>
                                </p>
                                <div>
                                    <label class="block text-gray-400 text-[11px] mb-1">Total Booking Amount (₹):</label>
                                    <input type="number" id="total_${b.id}" value="${b.totalAmount || 0}" oninput="recalcBalance('${b.id}')" class="input-box font-bold">
                                </div>
                                <div>
                                    <label class="block text-gray-400 text-[11px] mb-1">Advance Paid Deposit (₹):</label>
                                    <input type="number" id="advance_${b.id}" value="${b.advanceAmount || 0}" oninput="recalcBalance('${b.id}')" class="input-box font-bold text-amber-300">
                                </div>
                                <div>
                                    <label class="block text-gray-400 text-[11px] mb-1">Remaining Balance Due (₹):</label>
                                    <input type="number" id="balance_${b.id}" value="${b.balanceAmount || 0}" class="input-box font-bold text-emerald-400">
                                </div>
                            </div>

                            <div class="bg-black/30 rounded-2xl p-4 border border-white/10 flex flex-col justify-between">
                                <div>
                                    <p class="text-gray-300 font-bold uppercase text-[11px] mb-2 flex items-center gap-1.5">
                                        <span>📷</span>
                                        <span>Scanned Payment Proof</span>
                                    </p>
                                    ${b.screenshotUrl ? `
                                        <div class="flex items-center gap-3 mt-1">
                                            <a href="${b.screenshotUrl}" target="_blank" class="block w-20 h-20 rounded-xl overflow-hidden border border-white/20 bg-black flex-shrink-0 group shadow-md">
                                                <img src="${b.screenshotUrl}" alt="Payment Proof" class="w-full h-full object-cover group-hover:scale-105 transition">
                                            </a>
                                            <div class="space-y-1">
                                                <p class="text-xs text-emerald-400 font-bold">✓ Scanned Receipt Attached</p>
                                                <p class="text-[11px] text-gray-400">Review against Advance amount</p>
                                                <a href="${b.screenshotUrl}" target="_blank" class="text-xs text-amber-300 underline font-semibold block">Open Full Size ↗</a>
                                            </div>
                                        </div>
                                    ` : `
                                        <p class="text-xs text-amber-400/80 italic mt-2">No image file attached by guest</p>
                                    `}
                                </div>
                                <div class="mt-3 pt-3 border-t border-white/10 text-[11px] text-gray-400">
                                    Invoice No: <strong class="text-amber-300 font-mono">${b.invoiceNumber}</strong>
                                </div>
                            </div>

                            <div class="bg-black/30 rounded-2xl p-4 border border-white/10 flex flex-col justify-between">
                                <div>
                                    <p class="text-gray-300 font-bold uppercase text-[11px] mb-2">Resort Desk Actions</p>
                                    <p class="text-[11px] text-gray-400 leading-relaxed mb-3">
                                        Resort staff can edit dates, check-in timings, guest counts, and amounts above. Click <strong class="text-emerald-300">"Save Changes"</strong> to update or click <strong class="text-emerald-300">"Send via WhatsApp"</strong> to notify the guest.
                                    </p>
                                </div>
                                <button type="button" onclick="saveBookingChanges('${b.id}')" class="w-full py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-emerald-300 border border-emerald-500/30 font-bold text-xs transition flex items-center justify-center gap-1.5 shadow">
                                    <span>💾 Save Edited Details</span>
                                </button>
                            </div>
                        </div>

                        <!-- ROOM & RESORT LOCATION CUSTOMIZATION SECTION -->
                        <div class="bg-black/40 border border-theme-gold/30 rounded-2xl p-4 md:p-5 mb-5 space-y-4">
                            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
                                <h4 class="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-2">
                                    <span>🏨</span>
                                    <span>Fill Room Details & Resort Location (Included in WhatsApp text)</span>
                                </h4>
                                <span class="text-[11px] text-gray-400">These details are sent directly in the WhatsApp confirmation</span>
                            </div>

                            <!-- Row 1: Room Details -->
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Room / Cottage Number:</label>
                                    <input type="text" id="room_${b.id}" value="${roomVal}" placeholder="e.g. Cottage #104 (River View AC)" class="input-box">
                                    <!-- Quick Suggestions -->
                                    <div class="flex flex-wrap gap-1.5 mt-1.5">
                                        <button type="button" onclick="setVal('room_${b.id}', 'Cottage #101 (AC)')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">Cottage #101</button>
                                        <button type="button" onclick="setVal('room_${b.id}', 'Cottage #102 (Riverfront AC)')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">Riverfront #102</button>
                                        <button type="button" onclick="setVal('room_${b.id}', 'Luxury Tent #201')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">Luxury Tent #201</button>
                                        <button type="button" onclick="setVal('room_${b.id}', 'Family Villa #301')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">Family Villa #301</button>
                                    </div>
                                </div>

                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Room Notes / Features:</label>
                                    <input type="text" id="notes_${b.id}" value="${notesVal}" placeholder="e.g. 1 King Bed, River View, Key at Reception" class="input-box">
                                    <div class="flex flex-wrap gap-1.5 mt-1.5">
                                        <button type="button" onclick="setVal('notes_${b.id}', 'AC Cottage, 1 King Bed, Key at Reception Desk')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">AC King Bed</button>
                                        <button type="button" onclick="setVal('notes_${b.id}', 'Poolside View, Extra Bed Included')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-gray-300 border border-white/10">Poolside View</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Row 2: River Activities Included Input Box -->
                            <div class="text-xs">
                                <label class="block text-gray-300 font-semibold mb-1 flex items-center justify-between">
                                    <span class="flex items-center gap-1.5 text-amber-300">
                                        <span>🚣</span>
                                        <span class="font-bold">River Activities Included in Package:</span>
                                    </span>
                                    <span class="text-[11px] text-gray-400">Click below to quick-add activities</span>
                                </label>
                                <input type="text" id="activities_${b.id}" value="${activitiesVal}" placeholder="e.g. Kali River Rafting, Kayaking, Boating, Jacuzzi Bath, River Crossing, Zorbing" class="input-box">
                                <div class="flex flex-wrap gap-1.5 mt-1.5">
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'Kali River Rafting')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ River Rafting</button>
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'Kayaking')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ Kayaking</button>
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'Boating')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ Boating</button>
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'Natural Jacuzzi Bath')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ Jacuzzi Bath</button>
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'River Crossing')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ River Crossing</button>
                                    <button type="button" onclick="appendActivity('activities_${b.id}', 'Zorbing')" class="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-emerald-300 border border-emerald-500/20">+ Zorbing</button>
                                    <button type="button" onclick="setVal('activities_${b.id}', 'Kali River Rafting, Kayaking, Boating, Natural Jacuzzi Bath, River Crossing, Zorbing')" class="text-[10px] px-2.5 py-0.5 rounded bg-emerald-950 hover:bg-emerald-900 text-amber-300 border border-amber-400/40 font-bold">★ All 6 Activities</button>
                                </div>
                            </div>

                            <!-- Row 3: Resort Location & Manager Info (Name & Phone for Invoice) -->
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Resort Address:</label>
                                    <input type="text" id="address_${b.id}" value="${addrVal}" class="input-box">
                                </div>
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1">Google Maps Location Link:</label>
                                    <input type="text" id="maps_${b.id}" value="${mapsVal}" class="input-box">
                                </div>
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1 flex items-center justify-between">
                                        <span>Resort Manager Name:</span>
                                        <span class="text-amber-300 text-[10px]">On Invoice</span>
                                    </label>
                                    <input type="text" id="managerName_${b.id}" value="${b.managerName || currentUser.name || 'Nakul'}" placeholder="e.g. Nakul" class="input-box font-bold text-amber-200">
                                </div>
                                <div>
                                    <label class="block text-gray-300 font-semibold mb-1 flex items-center justify-between">
                                        <span>Resort Manager Phone:</span>
                                        <span class="text-emerald-400 text-[10px]">On Invoice</span>
                                    </label>
                                    <input type="text" id="managerPhone_${b.id}" value="${b.managerPhone || currentUser.phone || managerPhoneVal}" placeholder="+91 63611 85700" class="input-box font-mono font-bold text-emerald-300">
                                </div>
                            </div>
                        </div>

                        <!-- ACTIONS: SEND VIA WHATSAPP DIRECTLY -->
                        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/10">
                            <div class="text-xs text-gray-300 flex items-center gap-2">
                                <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                                <span>Guest Destination Phone: <strong class="text-white font-mono">+91 ${guestCleanPhone}</strong></span>
                            </div>

                            <div class="flex flex-wrap items-center gap-2">
                                <button type="button" onclick="previewWhatsAppMessage('${b.id}')" class="px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-gray-200 font-semibold text-xs transition flex items-center gap-1.5">
                                    <span>👁️ Preview Text</span>
                                </button>

                                <a href="/?invoice=${b.invoiceNumber}&approve=${b.code}" target="_blank" class="px-3.5 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 font-semibold text-xs border border-amber-400/30 transition flex items-center gap-1.5 shadow-sm">
                                    <span>📄 View Live Invoice ↗</span>
                                </a>

                                <button type="button" onclick="copyWhatsAppMessage('${b.id}')" class="px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-amber-300 font-semibold text-xs border border-amber-300/30 transition flex items-center gap-1.5">
                                    <span>📋 Copy Text</span>
                                </button>

                                <!-- DIRECT WHATSAPP CONFIRMATION SENDER BUTTON -->
                                <button type="button" onclick="sendWhatsAppConfirmation('${b.id}')" class="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 via-green-600 to-emerald-600 hover:from-emerald-500 hover:to-green-500 text-white font-extrabold text-xs shadow-xl transition flex items-center gap-2 transform hover:-translate-y-0.5">
                                    <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                                    <span>Send Confirmation Text with Code via WhatsApp</span>
                                </button>
                            </div>
                        </div>

                    </div>
                    `;
                }).join('')}
            </div>
        `}
    </main>

    <!-- Message Preview Modal -->
    <div id="previewModal" class="fixed inset-0 z-50 flex items-center justify-center hidden">
        <div class="fixed inset-0 bg-black/80 backdrop-blur-sm" onclick="closePreviewModal()"></div>
        <div class="relative bg-[#0d1f14] border border-theme-gold/40 rounded-2xl max-w-lg w-full p-6 z-10 text-xs shadow-2xl mx-4">
            <h3 class="text-sm font-bold text-amber-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <span>📱</span>
                <span>WhatsApp Message Preview for Guest</span>
            </h3>
            <textarea id="previewTextarea" rows="12" class="w-full bg-black/60 border border-white/20 rounded-xl p-3 text-gray-200 font-mono text-xs leading-relaxed" readonly></textarea>
            <div class="flex items-center justify-end gap-2 mt-4">
                <button type="button" onclick="closePreviewModal()" class="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-gray-300">Close</button>
                <button type="button" id="previewSendBtn" class="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Open WhatsApp Now ↗</button>
            </div>
        </div>
    </div>

    <script>
        const bookingsData = ${JSON.stringify(bookings)};

        function appendActivity(id, act) {
            const el = document.getElementById(id);
            if (!el) return;
            if (!el.value.trim()) {
                el.value = act;
            } else if (!el.value.includes(act)) {
                el.value += ', ' + act;
            }
        }

        function setVal(id, val) {
            const el = document.getElementById(id);
            if (el) el.value = val;
        }

        // Recalculate balance when total or advance changes
        function recalcBalance(id) {
            const total = Number(document.getElementById('total_' + id)?.value || 0);
            const advance = Number(document.getElementById('advance_' + id)?.value || 0);
            const balInput = document.getElementById('balance_' + id);
            if (balInput) balInput.value = Math.max(0, total - advance);
        }

        // Build the complete WhatsApp message text using all current editable input fields
        function generateWhatsAppText(id) {
            const b = bookingsData[id];
            if (!b) return '';

            // Read live values from editable inputs
            const name = (document.getElementById('name_' + id)?.value || b.name || 'Valued Guest').trim();
            const phone = (document.getElementById('phone_' + id)?.value || b.mobNo || '').trim();
            const pkg = (document.getElementById('package_' + id)?.value || b.package || 'Selected Package').trim();
            const guests = (document.getElementById('guests_' + id)?.value || b.noOfPersons || 2);
            const checkInDate = (document.getElementById('checkInDate_' + id)?.value || b.checkInDate || '-');
            const checkInTime = (document.getElementById('checkInTime_' + id)?.value || b.checkInTime || '12:00 PM').trim();
            const checkOutDate = (document.getElementById('checkOutDate_' + id)?.value || b.checkOutDate || '-');
            const checkOutTime = (document.getElementById('checkOutTime_' + id)?.value || b.checkOutTime || '11:00 AM').trim();
            const nights = (document.getElementById('nights_' + id)?.value || b.noOfNights || 1);

            const total = Number(document.getElementById('total_' + id)?.value || b.totalAmount || 0);
            const advance = Number(document.getElementById('advance_' + id)?.value || b.advanceAmount || 0);
            const balance = Number(document.getElementById('balance_' + id)?.value || b.balanceAmount || 0);

            const room = (document.getElementById('room_' + id)?.value || b.roomNumber || 'Deluxe Cottage').trim();
            const notes = (document.getElementById('notes_' + id)?.value || b.roomNotes || '').trim();
            const activities = (document.getElementById('activities_' + id)?.value || b.riverActivities || 'Kali River Rafting, Kayaking, Boating, Jacuzzi Bath, Zorbing, River Crossing').trim();
            const address = (document.getElementById('address_' + id)?.value || b.resortAddress || 'Dandeli Vintage Resorts, Near Kali River Bridge, Haliyal Road, Dandeli, Karnataka 581325').trim();
            const maps = (document.getElementById('maps_' + id)?.value || b.mapsLocation || 'https://maps.app.goo.gl/9Dandelikali').trim();
            const managerPhone = (document.getElementById('managerPhone_' + id)?.value || b.managerPhone || '+91 63611 85700').trim();

            const portalUrl = window.location.origin;

            let msg = \`*DANDELI VINTAGE RESORTS — RESERVATION CONFIRMED* ✅\n\n\`;
            msg += \`Dear *\${name}*,\n\`;
            msg += \`We are pleased to confirm that your advance payment has been verified and approved by resort management!\n\n\`;
            
            msg += \`📋 *RESERVATION DETAILS:*\n\`;
            msg += \`• *Invoice No:* \${b.invoiceNumber}\n\`;
            msg += \`• *Guest Name:* \${name}\n\`;
            msg += \`• *No. of Guests:* \${guests} Persons\n\`;
            msg += \`• *Check-in:* \${checkInDate} (\${checkInTime})\n\`;
            msg += \`• *Check-out:* \${checkOutDate} (\${checkOutTime}) (\${nights} Nights)\n\`;
            msg += \`• *Package:* \${pkg}\n\n\`;

            msg += \`🏡 *ASSIGNED ROOM DETAILS:*\n\`;
            msg += \`• *Room / Cottage:* \${room}\n\`;
            if (notes) msg += \`• *Features & Notes:* \${notes}\n\`;
            msg += \`\n\`;

            msg += \`🚣 *RIVER ACTIVITIES INCLUDED:*\n\`;
            msg += \`• \${activities}\n\n\`;

            msg += \`📍 *RESORT LOCATION & CONTACT:*\n\`;
            msg += \`• *Address:* \${address}\n\`;
            msg += \`• *Google Maps Location:* \${maps}\n\`;
            const managerName = (document.getElementById('managerName_' + id)?.value || b.managerName || '${currentUser.name || "Nakul"}').trim();
            msg += \`• *Resort Manager:* \${managerName} (\${managerPhone})\n\n\`;

            msg += \`💰 *BILLING SUMMARY:*\n\`;
            msg += \`• *Total Booking Amount:* ₹\${total.toLocaleString('en-IN')}\n\`;
            msg += \`• *Advance Deposit Paid:* ₹\${advance.toLocaleString('en-IN')} (✅ VERIFIED)\n\`;
            msg += \`• *Remaining Balance Due at Check-in:* ₹\${balance.toLocaleString('en-IN')}\n\n\`;

            msg += \`🔑 *OFFICIAL INVOICE DOWNLOAD CODE:*\n\`;
            msg += \`Your unique verification code is: *\${b.code}*\n\n\`;

            msg += \`👉 *DOWNLOAD YOUR OFFICIAL INVOICE:*\n\`;
            msg += \`Please open the booking portal and enter code *\${b.code}* to download your confirmed invoice voucher with updated stay & room details:\n\`;
            msg += \`\${portalUrl}\n\n\`;

            msg += \`⚠️ *IMPORTANT POLICIES:*\n\`;
            msg += \`• *Cancellation:* Strictly no refund in case of cancellation or no-show.\n\`;
            msg += \`• *Rafting Policy:* River rafting is subject to water levels, weather & safety conditions. If unavailable due to conditions, no separate refund is applicable.\n\n\`;
            msg += \`“Thank you for choosing us! 🌿 We look forward to making your stay unforgettable.”\n\`;
            msg += \`For any assistance, call manager at \${managerPhone}.\`;

            return msg;
        }

        // Preview WhatsApp Text
        function previewWhatsAppMessage(id) {
            const msg = generateWhatsAppText(id);
            const b = bookingsData[id];
            const cleanPhone = (b?.mobNo || '').replace(/\\D/g, '').slice(-10);

            document.getElementById('previewTextarea').value = msg;
            document.getElementById('previewSendBtn').onclick = () => sendWhatsAppConfirmation(id);
            document.getElementById('previewModal').classList.remove('hidden');
        }

        function closePreviewModal() {
            document.getElementById('previewModal').classList.add('hidden');
        }

        // Copy WhatsApp text to clipboard
        async function copyWhatsAppMessage(id) {
            const msg = generateWhatsAppText(id);
            try {
                await navigator.clipboard.writeText(msg);
                alert('✓ WhatsApp message copied to clipboard!');
            } catch(e) {
                const ta = document.createElement('textarea');
                ta.value = msg;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                alert('✓ WhatsApp message copied to clipboard!');
            }
        }

        // Helper: Collect all current edited field values for a booking
        function collectBookingData(id) {
            const b = bookingsData[id] || {};
            return {
                bookingId: id,
                name: (document.getElementById('name_' + id)?.value || b.name || '').trim(),
                mobNo: (document.getElementById('phone_' + id)?.value || b.mobNo || '').trim(),
                package: (document.getElementById('package_' + id)?.value || b.package || '').trim(),
                noOfPersons: (document.getElementById('guests_' + id)?.value || b.noOfPersons || 2),
                checkInDate: (document.getElementById('checkInDate_' + id)?.value || b.checkInDate || ''),
                checkInTime: (document.getElementById('checkInTime_' + id)?.value || b.checkInTime || '12:00 PM').trim(),
                checkOutDate: (document.getElementById('checkOutDate_' + id)?.value || b.checkOutDate || ''),
                checkOutTime: (document.getElementById('checkOutTime_' + id)?.value || b.checkOutTime || '11:00 AM').trim(),
                noOfNights: (document.getElementById('nights_' + id)?.value || b.noOfNights || 1),
                totalAmount: Number(document.getElementById('total_' + id)?.value || b.totalAmount || 0),
                advanceAmount: Number(document.getElementById('advance_' + id)?.value || b.advanceAmount || 0),
                balanceAmount: Number(document.getElementById('balance_' + id)?.value || b.balanceAmount || 0),
                roomNumber: (document.getElementById('room_' + id)?.value || b.roomNumber || 'Deluxe Cottage').trim(),
                roomNotes: (document.getElementById('notes_' + id)?.value || b.roomNotes || '').trim(),
                riverActivities: (document.getElementById('activities_' + id)?.value || b.riverActivities || '').trim(),
                resortAddress: (document.getElementById('address_' + id)?.value || b.resortAddress || '').trim(),
                mapsLocation: (document.getElementById('maps_' + id)?.value || b.mapsLocation || '').trim(),
                managerName: (document.getElementById('managerName_' + id)?.value || b.managerName || '${currentUser.name || "Nakul"}').trim(),
                managerPhone: (document.getElementById('managerPhone_' + id)?.value || b.managerPhone || '${currentUser.phone || "+91 63611 85700"}').trim()
            };
        }

        // Save Edited Booking Changes to Server
        async function saveBookingChanges(id) {
            const payload = collectBookingData(id);
            try {
                const res = await fetch('/api/manager/update-and-confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();
                if (result.success) {
                    bookingsData[id] = result.booking;
                    const badge = document.getElementById('badge_' + id);
                    if (badge) {
                        badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold uppercase tracking-wide bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                        badge.textContent = '✓ CONFIRMED & SAVED';
                    }
                    alert('✓ Booking details successfully saved! Check-in time, dates, billing & room details are updated.');
                } else {
                    alert('Error saving: ' + result.error);
                }
            } catch (err) {
                alert('Network error saving changes: ' + err.message);
            }
        }

        // Send WhatsApp Confirmation with all live edited details
        async function sendWhatsAppConfirmation(id) {
            const b = bookingsData[id];
            if (!b) return alert('Booking record not found');

            const payload = collectBookingData(id);

            // 1. Save all edited details to server
            try {
                const res = await fetch('/api/manager/update-and-confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();
                if (result.success) {
                    bookingsData[id] = result.booking;
                    const badge = document.getElementById('badge_' + id);
                    if (badge) {
                        badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold uppercase tracking-wide bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                        badge.textContent = '✓ CONFIRMED';
                    }
                }
            } catch (err) {
                console.warn('Could not update backend status:', err);
            }

            // 2. Build WhatsApp URL directly targeting the guest
            const cleanPhone = (payload.mobNo || '').replace(/\D/g, '').slice(-10);
            if (!cleanPhone || cleanPhone.length < 10) {
                alert('Guest mobile number is invalid: ' + payload.mobNo);
                return;
            }

            const guestWaPhone = '91' + cleanPhone;
            const msg = generateWhatsAppText(id);
            const whatsappUrl = \`https://wa.me/\${guestWaPhone}?text=\${encodeURIComponent(msg)}\`;

            // 3. Open WhatsApp directly (mobile-safe deep link)
            if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
                window.location.href = whatsappUrl;
            } else {
                window.open(whatsappUrl, '_blank');
            }
            closePreviewModal();
        }
    </script>

    <!-- Staff Management Modal (Admin Nakul Only) -->
    <div id="staffModal" class="fixed inset-0 z-50 flex items-center justify-center hidden">
        <div class="fixed inset-0 bg-black/80 backdrop-blur-sm" onclick="closeStaffModal()"></div>
        <div class="relative bg-[#0d1f14] border border-amber-400/50 rounded-2xl max-w-2xl w-full p-6 z-10 text-xs shadow-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between pb-3 mb-4 border-b border-white/10">
                <div class="flex items-center gap-2">
                    <span class="text-xl">👥</span>
                    <div>
                        <h3 class="text-base font-bold text-amber-300">Staff & Manager Management</h3>
                        <p class="text-[11px] text-gray-400">Admin Control Panel • Only Nakul can create another manager</p>
                    </div>
                </div>
                <button type="button" onclick="closeStaffModal()" class="text-gray-400 hover:text-white p-1 text-sm">✕</button>
            </div>

            <!-- Create Manager Form -->
            <div class="bg-black/50 border border-emerald-800/50 rounded-xl p-4 mb-5">
                <h4 class="text-xs font-bold text-emerald-300 uppercase tracking-wider mb-3">➕ Create New Manager Account</h4>
                <div id="staffAlert" class="hidden mb-3 p-2.5 rounded-lg text-xs font-medium"></div>
                <form id="createManagerForm" onsubmit="handleCreateManager(event)" class="space-y-3">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label class="block text-gray-300 font-semibold mb-1">Full Name *</label>
                            <input type="text" id="newStaffName" required placeholder="e.g. Ramesh Patil" class="input-box">
                        </div>
                        <div>
                            <label class="block text-gray-300 font-semibold mb-1">Mobile Number (On Invoice) *</label>
                            <input type="text" id="newStaffPhone" required placeholder="+91 98765 43210" class="input-box">
                        </div>
                        <div>
                            <label class="block text-gray-300 font-semibold mb-1">Login Username *</label>
                            <input type="text" id="newStaffUsername" required placeholder="e.g. ramesh" class="input-box">
                        </div>
                        <div>
                            <label class="block text-gray-300 font-semibold mb-1">Login Password *</label>
                            <input type="text" id="newStaffPassword" required placeholder="Create password" class="input-box">
                        </div>
                    </div>
                    <div class="flex justify-end pt-1">
                        <button type="submit" id="createStaffBtn" class="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white font-bold rounded-xl shadow transition">
                            Create Manager
                        </button>
                    </div>
                </form>
            </div>

            <!-- List of Current Managers -->
            <div>
                <h4 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2.5 flex items-center justify-between">
                    <span>Active Managers</span>
                    <button type="button" onclick="loadStaffList()" class="text-amber-300 hover:underline text-[11px]">↻ Refresh List</button>
                </h4>
                <div id="staffListTable" class="bg-black/40 border border-white/10 rounded-xl overflow-x-auto">
                    <p class="p-4 text-center text-gray-500 text-xs">Loading manager list...</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function logoutManager() {
            if (!confirm('Are you sure you want to sign out?')) return;
            try {
                await fetch('/api/manager/logout', { method: 'POST' });
                window.location.href = '/manager/login';
            } catch (err) {
                window.location.href = '/manager/login';
            }
        }

        function openStaffModal() {
            document.getElementById('staffModal').classList.remove('hidden');
            loadStaffList();
        }

        function closeStaffModal() {
            document.getElementById('staffModal').classList.add('hidden');
        }

        async function loadStaffList() {
            const container = document.getElementById('staffListTable');
            try {
                const res = await fetch('/api/manager/list');
                const data = await res.json();
                if (data.success && data.managers) {
                    if (data.managers.length === 0) {
                        container.innerHTML = '<p class="p-4 text-center text-gray-400">No managers found.</p>';
                        return;
                    }
                    let rows = '';
                    for (let i = 0; i < data.managers.length; i++) {
                        const m = data.managers[i];
                        const badgeClass = m.role === 'admin' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300';
                        rows += '<tr>' +
                            '<td class="py-2.5 px-3 font-bold text-white">' + m.name + '</td>' +
                            '<td class="py-2.5 px-3 font-mono text-amber-300">' + m.username + '</td>' +
                            '<td class="py-2.5 px-3 font-mono text-emerald-300">' + m.phone + '</td>' +
                            '<td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ' + badgeClass + '">' + m.role + '</span></td>' +
                        '</tr>';
                    }
                    container.innerHTML = '<table class="w-full text-left text-xs">' +
                        '<thead class="bg-white/5 text-gray-400 uppercase text-[10px]">' +
                            '<tr>' +
                                '<th class="py-2 px-3">Name</th>' +
                                '<th class="py-2 px-3">Username</th>' +
                                '<th class="py-2 px-3">Mobile (Invoice)</th>' +
                                '<th class="py-2 px-3">Role</th>' +
                            '</tr>' +
                        '</thead>' +
                        '<tbody class="divide-y divide-white/5">' + rows + '</tbody>' +
                    '</table>';
                } else {
                    container.innerHTML = '<p class="p-3 text-red-400">' + (data.error || 'Failed to load') + '</p>';
                }
            } catch (err) {
                container.innerHTML = '<p class="p-3 text-red-400">Network error loading staff list.</p>';
            }
        }

        async function handleCreateManager(e) {
            e.preventDefault();
            const btn = document.getElementById('createStaffBtn');
            const alertBox = document.getElementById('staffAlert');
            alertBox.classList.add('hidden');

            const name = document.getElementById('newStaffName').value.trim();
            const phone = document.getElementById('newStaffPhone').value.trim();
            const username = document.getElementById('newStaffUsername').value.trim();
            const password = document.getElementById('newStaffPassword').value.trim();

            btn.disabled = true;
            btn.textContent = 'Creating...';

            try {
                const res = await fetch('/api/manager/create-manager', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, phone, username, password })
                });
                const data = await res.json();
                if (data.success) {
                    alertBox.className = 'mb-3 p-2.5 rounded-lg text-xs font-medium bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 block';
                    alertBox.textContent = '✓ ' + data.message;
                    document.getElementById('createManagerForm').reset();
                    loadStaffList();
                } else {
                    alertBox.className = 'mb-3 p-2.5 rounded-lg text-xs font-medium bg-red-950/80 border border-red-500/50 text-red-300 block';
                    alertBox.textContent = data.error || 'Failed to create manager.';
                }
            } catch (err) {
                alertBox.className = 'mb-3 p-2.5 rounded-lg text-xs font-medium bg-red-950/80 border border-red-500/50 text-red-300 block';
                alertBox.textContent = 'Connection error: ' + err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Create Manager';
            }
        }
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
    }

    // Serve Uploaded Files
    if (pathname.startsWith('/uploads/')) {
        const filePath = path.join(BASE_DIR, pathname);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
            return fs.createReadStream(filePath).pipe(res);
        }
    }

    // Serve Static Files from ASSETS_DIR or BASE_DIR
    let relPath = pathname === '/' ? '/dandeli_vintage_resorts_booking.html' : pathname;
    let filePath = path.join(ASSETS_DIR, decodeURIComponent(relPath));

    if (!fs.existsSync(filePath)) {
        filePath = path.join(BASE_DIR, decodeURIComponent(relPath));
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        return fs.createReadStream(filePath).pipe(res);
    }

    // Fallback: 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
});

// Connect to MongoDB, load local fallback, then start server
loadLocalBookings();
connectMongo().then(() => {
    server.listen(PORT, () => {
        console.log(`\n================================================================`);
        console.log(`🌲 Dandeli Vintage Resorts Booking Server Running!`);
        console.log(`🌐 Customer Portal : http://localhost:${PORT}`);
        console.log(`📱 Manager Portal  : http://localhost:${PORT}/manager`);
        console.log(`📲 Manager Mobile  : ${MANAGER_PHONE_FORMATTED} (${MANAGER_PHONE})`);
        console.log(`🍃 Database        : ${mongoConnected ? 'MongoDB Atlas ✅' : 'Local JSON (fallback) ⚠️'}`);
        console.log(`================================================================\n`);
    });
});
