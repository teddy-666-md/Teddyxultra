/**
 * TEDDY-XMD - A WhatsApp Bot
 * © 2026
 */

// --- Environment Setup ---
require('dotenv').config(); // CRITICAL: Load.env variables first

const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const axios = require('axios');
const os = require('os');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay,
    Browsers // FIX 1: ADDED THIS FOR FAKE BROWSER
} = require('@whiskeysockets/baileys');

const NodeCache = require('node-cache');
const pino = require('pino');
const readline = require('readline');
const { rmSync } = require('fs');

// ── Logging ────────────────────────────────────────────────────────────────────

function log(message, color = 'white', isError = false) {
    const prefix = chalk.magenta.bold('[ TEDDY-XMD ]');
    const logFunc = isError? console.error : console.log;
    const colored = chalk[color]? chalk[color](message) : message;
    if (message.includes('\n') || message.includes('════')) {
        logFunc(prefix, colored);
    } else {
        logFunc(`${prefix} ${colored}`);
    }
}

// ── Global flags ───────────────────────────────────────────────────────────────

global.isBotConnected = false;
global.connectDebounceTimeout = null;
global.errorRetryCount = 0;

// ── Deferred requires (loaded after core files are confirmed present) ──────────

let smsg, handleMessages, handleGroupParticipantUpdate, handleStatus, store, settings;

// ── Paths ──────────────────────────────────────

const sessionDir = path.join(__dirname, 'session');
const credsPath = path.join(sessionDir, 'creds.json');
const loginFile = path.join(sessionDir, 'login.json');
const envPath = path.join(process.cwd(), '.env');

// ── Session ID constants ───────────────────────────────────────────────────────

const SESSION_PREFIX = 'TEDDY-XMD:~';

// ── Message backup ─────────────────────────────────────────────────────────────

const MESSAGE_STORE_FILE = path.join(__dirname, 'message_backup.json');
const SESSION_ERROR_FILE = path.join(__dirname, 'sessionErrorCount.json');
global.messageBackup = {};

function loadStoredMessages() {
    try {
        if (fs.existsSync(MESSAGE_STORE_FILE)) {
            return JSON.parse(fs.readFileSync(MESSAGE_STORE_FILE, 'utf-8'));
        }
    } catch (e) {
        log(`Error loading message backup: ${e.message}`, 'red', true);
    }
    return {};
}

function saveStoredMessages(data) {
    try {
        fs.writeFileSync(MESSAGE_STORE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        log(`Error saving message backup: ${e.message}`, 'red', true);
    }
}

global.messageBackup = loadStoredMessages();

// ── Error counter helpers ──────────────────────────────────────────────────────

function loadErrorCount() {
    try {
        if (fs.existsSync(SESSION_ERROR_FILE)) {
            return JSON.parse(fs.readFileSync(SESSION_ERROR_FILE, 'utf-8'));
        }
    } catch (e) {
        log(`Error loading error count: ${e.message}`, 'red', true);
    }
    return { count: 0, last_error_timestamp: 0 };
}

function saveErrorCount(data) {
    try {
        fs.writeFileSync(SESSION_ERROR_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        log(`Error saving error count: ${e.message}`, 'red', true);
    }
}

function deleteErrorCountFile() {
    try {
        if (fs.existsSync(SESSION_ERROR_FILE)) {
            fs.unlinkSync(SESSION_ERROR_FILE);
            log('✅ Deleted sessionErrorCount.json.', 'green');
        }
    } catch (e) {
        log(`Failed to delete sessionErrorCount.json: ${e.message}`, 'red', true);
    }
}

// ── Cleanup helpers ────────────────────────────────────────────────────────────

function clearSessionFiles() {
    try {
        log('[ CLEARING ] session folder...', 'blue');
        rmSync(sessionDir, { recursive: true, force: true });
        if (fs.existsSync(loginFile)) fs.unlinkSync(loginFile);
        deleteErrorCountFile();
        global.errorRetryCount = 0;
        log('[ SESSION ] files cleaned successfully.', 'green');
    } catch (e) {
        log(`Failed to clear session files: ${e.message}`, 'red', true);
    }
}

function cleanupOldMessages() {
    let stored = loadStoredMessages();
    const now = Math.floor(Date.now() / 1000);
    const maxAge = 24 * 60 * 60;
    let cleaned = {};
    for (let chatId in stored) {
        let newChat = {};
        for (let msgId in stored[chatId]) {
            if (now - stored[chatId][msgId].timestamp <= maxAge) {
                newChat[msgId] = stored[chatId][msgId];
            }
        }
        if (Object.keys(newChat).length > 0) cleaned[chatId] = newChat;
    }
    saveStoredMessages(cleaned);
    log('[ MSG CLEANUP ] Old messages removed 🧹', 'green');
}

function cleanupJunkFiles(botSocket) {
    const directoryPath = path.join(__dirname); // FIX: was path.join()
    fs.readdir(directoryPath, async (err, files) => {
        if (err) return log(`[Junk Cleanup] Error reading directory: ${err}`, 'red', true);
        const exts = ['.gif','.png','.mp3','.mp4','.opus','.jpg','.webp','.webm','.zip'];
        const junk = files.filter(f => exts.some(e => f.endsWith(e)));
        if (junk.length > 0) {
            if (botSocket?.user?.id) {
                botSocket.sendMessage(
                    botSocket.user.id.split(':')[0] + '@s.whatsapp.net',
                    { text: `Detected ${junk.length} junk files — deleted 🚮` }
                );
            }
            junk.forEach(file => {
                try { fs.unlinkSync(path.join(directoryPath, file)); } catch (e) {}
            });
            log(`[Junk Cleanup] ${junk.length} files deleted.`, 'yellow');
        }
    });
}

// ── Bot globals ────────────────────────────────────────────────────────────────

global.botname = 'TEDDY-XMD';
global.themeemoji = '•';

// ── Readline ───────────────────────────────────

const rl = process.stdin.isTTY
   ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
const question = (text) =>
    rl
       ? new Promise(resolve => rl.question(text, resolve))
        : Promise.resolve(process.env.OWNER_NUMBER || '');

// ── Login persistence ──────────────────────────────────────────────────────────

async function saveLoginMethod(method) {
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(loginFile, JSON.stringify({ method }, null, 2));
}

async function getLastLoginMethod() {
    if (fs.existsSync(loginFile)) {
        const data = JSON.parse(fs.readFileSync(loginFile, 'utf-8'));
        return data.method;
    }
    return null;
}

function sessionExists() {
    return fs.existsSync(credsPath);
}

// ── SESSION_ID detection & validation ─────────────────────────────────────────

function getRawSessionId() {
    return (process.env.SESSION_ID || '').trim().replace(/^["']|["']$/g, '');
}

function isValidSessionId(id) {
    return typeof id === 'string' && id.startsWith(SESSION_PREFIX) && id.length > SESSION_PREFIX.length + 10;
}

// ── Validate & clean bad SESSION_ID in.env ───────────────────────────────────

async function checkAndHandleSessionFormat() {
    const raw = getRawSessionId();
    if (!raw) return;

    if (!isValidSessionId(raw)) {
        log(chalk.white.bgRed(`[ERROR] Invalid SESSION_ID detected.`), 'white');
        log(chalk.white.bgRed(`SESSION_ID MUST start with "${SESSION_PREFIX}"`), 'white');
        if (fs.existsSync(envPath)) {
            try {
                let content = fs.readFileSync(envPath, 'utf8');
                content = content.replace(/^SESSION_ID=.*$/m, 'SESSION_ID=');
                fs.writeFileSync(envPath, content);
                log('✅ Cleared bad SESSION_ID from.env file.', 'green');
            } catch (e) {
                log(`Could not clean.env file: ${e.message}`, 'red', true);
            }
        }
        log('Bot will exit in 20 seconds...', 'blue');
        await delay(20000);
        process.exit(1);
    }
}

// ── Download / decode session from SESSION_ID ─────────────────────────────────

async function downloadSessionData() {
    try {
        await fs.promises.mkdir(sessionDir, { recursive: true });
        if (fs.existsSync(credsPath)) {
            log('creds.json already present — skipping decode.', 'blue');
            return;
        }
        const id = global.SESSION_ID || getRawSessionId();
        if (!id) {
            log('No SESSION_ID to decode.', 'yellow');
            return;
        }
        const base64 = id.startsWith(SESSION_PREFIX)? id.slice(SESSION_PREFIX.length) : id;
        const decoded = Buffer.from(base64, 'base64');
        await fs.promises.writeFile(credsPath, decoded);
        log(`✅ Session decoded and saved`, 'green');
    } catch (err) {
        log(`Error decoding session data: ${err.message}`, 'red', true);
        throw err;
    }
}

// ── Pairing code ───────────────────────────────────────────────────────────────

async function requestPairingCode(socket) {
    try {
        log('Waiting 3 seconds before requesting pairing code...', 'yellow');
        await delay(3000);
        let code = await socket.requestPairingCode(global.phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        log(chalk.bgGreen.black(`\nYour Pairing Code: ${code}\n`), 'white');
        log(`Open WhatsApp → Settings → Linked Devices → Link a Device`, 'blue');
        return true;
    } catch (err) {
        log(`Failed to get pairing code: ${err.message}`, 'red', true);
        return false;
    }
}

// ── Interactive login menu ─────────────────────────────────────────────────────

async function getLoginMethod() {
    const lastMethod = await getLastLoginMethod();
    if (lastMethod && sessionExists()) {
        log(`Resuming previous login method: ${lastMethod}`, 'blue');
        return lastMethod;
    }
    if (!sessionExists() && fs.existsSync(loginFile)) {
        log('Session missing — removing stale login preference.', 'blue');
        fs.unlinkSync(loginFile);
    }
    if (!process.stdin.isTTY) {
        log('❌ No valid SESSION_ID in environment and no stored session.', 'red');
        process.exit(1);
    }
    log(' Choose login method:', 'blue');
    log(' 1] WhatsApp Number (Pairing Code)', 'blue');
    log(' 2] Paste Session ID', 'blue');
    let choice = (await question('Enter option (1 or 2): ')).trim();
    if (choice === '1') {
        let phone = await question(chalk.bgBlack(chalk.greenBright('Enter your WhatsApp number: ')));
        phone = phone.replace(/\D/g, '');
        global.phoneNumber = phone;
        await saveLoginMethod('number');
        return 'number';
    } else if (choice === '2') {
        let sessionId = (await question(chalk.bgBlack(chalk.greenBright('Paste your Session ID: ')))).trim();
        if (!isValidSessionId(sessionId)) {
            log(`Invalid Session ID.`, 'red');
            process.exit(1);
        }
        global.SESSION_ID = sessionId;
        await saveLoginMethod('session');
        return 'session';
    } else {
        log('Invalid option.', 'red');
        return getLoginMethod();
    }
}

// ── Welcome message ────────────────────────────────────────────────────────────

async function sendWelcomeMessage(XeonBotInc) {
    if (global.isBotConnected) return;
    await delay(10000);
    const detectPlatform = () => {
        if (process.env.DYNO) return '☁️ Heroku';
        if (process.env.RENDER) return '⚡ Render';
        switch (os.platform()) {
            case 'win32': return '🪟 Windows';
            case 'linux': return '🐧 Linux';
            default: return '❓ Unknown';
        }
    };
    try {
        if (!XeonBotInc.user || global.isBotConnected) return;
        global.isBotConnected = true;
        const pNumber = XeonBotInc.user.id.split(':')[0] + '@s.whatsapp.net';
        await XeonBotInc.sendMessage(pNumber, {
            text: `┏━━━━━✧ TEDDY-XMD CONNECTED ✧━━━━━━━\n┃✧ Status: Active ✅\n┗━━━━━━━━━━━━━`
        });
        log('[ BOT ] Successfully connected.', 'green');
        deleteErrorCountFile();
        global.errorRetryCount = 0;
    } catch (e) {
        log(`Error sending welcome message: ${e.message}`, 'red', true);
        global.isBotConnected = false;
    }
}

// ── 408 timeout handler ────────────────────────────────────────────────────────

async function handle408Error(statusCode) {
    if (statusCode!== DisconnectReason.connectionTimeout) return false;
    global.errorRetryCount++;
    const MAX_RETRIES = 3;
    const errorState = loadErrorCount();
    errorState.count = global.errorRetryCount;
    saveErrorCount(errorState);
    log(`Connection timeout (408). Retry ${global.errorRetryCount}/${MAX_RETRIES}`, 'yellow');
    if (global.errorRetryCount >= MAX_RETRIES) {
        log(chalk.white.bgRed(`[MAX TIMEOUTS] Exiting.`), 'white');
        deleteErrorCountFile();
        global.errorRetryCount = 0;
        await delay(5000);
        process.exit(1);
    }
    return true;
}

// ── Session integrity check ────────────────────────────────────────────────────

async function checkSessionIntegrityAndClean() {
    const folderExists = fs.existsSync(sessionDir);
    const credsExists = sessionExists();
    if (folderExists &&!credsExists) {
        log('[ DETECTED ] Incomplete session files.', 'red');
        clearSessionFiles();
        await delay(3000);
    }
}

// ──.env file watcher ─────────────────────────────────────────────────────────

function checkEnvStatus() {
    if (!fs.existsSync(envPath)) return;
    try {
        log('[ WATCHER ] Watching.env for changes...', 'green');
        fs.watch(envPath, { persistent: false }, () => {
            log(chalk.white.bgRed('[ENV].env file changed — restarting...'), 'white');
            process.exit(1);
        });
    } catch (e) {}
}

// ── Main bot socket ────────────────────────────────────────────────────────────

async function startXeonBotInc() {
    log('Connecting to WhatsApp...', 'cyan');
    const { version } = await fetchLatestBaileysVersion();
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const msgRetryCounterCache = new NodeCache();

    const XeonBotInc = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'), // FIX 2: FAKE CHROME TO AVOID HEROKU BAN
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000, // FIX 3: LONGER TIMEOUT
        keepAliveIntervalMs: 10000, // FIX 4: KEEP ALIVE
        getMessage: async (key) => {
            if(!store) return '';
            const jid = jidNormalizedUser(key.remoteJid);
            const msg = await store.loadMessage(jid, key.id);
            return msg?.message || '';
        },
        msgRetryCounterCache,
    });

    if(store) store.bind(XeonBotInc.ev); // FIX 5: CHECK STORE EXISTS

    XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
        for (const msg of chatUpdate.messages) {
            if (!msg.message) continue;
            const chatId = msg.key.remoteJid;
            const messageId = msg.key.id;
            if (!global.messageBackup[chatId]) global.messageBackup[chatId] = {};
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
            if (!text) continue;
            if (!global.messageBackup[chatId][messageId]) {
                global.messageBackup[chatId][messageId] = {
                    sender: msg.key.participant || msg.key.remoteJid,
                    text,
                    timestamp: msg.messageTimestamp,
                };
                saveStoredMessages(global.messageBackup);
            }
        }
        const mek = chatUpdate.messages[0];
        if (mek.key.remoteJid === 'status@broadcast') {
            await handleStatus(XeonBotInc, chatUpdate);
            return;
        }
        if (!mek.message) return;
        mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage')? mek.message.ephemeralMessage.message : mek.message;
        try { await handleMessages(XeonBotInc, chatUpdate, true); }
        catch (e) { log(e.message, 'red', true); }
    });

    XeonBotInc.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            global.isBotConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const permanentLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            if (permanentLogout) {
                log(chalk.bgRed.black(`\n💥 Logged out (status ${statusCode}). Clearing session...`), 'red');
                clearSessionFiles();
                await delay(5000);
                process.exit(1);
            } else {
                const is408 = await handle408Error(statusCode);
                if (is408) return;
                log(`Temporary disconnect (status ${statusCode}). Reconnecting in 3s...`, 'yellow');
                await delay(3000);
                startXeonBotInc();
            }
        } else if (connection === 'open') {
            log('TEDDY-XMD BOT CONNECTED ✅', 'green');
            await sendWelcomeMessage(XeonBotInc);
        }
    });

    XeonBotInc.ev.on('creds.update', saveCreds);

    XeonBotInc.ev.on('group-participants.update', async (update) => {
        try { await handleGroupParticipantUpdate(XeonBotInc, update); }
        catch (e) { log(`Group update error: ${e.message}`, 'red', true); }
    });

    XeonBotInc.public = true;
    XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store);

    setInterval(() => {
        if (!fs.existsSync(sessionDir)) return;
        fs.readdir(sessionDir, (err, files) => {
            if (err) return;
            const now = Date.now();
            const stale = files.filter(f => {
                const filePath = path.join(sessionDir, f);
                try {
                    const stats = fs.statSync(filePath);
                    return (f.startsWith('pre-key') || f.startsWith('sender-key') || f.startsWith('session-') || f.startsWith('app-state')) && f!== 'creds.json' && now - stats.mtimeMs > 2 * 24 * 60 * 60 * 1000;
                } catch (_) { return false; }
            });
            stale.forEach(f => { try { fs.unlinkSync(path.join(sessionDir, f)); } catch (_) {} });
        });
    }, 7200000);

    setInterval(cleanupOldMessages, 60 * 60 * 1000);
    setInterval(() => cleanupJunkFiles(XeonBotInc), 30_000);
    return XeonBotInc;
}

// ── Main entry point ───────────────────────────────────────────────────────────

async function tylor() {
    try {
        require('./settings');
        const mainModules = require('./main');
        handleMessages = mainModules.handleMessages;
        handleGroupParticipantUpdate = mainModules.handleGroupParticipantUpdate;
        handleStatus = mainModules.handleStatus;
        const myfuncModule = require('./lib/myfunc');
        smsg = myfuncModule.smsg;
        store = require('./lib/lightweight_store');
        settings = require('./settings');
        store.readFromFile();
        setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);
        log('✨ Core files loaded.', 'green');
    } catch (e) {
        log(`FATAL: Failed to load core files: ${e.message}`, 'red', true);
        process.exit(1);
    }

    await checkAndHandleSessionFormat();
    global.errorRetryCount = loadErrorCount().count;
    log(`Initial 408 retry count: ${global.errorRetryCount}`, 'yellow');

    const envSessionID = getRawSessionId();
    if (isValidSessionId(envSessionID)) {
        log(`✅ Valid SESSION_ID found (prefix: ${SESSION_PREFIX}).`, 'magenta');
        clearSessionFiles();
        global.SESSION_ID = envSessionID;
        await downloadSessionData();
        await saveLoginMethod('session');
        log('Session written. Starting bot in 3 seconds...', 'green');
        await delay(3000);
        await startXeonBotInc();
        checkEnvStatus();
        return;
    }
    await checkSessionIntegrityAndClean();
    if (sessionExists()) {
        log('✅ Valid stored session found. Starting bot...', 'green');
        await delay(3000);
        await startXeonBotInc();
        checkEnvStatus();
        return;
    }
    log('No session found. Starting interactive login...', 'blue');
    const loginMethod = await getLoginMethod();
    let XeonBotInc;
    if (loginMethod === 'session') {
        await downloadSessionData();
        XeonBotInc = await startXeonBotInc();
    } else if (loginMethod === 'number') {
        XeonBotInc = await startXeonBotInc();
        await requestPairingCode(XeonBotInc);
    }
    if (loginMethod === 'number' &&!sessionExists() && fs.existsSync(sessionDir)) {
        log('Login interrupted — clearing temporary session files.', 'red');
        clearSessionFiles();
        process.exit(1);
    }
    checkEnvStatus();
}

// ── Express web server ────────────────────────────────────────────────────────────

const express = require('express');
const _app = express();
const PORT = process.env.PORT || 5000;

_app.get('/', (req, res) => {
    res.send('<h1>TEDDY XMD WhatsApp Bot is running ✅</h1>');
});

_app.listen(PORT, '0.0.0.0', () => {
    log(`✅ Web server listening on port ${PORT}`, 'green');
});

// ── Boot ───────────────────────────────────────────────────────────────────────

tylor().catch(err => log(`Fatal error starting bot: ${err.message}`, 'red', true));
process.on('uncaughtException', err => log(`Uncaught Exception: ${err.message}`, 'red', true));
process.on('unhandledRejection', err => log(`Unhandled Rejection: ${err?.message}`, 'red', true));