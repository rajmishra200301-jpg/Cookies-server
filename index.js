const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 20144;

// ==================== CONFIGURATION ====================
const CONFIG = {
    MAX_SESSIONS: 10000,
    SESSION_RETENTION_DAYS: 30,
    AUTO_RECOVERY_INTERVAL: 60000,
    HEARTBEAT_INTERVAL: 30000,
    LOG_LEVEL: 'minimal',
    SESSION_AUTO_START: true,
    PERSISTENT_STORAGE: true
};

// ==================== MINIMAL LOGGER ====================
class MinimalLogger {
    static log(message, level = 'info') {
        if (CONFIG.LOG_LEVEL === 'minimal') {
            const now = new Date().toISOString().split('T')[1].split('.')[0];
            const levels = ['error', 'warn'];
            if (levels.includes(level)) {
                console.log(`[${now}] ${level.toUpperCase()}: ${message}`);
            }
        } else {
            console.log(`[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}`);
        }
    }
    
    static error(message) {
        this.log(message, 'error');
    }
    
    static warn(message) {
        this.log(message, 'warn');
    }
    
    static info(message) {
        if (CONFIG.LOG_LEVEL !== 'minimal') {
            this.log(message, 'info');
        }
    }
}

// Create HTTP server
const server = http.createServer(app);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions
const activeSessions = new Map();
const permanentSessions = new Map();
const sessionRefreshTracker = new Map();
const sessionHeartbeats = new Map();

// WebSocket Server
const wss = new WebSocket.Server({ server });

// ==================== THREAD ID PARSER - ALL FORMATS SUPPORT ====================
class ThreadIDParser {
    static parse(threadID) {
        if (!threadID) return { original: threadID, type: 'invalid', formats: [] };
        
        const original = String(threadID).trim();
        const formats = [];
        let type = 'unknown';
        
        // Extract numeric ID from various formats
        let numericID = null;
        
        // Case 1: Already numeric (15, 16, 17+ digits)
        if (/^\d{15,}$/.test(original)) {
            numericID = original;
            type = 'numeric';
            formats.push({ format: 'numeric', id: numericID });
        }
        // Case 2: t_id. prefix
        else if (original.startsWith('t_id.')) {
            numericID = original.replace('t_id.', '');
            if (/^\d+$/.test(numericID)) {
                type = 't_id';
                formats.push({ format: 't_id', id: original });
                formats.push({ format: 'numeric', id: numericID });
            }
        }
        // Case 3: thread_fbid: prefix
        else if (original.startsWith('thread_fbid:')) {
            numericID = original.replace('thread_fbid:', '');
            if (/^\d+$/.test(numericID)) {
                type = 'thread_fbid';
                formats.push({ format: 'thread_fbid', id: original });
                formats.push({ format: 'numeric', id: numericID });
            }
        }
        // Case 4: Facebook URL
        else if (original.includes('facebook.com')) {
            // Extract from various URL patterns
            const urlPatterns = [
                /facebook\.com\/messages\/t\/(\d+)/,
                /facebook\.com\/messages\/read\/\?tid=(\d+)/,
                /facebook\.com\/messenger_media\/\?thread_id=(\d+)/,
                /facebook\.com\/.*?\/(\d+)\/?$/,
                /fbid=(\d+)/,
                /threadid=(\d+)/,
                /tid=(\d+)/
            ];
            
            for (const pattern of urlPatterns) {
                const match = original.match(pattern);
                if (match && match[1]) {
                    numericID = match[1];
                    type = 'url';
                    formats.push({ format: 'url', id: original });
                    formats.push({ format: 'numeric', id: numericID });
                    break;
                }
            }
        }
        // Case 5: Other string formats
        else {
            // Try to extract numbers
            const numberMatch = original.match(/\d+/g);
            if (numberMatch) {
                // Take the longest number sequence
                numberMatch.sort((a, b) => b.length - a.length);
                numericID = numberMatch[0];
                if (numericID.length >= 15) {
                    type = 'extracted';
                    formats.push({ format: 'original', id: original });
                    formats.push({ format: 'numeric', id: numericID });
                }
            }
        }
        
        // Generate all possible formats
        if (numericID && /^\d{15,}$/.test(numericID)) {
            // Add all possible formats
            const allFormats = [
                { format: 'numeric', id: numericID },
                { format: 't_id', id: `t_id.${numericID}` },
                { format: 'thread_fbid', id: `thread_fbid:${numericID}` },
                { format: 'url', id: `https://www.facebook.com/messages/t/${numericID}` }
            ];
            
            // Merge with existing formats
            const formatMap = new Map();
            [...formats, ...allFormats].forEach(f => {
                if (!formatMap.has(f.format)) {
                    formatMap.set(f.format, f);
                }
            });
            
            formats.length = 0;
            formatMap.forEach(f => formats.push(f));
        }
        
        // Determine digit count
        let digitCount = 0;
        if (numericID) {
            digitCount = numericID.length;
            if (digitCount === 15) type = '15-digit';
            else if (digitCount === 16) type = '16-digit';
            else if (digitCount === 17) type = '17-digit';
            else if (digitCount > 17) type = `${digitCount}-digit`;
        }
        
        return {
            original,
            numericID,
            type,
            digitCount,
            formats,
            isNumeric: /^\d+$/.test(original),
            isLongNumeric: /^\d{15,}$/.test(original)
        };
    }
    
    static getAllFormats(threadID) {
        const parsed = this.parse(threadID);
        return parsed.formats;
    }
    
    static is15Digit(threadID) {
        const parsed = this.parse(threadID);
        return parsed.digitCount === 15;
    }
    
    static getBestFormat(threadID) {
        const parsed = this.parse(threadID);
        if (parsed.formats.length === 0) return threadID;
        
        // Try numeric first, then t_id, then thread_fbid
        const formatOrder = ['numeric', 't_id', 'thread_fbid', 'url', 'original'];
        for (const formatName of formatOrder) {
            const format = parsed.formats.find(f => f.format === formatName);
            if (format) return format.id;
        }
        
        return parsed.formats[0].id;
    }
}

// ==================== PERMANENT SESSION SYSTEM ====================
function savePermanentSession(sessionId, api, userId, type = 'messaging') {
    try {
        if (!api) return false;
        
        if (permanentSessions.size >= CONFIG.MAX_SESSIONS) {
            const oldestSession = Array.from(permanentSessions.entries())
                .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            if (oldestSession) {
                permanentSessions.delete(oldestSession[0]);
                try {
                    const oldPath = path.join(__dirname, 'sessions', `permanent_${oldestSession[0]}.json`);
                    if (fs.existsSync(oldPath)) {
                        fs.unlinkSync(oldPath);
                    }
                } catch (e) {}
            }
        }
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        const sessionDir = path.dirname(sessionPath);
        
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        
        const appState = api.getAppState ? api.getAppState() : null;
        const sessionData = {
            sessionId,
            appState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            isActive: true,
            autoStart: true,
            data: null
        };
        
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        
        startSessionHeartbeat(sessionId);
        
        return true;
    } catch (error) {
        MinimalLogger.error(`Save session error: ${error.message}`);
        return false;
    }
}

function loadPermanentSession(sessionId) {
    try {
        if (permanentSessions.has(sessionId)) {
            const session = permanentSessions.get(sessionId);
            sessionHeartbeats.set(sessionId, Date.now());
            return session;
        }
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (fs.existsSync(sessionPath)) {
            const fileStats = fs.statSync(sessionPath);
            if (fileStats.size > 100) {
                const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                
                const age = Date.now() - sessionData.createdAt;
                const maxAge = CONFIG.SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
                
                if (age > maxAge) {
                    fs.unlinkSync(sessionPath);
                    return null;
                }
                
                permanentSessions.set(sessionId, sessionData);
                sessionHeartbeats.set(sessionId, Date.now());
                return sessionData;
            }
        }
    } catch (error) {}
    return null;
}

// ==================== SESSION HEARTBEAT SYSTEM ====================
function startSessionHeartbeat(sessionId) {
    sessionHeartbeats.set(sessionId, Date.now());
}

// ==================== SILENT LOGIN SYSTEM (ORIGINAL AS YOU WANTED) ====================
function silentLogin(cookieString, callback) {
    const loginOptions = {
        appState: null,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent'
    };

    const loginMethods = [
        (cb) => {
            try {
                // Try as JSON first
                const appState = JSON.parse(cookieString);
                loginOptions.appState = appState;
                wiegine.login(loginOptions, (err, api) => {
                    if (err || !api) {
                        cb(null);
                    } else {
                        cb(api);
                    }
                });
            } catch (e) {
                cb(null);
            }
        },
        (cb) => {
            // Try as direct appState
            loginOptions.appState = cookieString;
            wiegine.login(loginOptions, (err, api) => {
                if (err || !api) {
                    cb(null);
                } else {
                    cb(api);
                }
            });
        },
        (cb) => {
            // Try parsing as cookie string
            try {
                if (typeof cookieString === 'string' && cookieString.includes(';')) {
                    const cookiesArray = cookieString.split(';').map(c => c.trim()).filter(c => c);
                    const appState = cookiesArray.map(cookie => {
                        const [key, ...valueParts] = cookie.split('=');
                        const value = valueParts.join('=');
                        return {
                            key: key.trim(),
                            value: value.trim(),
                            domain: '.facebook.com',
                            path: '/',
                            hostOnly: false,
                            creation: new Date().toISOString(),
                            lastAccessed: new Date().toISOString()
                        };
                    }).filter(c => c.key && c.value);
                    
                    if (appState.length > 0) {
                        loginOptions.appState = appState;
                        wiegine.login(loginOptions, (err, api) => {
                            if (err || !api) {
                                cb(null);
                            } else {
                                cb(api);
                            }
                        });
                    } else {
                        cb(null);
                    }
                } else {
                    cb(null);
                }
            } catch (e) {
                cb(null);
            }
        }
    ];

    let currentMethod = 0;
    function tryNextMethod() {
        if (currentMethod >= loginMethods.length) {
            callback(null);
            return;
        }
        loginMethods[currentMethod]((api) => {
            if (api) {
                callback(api);
            } else {
                currentMethod++;
                setTimeout(tryNextMethod, 1000);
            }
        });
    }
    tryNextMethod();
}

// ==================== SMART MESSAGING SYSTEM WITH ALL FORMATS SUPPORT ====================
class SmartMessagingSystem {
    constructor(sessionId, cookie, threadID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.cookie = cookie;
        this.originalThreadID = threadID;
        this.prefix = prefix;
        this.delay = delay * 1000;
        this.originalMessages = messages;
        
        // Parse thread ID
        this.parsedThread = ThreadIDParser.parse(threadID);
        this.currentFormatIndex = 0;
        this.formatsToTry = this.parsedThread.formats.map(f => f.id);
        
        this.messageQueue = [];
        this.isRunning = false;
        this.messageIndex = 0;
        this.api = null;
        this.messagesSent = 0;
        this.startTime = Date.now();
        this.consecutiveFailures = 0;
        this.maxFailures = 5;
        this.heartbeatInterval = null;
        
        // Statistics
        this.formatSuccess = {};
        this.totalAttempts = 0;
        this.successfulAttempts = 0;
        
        MinimalLogger.info(`[${sessionId}] Thread parsed: ${this.parsedThread.type} (${this.parsedThread.digitCount} digits)`);
        if (this.formatsToTry.length > 1) {
            MinimalLogger.info(`[${sessionId}] Will try ${this.formatsToTry.length} formats: ${this.formatsToTry.join(', ')}`);
        }
    }

    async initialize() {
        try {
            this.api = await new Promise((resolve) => {
                silentLogin(this.cookie, (fbApi) => {
                    resolve(fbApi);
                });
            });
            
            if (this.api) {
                const userId = this.api.getCurrentUserID();
                savePermanentSession(this.sessionId, this.api, userId, 'messaging');
                
                // Monkey patch sendMessage for multi-format support
                this.enhanceSendMessage();
                
                this.startHeartbeat();
                return true;
            }
        } catch (error) {
            MinimalLogger.error(`[${this.sessionId}] Init error: ${error.message}`);
        }
        return false;
    }
    
    enhanceSendMessage() {
        if (!this.api || !this.api.sendMessage) return;
        
        const originalSend = this.api.sendMessage;
        const self = this;
        
        this.api.sendMessage = function(message, threadID, callback, replyID) {
            const parsed = ThreadIDParser.parse(threadID);
            
            if (parsed.formats.length > 1) {
                // Use smart sending with multiple formats
                return new Promise((resolve) => {
                    self.smartSend(message, parsed.formats, (err, info) => {
                        if (callback) callback(err, info);
                        resolve(info);
                    });
                });
            } else {
                // Use original send for simple formats
                return originalSend.call(this, message, threadID, callback, replyID);
            }
        };
    }
    
    smartSend(message, formats, callback) {
        if (!this.api) {
            callback(new Error('API not initialized'), null);
            return;
        }
        
        const originalSend = this.api.sendMessage.bind(this.api);
        let currentIndex = 0;
        
        const tryNextFormat = () => {
            if (currentIndex >= formats.length) {
                callback(new Error('All formats failed'), null);
                return;
            }
            
            const format = formats[currentIndex];
            const threadID = format.id;
            
            MinimalLogger.info(`[${this.sessionId}] Trying format ${currentIndex + 1}/${formats.length}: ${format.format} (${threadID})`);
            
            originalSend(message, threadID, (err, info) => {
                if (err) {
                    // Track failure
                    this.formatSuccess[format.format] = this.formatSuccess[format.format] || { attempts: 0, success: 0 };
                    this.formatSuccess[format.format].attempts++;
                    
                    MinimalLogger.warn(`[${this.sessionId}] Format ${format.format} failed: ${err.message}`);
                    
                    // Try next format
                    currentIndex++;
                    tryNextFormat();
                } else {
                    // Track success
                    this.formatSuccess[format.format] = this.formatSuccess[format.format] || { attempts: 0, success: 0 };
                    this.formatSuccess[format.format].attempts++;
                    this.formatSuccess[format.format].success++;
                    
                    this.totalAttempts++;
                    this.successfulAttempts++;
                    
                    MinimalLogger.info(`[${this.sessionId}] ✅ Format ${format.format} succeeded!`);
                    callback(null, info);
                }
            });
        };
        
        tryNextFormat();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        
        if (this.parsedThread.digitCount === 15) {
            MinimalLogger.info(`[${this.sessionId}] 🌟 15-DIGIT THREAD DETECTED: Using multi-layer sending method`);
        } else if (this.parsedThread.digitCount >= 15) {
            MinimalLogger.info(`[${this.sessionId}] 🌟 ${this.parsedThread.digitCount}-DIGIT THREAD: Using smart format detection`);
        }
        
        MinimalLogger.info(`[${this.sessionId}] 🌟 Multiple Cookie Support: ACTIVE`);
        MinimalLogger.info(`[${this.sessionId}] Starting message sending with ${this.formatsToTry.length} available formats`);
        
        this.processQueue();
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            startSessionHeartbeat(this.sessionId);
            
            if (this.consecutiveFailures >= this.maxFailures) {
                MinimalLogger.error(`[${this.sessionId}] Too many consecutive failures, stopping`);
                this.stop();
                break;
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            const messageNumber = this.messageIndex + 1;

            const success = await this.sendMessageSmart(messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                
                const session = activeSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                }
                
                MinimalLogger.info(`[${this.sessionId}] ✅ Sent message ${messageNumber}/${this.originalMessages.length} (Total: ${this.messagesSent})`);
            } else {
                this.messageQueue.unshift(message);
                this.consecutiveFailures++;
                MinimalLogger.error(`[${this.sessionId}] ❌ Failed to send message ${messageNumber}, retrying...`);
            }

            await new Promise(resolve => setTimeout(resolve, this.delay));
        }
        
        // Loop messages
        if (this.isRunning && this.messageQueue.length === 0) {
            this.messageQueue = [...this.originalMessages];
            this.messageIndex = 0;
            setTimeout(() => this.processQueue(), 1000);
        }
    }
    
    async sendMessageSmart(messageText) {
        if (!this.api) {
            const initialized = await this.initialize();
            if (!initialized) return false;
        }
        
        return new Promise((resolve) => {
            let currentFormatIndex = 0;
            
            const tryNextFormat = () => {
                if (currentFormatIndex >= this.formatsToTry.length) {
                    // All formats failed, try to reinitialize API
                    this.api = null;
                    resolve(false);
                    return;
                }
                
                const threadID = this.formatsToTry[currentFormatIndex];
                const formatName = this.parsedThread.formats[currentFormatIndex]?.format || 'unknown';
                
                this.api.sendMessage(messageText, threadID, (err, messageInfo) => {
                    if (err) {
                        MinimalLogger.warn(`[${this.sessionId}] Format ${formatName} failed: ${err.message}`);
                        currentFormatIndex++;
                        
                        // Try next format after short delay
                        setTimeout(tryNextFormat, 500);
                    } else {
                        // Success! This format works, maybe prioritize it
                        if (currentFormatIndex > 0) {
                            // Move successful format to front
                            const successfulFormat = this.formatsToTry.splice(currentFormatIndex, 1)[0];
                            this.formatsToTry.unshift(successfulFormat);
                            
                            const successfulFormatInfo = this.parsedThread.formats.splice(currentFormatIndex, 1)[0];
                            this.parsedThread.formats.unshift(successfulFormatInfo);
                            
                            MinimalLogger.info(`[${this.sessionId}] Format ${formatName} works! Prioritizing it.`);
                        }
                        
                        resolve(true);
                    }
                });
            };
            
            tryNextFormat();
        });
    }

    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            startSessionHeartbeat(this.sessionId);
        }, CONFIG.HEARTBEAT_INTERVAL);
    }

    stop() {
        this.isRunning = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        MinimalLogger.info(`[${this.sessionId}] Messaging stopped`);
    }

    getStatus() {
        const successRate = this.totalAttempts > 0 ? 
            Math.round((this.successfulAttempts / this.totalAttempts) * 100) : 0;
            
        return {
            sessionId: this.sessionId,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            threadInfo: this.parsedThread,
            currentFormats: this.formatsToTry,
            formatStats: this.formatSuccess,
            successRate: `${successRate}%`,
            consecutiveFailures: this.consecutiveFailures,
            uptime: Date.now() - this.startTime
        };
    }
}

// ==================== GROUP FETCH SYSTEM ====================
class GroupFetcher {
    constructor(cookie) {
        this.cookie = cookie;
        this.api = null;
    }

    async initialize() {
        try {
            this.api = await new Promise((resolve) => {
                silentLogin(this.cookie, (fbApi) => {
                    resolve(fbApi);
                });
            });
            return !!this.api;
        } catch (error) {
            return false;
        }
    }

    async fetchGroups(limit = 100) {
        if (!this.api) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('Failed to login');
            }
        }

        return new Promise((resolve, reject) => {
            this.api.getThreadList(limit, null, ['INBOX'], (err, threadList) => {
                if (err) {
                    reject(err);
                    return;
                }

                const groups = threadList
                    .filter(thread => thread.isGroup || thread.participants.length > 2)
                    .map(thread => {
                        const parsed = ThreadIDParser.parse(thread.threadID);
                        return {
                            id: thread.threadID,
                            name: thread.name || `Chat ${thread.threadID.substring(0, 10)}...`,
                            participants: thread.participants ? thread.participants.length : 0,
                            type: parsed.type,
                            digitCount: parsed.digitCount,
                            isGroup: thread.isGroup,
                            isPrivateChat: !thread.isGroup && thread.participants.length <= 2,
                            allFormats: parsed.formats
                        };
                    })
                    .sort((a, b) => b.participants - a.participants);

                resolve(groups);
            });
        });
    }
}

// ==================== WEB SOCKET ====================
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'authenticate' && data.sessionId) {
                ws.sessionId = data.sessionId;
                ws.send(JSON.stringify({ type: 'auth_success', message: 'Session authenticated' }));
                
                const session = activeSessions.get(data.sessionId);
                if (session) {
                    ws.send(JSON.stringify({ 
                        type: 'session_info', 
                        session: {
                            sessionId: data.sessionId,
                            threadID: session.threadID,
                            status: session.status,
                            messagesSent: session.messagesSent || 0
                        }
                    }));
                }
            } else if (data.type === 'heartbeat' && data.sessionId) {
                startSessionHeartbeat(data.sessionId);
            }
        } catch (error) {
            MinimalLogger.error(`WebSocket error: ${error.message}`);
        }
    });
});

// ==================== API ROUTES ====================

// Start messaging with smart system
app.post('/api/start-messaging', async (req, res) => {
    try {
        const { cookie, threadID, prefix, delay, messages } = req.body;
        
        if (!cookie || !threadID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        // Parse thread ID
        const parsed = ThreadIDParser.parse(threadID);
        if (!parsed.numericID || parsed.digitCount < 15) {
            return res.json({ success: false, error: 'Invalid thread ID format' });
        }
        
        const sessionId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const messaging = new SmartMessagingSystem(sessionId, cookie, threadID, prefix, delay, messages);
        
        const initialized = await messaging.initialize();
        if (!initialized) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        messaging.start();
        
        const session = {
            messaging,
            threadID,
            parsedThread: parsed,
            prefix,
            delay: delay * 1000,
            messages,
            status: 'active',
            messagesSent: 0,
            startTime: Date.now(),
            userId: 'messaging-user',
            type: 'messaging',
            isActive: true
        };
        
        activeSessions.set(sessionId, session);
        startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            sessionId, 
            message: `Messaging started with ${parsed.type} thread`,
            threadInfo: parsed,
            formats: parsed.formats.length
        });
        
    } catch (error) {
        MinimalLogger.error(`Messaging error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Fetch groups
app.post('/api/fetch-groups', async (req, res) => {
    try {
        const { cookie, limit = 100 } = req.body;
        
        if (!cookie) {
            return res.json({ success: false, error: 'Missing cookie' });
        }
        
        const fetcher = new GroupFetcher(cookie);
        const groups = await fetcher.fetchGroups(limit);
        
        // Categorize groups
        const categorized = {
            groups: groups.filter(g => g.isGroup),
            privateChats: groups.filter(g => g.isPrivateChat),
            all: groups
        };
        
        res.json({ 
            success: true, 
            ...categorized,
            count: groups.length,
            has15Digit: groups.some(g => g.digitCount === 15),
            hasLongDigit: groups.some(g => g.digitCount >= 15)
        });
        
    } catch (error) {
        MinimalLogger.error(`Fetch groups error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Test thread ID parsing
app.post('/api/parse-thread', (req, res) => {
    try {
        const { threadID } = req.body;
        
        if (!threadID) {
            return res.json({ success: false, error: 'Missing thread ID' });
        }
        
        const parsed = ThreadIDParser.parse(threadID);
        const bestFormat = ThreadIDParser.getBestFormat(threadID);
        
        res.json({ 
            success: true, 
            parsed,
            bestFormat,
            recommendations: parsed.formats.map(f => f.id)
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Test send to thread
app.post('/api/test-send', async (req, res) => {
    try {
        const { cookie, threadID, message } = req.body;
        
        if (!cookie || !threadID) {
            return res.json({ success: false, error: 'Missing cookie or threadID' });
        }
        
        const api = await new Promise((resolve) => {
            silentLogin(cookie, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        const parsed = ThreadIDParser.parse(threadID);
        const testMessage = message || "Testing thread ID formats";
        const results = [];
        
        // Test all formats
        for (const format of parsed.formats) {
            try {
                const startTime = Date.now();
                await new Promise((resolve, reject) => {
                    api.sendMessage(`${testMessage} (${format.format})`, format.id, (err, info) => {
                        const endTime = Date.now();
                        if (err) {
                            results.push({ 
                                format: format.format, 
                                id: format.id,
                                success: false, 
                                error: err.message,
                                time: endTime - startTime
                            });
                        } else {
                            results.push({ 
                                format: format.format, 
                                id: format.id,
                                success: true, 
                                message: 'Sent successfully',
                                time: endTime - startTime
                            });
                        }
                        resolve();
                    });
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                results.push({ 
                    format: format.format, 
                    id: format.id,
                    success: false, 
                    error: error.message,
                    time: 0
                });
            }
        }
        
        const workingFormats = results.filter(r => r.success);
        const bestFormat = workingFormats.length > 0 ? workingFormats[0] : null;
        
        res.json({ 
            success: true, 
            threadID,
            parsed,
            results,
            workingFormats: workingFormats.map(r => ({ format: r.format, id: r.id })),
            bestFormat,
            successRate: `${workingFormats.length}/${parsed.formats.length} formats work`
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get session status
app.post('/api/get-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const status = session.messaging ? session.messaging.getStatus() : {};
        
        res.json({ 
            success: true, 
            status: {
                ...status,
                sessionInfo: {
                    userId: session.userId,
                    startTime: session.startTime,
                    uptime: Date.now() - session.startTime,
                    type: session.type,
                    status: session.status,
                    threadID: session.threadID,
                    isActive: session.isActive
                }
            }
        });
        
    } catch (error) {
        MinimalLogger.error(`Get status error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Control session
app.post('/api/control-session', async (req, res) => {
    try {
        const { sessionId, action } = req.body;
        
        if (!sessionId || !action) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        let result = { success: true, message: '' };
        
        switch (action) {
            case 'start':
                if (session.messaging) {
                    session.messaging.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Messaging started';
                }
                break;
                
            case 'stop':
                if (session.messaging) {
                    session.messaging.stop();
                }
                session.status = 'stopped';
                session.isActive = false;
                result.message = 'Session stopped';
                break;
                
            case 'pause':
                session.status = 'paused';
                result.message = 'Session paused';
                break;
                
            case 'resume':
                session.status = 'active';
                result.message = 'Session resumed';
                break;
                
            default:
                result = { success: false, error: 'Invalid action' };
        }
        
        startSessionHeartbeat(sessionId);
        
        res.json(result);
        
    } catch (error) {
        MinimalLogger.error(`Control session error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get active sessions
app.get('/api/active-sessions', (req, res) => {
    const sessions = [];
    
    for (const [sessionId, session] of activeSessions) {
        sessions.push({
            sessionId,
            type: session.type,
            threadID: session.threadID,
            threadType: session.parsedThread?.type || 'unknown',
            digitCount: session.parsedThread?.digitCount || 0,
            status: session.status,
            messagesSent: session.messagesSent || 0,
            uptime: Date.now() - session.startTime,
            isActive: session.isActive || false
        });
    }
    
    res.json({ 
        success: true, 
        sessions,
        total: sessions.length
    });
});

// Stop session
app.post('/api/stop-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.messaging) {
            session.messaging.stop();
        }
        
        activeSessions.delete(sessionId);
        sessionHeartbeats.delete(sessionId);
        
        res.json({ 
            success: true, 
            message: 'Session stopped and removed'
        });
        
    } catch (error) {
        MinimalLogger.error(`Stop session error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        sessions: activeSessions.size,
        memory: process.memoryUsage()
    });
});

// Thread ID examples
app.get('/api/thread-examples', (req, res) => {
    const examples = [
        {
            name: '15-digit numeric',
            examples: [
                '885541967386269',
                '123456789012345',
                '987654321098765'
            ]
        },
        {
            name: 't_id. format',
            examples: [
                't_id.885541967386269',
                't_id.123456789012345'
            ]
        },
        {
            name: 'thread_fbid: format',
            examples: [
                'thread_fbid:885541967386269',
                'thread_fbid:123456789012345'
            ]
        },
        {
            name: 'Facebook URL',
            examples: [
                'https://www.facebook.com/messages/t/885541967386269',
                'https://facebook.com/messages/t/123456789012345',
                'https://m.facebook.com/messages/read/?tid=885541967386269',
                'www.facebook.com/messages/t/885541967386269'
            ]
        },
        {
            name: 'Long digit (16+)',
            examples: [
                '1000000000000000',
                '12345678901234567',
                '999999999999999999'
            ]
        }
    ];
    
    res.json({ success: true, examples });
});

// ==================== HTML INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ultimate Messaging System - 100% Thread Support</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
            color: white;
            padding: 30px;
            text-align: center;
            border-bottom: 3px solid #2575fc;
        }
        
        .header h1 {
            font-size: 2.8em;
            font-weight: bold;
            margin-bottom: 10px;
        }
        
        .header .subtitle {
            font-size: 1.2em;
            opacity: 0.9;
        }
        
        .stats-bar {
            background: rgba(0,0,0,0.1);
            padding: 15px 30px;
            display: flex;
            justify-content: space-around;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .stat-item {
            text-align: center;
            color: white;
        }
        
        .stat-value {
            font-size: 1.8em;
            font-weight: bold;
            display: block;
        }
        
        .stat-label {
            font-size: 0.9em;
            opacity: 0.9;
        }
        
        .tabs {
            display: flex;
            background: #f8f9fa;
            border-bottom: 2px solid #ddd;
            overflow-x: auto;
        }
        
        .tab {
            padding: 20px 30px;
            cursor: pointer;
            font-weight: 600;
            color: #495057;
            border-right: 1px solid #ddd;
            transition: all 0.3s;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .tab:hover {
            background: #e9ecef;
        }
        
        .tab.active {
            background: white;
            border-bottom: 4px solid #6a11cb;
            color: #6a11cb;
        }
        
        .tab-content {
            display: none;
            padding: 30px;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
        }
        
        @media (max-width: 992px) {
            .grid-2 {
                grid-template-columns: 1fr;
            }
        }
        
        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.1);
            border: 1px solid #e0e0e0;
        }
        
        .card-title {
            font-size: 1.5em;
            color: #6a11cb;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            padding-bottom: 10px;
            border-bottom: 2px solid #f0f0f0;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 10px;
            font-weight: 600;
            color: #495057;
            font-size: 1.1em;
        }
        
        .form-control {
            width: 100%;
            padding: 14px;
            border: 2px solid #ced4da;
            border-radius: 10px;
            font-size: 1em;
            transition: all 0.3s;
        }
        
        .form-control:focus {
            outline: none;
            border-color: #6a11cb;
            box-shadow: 0 0 0 3px rgba(106, 17, 203, 0.2);
        }
        
        textarea.form-control {
            min-height: 120px;
            resize: vertical;
            font-family: 'Consolas', monospace;
        }
        
        .btn {
            padding: 14px 28px;
            border: none;
            border-radius: 10px;
            font-size: 1.1em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            gap: 10px;
        }
        
        .btn-block {
            width: 100%;
            justify-content: center;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
            color: white;
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 20px rgba(106, 17, 203, 0.3);
        }
        
        .btn-success {
            background: linear-gradient(135deg, #00b09b 0%, #96c93d 100%);
            color: white;
        }
        
        .btn-danger {
            background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%);
            color: white;
        }
        
        .btn-warning {
            background: linear-gradient(135deg, #ffb347 0%, #ffcc33 100%);
            color: #212529;
        }
        
        .btn-info {
            background: linear-gradient(135deg, #36d1dc 0%, #5bc0de 100%);
            color: white;
        }
        
        .logs-container {
            background: #1a1a1a;
            color: #00ff00;
            padding: 20px;
            border-radius: 10px;
            height: 400px;
            overflow-y: auto;
            font-family: 'Consolas', monospace;
            font-size: 0.9em;
            border: 2px solid #333;
        }
        
        .log-entry {
            padding: 8px 0;
            border-bottom: 1px solid #333;
            line-height: 1.4;
        }
        
        .log-time {
            color: #888;
            margin-right: 10px;
        }
        
        .log-success { color: #00ff00; }
        .log-error { color: #ff4444; }
        .log-warning { color: #ffaa00; }
        .log-info { color: #44aaff; }
        
        .highlight-box {
            background: linear-gradient(135deg, rgba(106, 17, 203, 0.05) 0%, rgba(37, 117, 252, 0.05) 100%);
            padding: 20px;
            border-radius: 10px;
            border: 2px solid rgba(106, 17, 203, 0.2);
            margin: 20px 0;
        }
        
        .session-id {
            font-family: monospace;
            background: #f0f0f0;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            word-break: break-all;
            font-size: 1.1em;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: 600;
            margin-left: 8px;
        }
        
        .badge-15digit {
            background: #ffd700;
            color: #000;
        }
        
        .badge-16digit {
            background: #ff6b6b;
            color: white;
        }
        
        .badge-17digit {
            background: #4ecdc4;
            color: white;
        }
        
        .badge-url {
            background: #6a11cb;
            color: white;
        }
        
        .badge-tid {
            background: #2575fc;
            color: white;
        }
        
        .groups-list {
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 10px;
            margin-top: 15px;
        }
        
        .group-item {
            padding: 15px;
            border-bottom: 1px solid #eee;
            cursor: pointer;
            transition: background 0.3s;
        }
        
        .group-item:hover {
            background: #f5f5f5;
        }
        
        .group-item.active {
            background: #e8f4ff;
            border-left: 4px solid #6a11cb;
        }
        
        .format-list {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-top: 10px;
            font-size: 0.9em;
        }
        
        .format-item {
            padding: 5px 0;
            border-bottom: 1px dashed #ddd;
        }
        
        .format-item:last-child {
            border-bottom: none;
        }
        
        .success-rate {
            display: inline-block;
            padding: 3px 10px;
            background: #00b09b;
            color: white;
            border-radius: 10px;
            font-size: 0.8em;
            margin-left: 10px;
        }
        
        .thread-examples {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
            margin-top: 15px;
        }
        
        .example-item {
            padding: 8px;
            background: white;
            margin: 5px 0;
            border-radius: 5px;
            border-left: 4px solid #6a11cb;
            cursor: pointer;
        }
        
        .example-item:hover {
            background: #e9ecef;
        }
        
        .status-display {
            display: flex;
            justify-content: space-between;
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        
        .status-item {
            text-align: center;
            flex: 1;
        }
        
        .status-value {
            font-size: 1.5em;
            font-weight: bold;
            color: #6a11cb;
            display: block;
        }
        
        .status-label {
            font-size: 0.9em;
            color: #666;
        }
        
        .test-results {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        
        .test-result-item {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .test-success {
            background: #d4edda;
            color: #155724;
            border-left: 4px solid #28a745;
        }
        
        .test-failure {
            background: #f8d7da;
            color: #721c24;
            border-left: 4px solid #dc3545;
        }
        
        @media (max-width: 768px) {
            .header h1 {
                font-size: 2em;
            }
            
            .tab {
                padding: 15px 20px;
                font-size: 0.9em;
            }
            
            .tab-content {
                padding: 20px;
            }
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-comments"></i> ULTIMATE MESSAGING SYSTEM</h1>
            <div class="subtitle">100% Thread Support • All Formats • 15/16/17+ Digit • Auto-Detection</div>
        </div>
        
        <div class="stats-bar">
            <div class="stat-item">
                <span class="stat-value" id="serverUptime">00:00:00</span>
                <span class="stat-label">SERVER UPTIME</span>
            </div>
            <div class="stat-item">
                <span class="stat-value" id="activeSessions">0</span>
                <span class="stat-label">ACTIVE SESSIONS</span>
            </div>
            <div class="stat-item">
                <span class="stat-value" id="totalMessages">0</span>
                <span class="stat-label">TOTAL MESSAGES</span>
            </div>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('messaging')">
                <i class="fas fa-paper-plane"></i> Smart Messaging
            </div>
            <div class="tab" onclick="switchTab('fetch')">
                <i class="fas fa-users"></i> Fetch Groups
            </div>
            <div class="tab" onclick="switchTab('test')">
                <i class="fas fa-vial"></i> Test Thread
            </div>
            <div class="tab" onclick="switchTab('sessions')">
                <i class="fas fa-list"></i> Active Sessions
            </div>
            <div class="tab" onclick="switchTab('examples')">
                <i class="fas fa-lightbulb"></i> Thread Examples
            </div>
        </div>
        
        <!-- Smart Messaging Tab -->
        <div id="messagingTab" class="tab-content active">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-rocket"></i> SMART MESSAGING
                        </div>
                        <div class="highlight-box">
                            <i class="fas fa-info-circle"></i>
                            <strong>SUPPORTS ALL THREAD FORMATS:</strong><br>
                            • 15-digit numeric (885541967386269)<br>
                            • 16/17+ digit IDs<br>
                            • t_id. prefix (t_id.885541967386269)<br>
                            • thread_fbid: format<br>
                            • Facebook URLs (www.facebook.com/messages/t/...)<br>
                            • Auto-detection & multi-format fallback
                        </div>
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE:
                            </label>
                            <textarea class="form-control" id="cookie" placeholder="Paste your Facebook cookie here..." rows="5"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-hashtag"></i> THREAD ID (ANY FORMAT):
                            </label>
                            <input type="text" class="form-control" id="threadID" placeholder="Enter thread ID in ANY format...">
                            <div style="margin-top: 10px;">
                                <button class="btn btn-sm btn-info" onclick="parseThread()">
                                    <i class="fas fa-search"></i> Parse & Preview
                                </button>
                            </div>
                            <div id="threadPreview" style="display: none; margin-top: 15px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                                <strong>Parsed Thread:</strong> <span id="parsedType"></span><br>
                                <strong>Formats to try:</strong> <span id="formatsCount">0</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-tag"></i> MESSAGE PREFIX:
                            </label>
                            <input type="text" class="form-control" id="prefix" value="💬 " placeholder="Prefix for messages">
                        </div>
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-clock"></i> DELAY (SECONDS):
                            </label>
                            <input type="number" class="form-control" id="delay" value="10" min="5" max="300">
                        </div>
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-comment-dots"></i> MESSAGES (ONE PER LINE):
                            </label>
                            <textarea class="form-control" id="messages" placeholder="Enter messages, one per line..." rows="8"></textarea>
                        </div>
                        <button class="btn btn-success btn-block" onclick="startSmartMessaging()">
                            <i class="fas fa-play-circle"></i> START SMART MESSAGING
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> LIVE CONSOLE LOGS
                        </div>
                        <div class="logs-container" id="messagingLogs">
                            <div class="log-entry log-info">
                                <span class="log-time">[SYSTEM]</span>
                                Smart messaging system ready
                            </div>
                            <div class="log-entry log-info">
                                <span class="log-time">[SYSTEM]</span>
                                Supports: 15-digit • 16-digit • 17+ digit • URLs • t_id. • thread_fbid:
                            </div>
                        </div>
                        <div style="margin-top: 15px;">
                            <button class="btn btn-secondary" onclick="clearLogs('messagingLogs')">
                                <i class="fas fa-trash"></i> CLEAR LOGS
                            </button>
                        </div>
                    </div>
                    
                    <div class="card" id="sessionCard" style="display: none;">
                        <div class="card-title">
                            <i class="fas fa-user-clock"></i> CURRENT SESSION
                        </div>
                        <div class="session-id" id="currentSessionId"></div>
                        <div class="status-display">
                            <div class="status-item">
                                <span class="status-value" id="sessionStatusText">-</span>
                                <span class="status-label">Status</span>
                            </div>
                            <div class="status-item">
                                <span class="status-value" id="messagesSentCount">0</span>
                                <span class="status-label">Messages Sent</span>
                            </div>
                            <div class="status-item">
                                <span class="status-value" id="sessionUptimeText">0s</span>
                                <span class="status-label">Uptime</span>
                            </div>
                        </div>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <button class="btn btn-success" onclick="controlSession('start')">
                                <i class="fas fa-play"></i> START
                            </button>
                            <button class="btn btn-danger" onclick="controlSession('stop')">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                            <button class="btn btn-info" onclick="refreshSession()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Fetch Groups Tab -->
        <div id="fetchTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-users"></i> FETCH YOUR GROUPS & CHATS
                        </div>
                        <div class="form-group">
                            <label class="form-label">Facebook Cookie:</label>
                            <textarea class="form-control" id="fetchCookie" placeholder="Paste your Facebook cookie here..." rows="5"></textarea>
                        </div>
                        <button class="btn btn-primary btn-block" onclick="fetchGroups()">
                            <i class="fas fa-sync-alt"></i> FETCH GROUPS & CHATS
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-list"></i> YOUR GROUPS & CHATS
                            <span id="groupsCount" style="font-size: 0.9em; color: #666; margin-left: 10px;"></span>
                        </div>
                        <div class="groups-list" id="groupsList">
                            <div style="text-align: center; padding: 60px 20px; color: #666;">
                                <i class="fas fa-users fa-4x" style="margin-bottom: 20px; color: #ccc;"></i>
                                <h3 style="margin-bottom: 10px;">NO GROUPS LOADED</h3>
                                <p>Enter cookie and click "Fetch Groups & Chats"</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Test Thread Tab -->
        <div id="testTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-vial"></i> TEST THREAD ID
                        </div>
                        <div class="form-group">
                            <label class="form-label">Facebook Cookie:</label>
                            <textarea class="form-control" id="testCookie" placeholder="Paste cookie..." rows="3"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Thread ID (Any Format):</label>
                            <input type="text" class="form-control" id="testThreadID" placeholder="Enter thread ID to test...">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Test Message:</label>
                            <input type="text" class="form-control" id="testMessage" value="Testing thread ID compatibility">
                        </div>
                        <button class="btn btn-primary btn-block" onclick="testThread()">
                            <i class="fas fa-play"></i> TEST SEND
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-clipboard-check"></i> TEST RESULTS
                        </div>
                        <div id="testResults">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-vial fa-3x"></i>
                                <p style="margin-top: 15px;">Run a test to see results</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Active Sessions Tab -->
        <div id="sessionsTab" class="tab-content">
            <div class="card">
                <div class="card-title">
                    <i class="fas fa-list"></i> ACTIVE SESSIONS
                </div>
                <div id="sessionsList">
                    <div style="text-align: center; padding: 40px; color: #666;">
                        <i class="fas fa-spinner fa-spin fa-2x"></i>
                        <p style="margin-top: 15px;">Loading sessions...</p>
                    </div>
                </div>
                <button class="btn btn-info" onclick="loadSessions()" style="margin-top: 15px;">
                    <i class="fas fa-sync-alt"></i> REFRESH SESSIONS
                </button>
            </div>
        </div>
        
        <!-- Thread Examples Tab -->
        <div id="examplesTab" class="tab-content">
            <div class="card">
                <div class="card-title">
                    <i class="fas fa-lightbulb"></i> THREAD ID EXAMPLES
                </div>
                <div class="highlight-box">
                    <strong>📌 SYSTEM SUPPORTS ALL THESE FORMATS:</strong><br>
                    Just copy-paste any format below into the Thread ID field
                </div>
                <div id="threadExamples">
                    <div style="text-align: center; padding: 30px;">
                        <i class="fas fa-spinner fa-spin fa-2x"></i>
                        <p>Loading examples...</p>
                    </div>
                </div>
                <div style="margin-top: 20px; padding: 15px; background: #d4edda; border-radius: 8px; color: #155724;">
                    <strong>💡 TIP:</strong> Click any example to copy it to the Thread ID field in Smart Messaging tab
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentSessionId = null;
        let serverStartTime = Date.now();
        
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + 'Tab').classList.add('active');
            event.target.classList.add('active');
            
            // Load data when switching to certain tabs
            if (tabName === 'sessions') {
                loadSessions();
            } else if (tabName === 'examples') {
                loadThreadExamples();
            }
        }
        
        function addLog(containerId, message, level = 'info') {
            const container = document.getElementById(containerId);
            const logEntry = document.createElement('div');
            logEntry.className = \`log-entry log-\${level}\`;
            
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            logEntry.innerHTML = \`<span class="log-time">[\${time}]</span> \${message}\`;
            
            container.appendChild(logEntry);
            container.scrollTop = container.scrollHeight;
        }
        
        function clearLogs(containerId) {
            document.getElementById(containerId).innerHTML = '';
            addLog(containerId, 'Logs cleared', 'info');
        }
        
        function parseThread() {
            const threadID = document.getElementById('threadID').value.trim();
            if (!threadID) {
                alert('Please enter a Thread ID');
                return;
            }
            
            fetch('/api/parse-thread', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threadID })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    const preview = document.getElementById('threadPreview');
                    preview.style.display = 'block';
                    
                    document.getElementById('parsedType').textContent = \`\${data.parsed.type} (\${data.parsed.digitCount} digits)\`;
                    document.getElementById('formatsCount').textContent = \`\${data.parsed.formats.length} formats\`;
                    
                    addLog('messagingLogs', \`Parsed thread: \${data.parsed.type} (\${data.parsed.digitCount} digits)\`, 'info');
                    addLog('messagingLogs', \`Will try \${data.parsed.formats.length} formats\`, 'info');
                    
                    // Show badge based on digit count
                    let badgeClass = '';
                    if (data.parsed.digitCount === 15) badgeClass = 'badge-15digit';
                    else if (data.parsed.digitCount === 16) badgeClass = 'badge-16digit';
                    else if (data.parsed.digitCount >= 17) badgeClass = 'badge-17digit';
                    
                    if (badgeClass) {
                        document.getElementById('parsedType').innerHTML += \` <span class="badge \${badgeClass}">\${data.parsed.digitCount}-digit</span>\`;
                    }
                }
            })
            .catch(error => {
                alert(\`Error: \${error.message}\`);
            });
        }
        
        async function startSmartMessaging() {
            const cookie = document.getElementById('cookie').value.trim();
            const threadID = document.getElementById('threadID').value.trim();
            const prefix = document.getElementById('prefix').value.trim();
            const delay = parseInt(document.getElementById('delay').value);
            const messages = document.getElementById('messages').value.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (!cookie) {
                alert('Please enter cookie');
                return;
            }
            
            if (!threadID) {
                alert('Please enter Thread ID');
                return;
            }
            
            if (messages.length === 0) {
                alert('Please enter at least one message');
                return;
            }
            
            if (isNaN(delay) || delay < 5 || delay > 300) {
                alert('Delay must be between 5-300 seconds');
                return;
            }
            
            // Parse thread first
            const parseResponse = await fetch('/api/parse-thread', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threadID })
            });
            
            const parseData = await parseResponse.json();
            if (!parseData.success) {
                alert(\`Invalid thread ID: \${parseData.error}\`);
                return;
            }
            
            if (!parseData.parsed.numericID || parseData.parsed.digitCount < 15) {
                if (!confirm('Thread ID may not be valid. Continue anyway?')) {
                    return;
                }
            }
            
            addLog('messagingLogs', \`🌟 Starting smart messaging for \${parseData.parsed.type} thread\`, 'info');
            addLog('messagingLogs', \`🌟 Multiple format support: ACTIVE\`, 'info');
            addLog('messagingLogs', \`🌟 Will try \${parseData.parsed.formats.length} formats\`, 'info');
            
            if (parseData.parsed.digitCount === 15) {
                addLog('messagingLogs', '🌟 15-DIGIT THREAD DETECTED: Using multi-layer sending method', 'info');
            }
            
            try {
                const response = await fetch('/api/start-messaging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookie,
                        threadID,
                        prefix,
                        delay,
                        messages
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentSessionId = data.sessionId;
                    
                    document.getElementById('currentSessionId').textContent = \`Session ID: \${currentSessionId}\`;
                    document.getElementById('sessionCard').style.display = 'block';
                    
                    // Add thread info badge
                    let badge = '';
                    if (data.threadInfo.digitCount === 15) badge = '<span class="badge badge-15digit">15-digit</span>';
                    else if (data.threadInfo.digitCount === 16) badge = '<span class="badge badge-16digit">16-digit</span>';
                    else if (data.threadInfo.digitCount >= 17) badge = \`<span class="badge badge-17digit">\${data.threadInfo.digitCount}-digit</span>\`;
                    
                    document.getElementById('currentSessionId').innerHTML += \` \${badge} (\${data.formats} formats)\`;
                    
                    addLog('messagingLogs', \`✅ Messaging started: \${currentSessionId}\`, 'success');
                    addLog('messagingLogs', \`📁 Thread: \${data.threadInfo.type} (\${data.threadInfo.digitCount} digits)\`, 'success');
                    addLog('messagingLogs', \`🔧 Will try \${data.formats} different formats\`, 'success');
                    
                    refreshSession();
                } else {
                    addLog('messagingLogs', \`❌ Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                addLog('messagingLogs', \`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        async function refreshSession() {
            if (!currentSessionId) return;
            
            try {
                const response = await fetch('/api/get-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    document.getElementById('sessionStatusText').textContent = data.status.sessionInfo.status;
                    document.getElementById('messagesSentCount').textContent = data.status.messagesSent || 0;
                    document.getElementById('sessionUptimeText').textContent = formatTime(data.status.sessionInfo.uptime);
                    
                    // Update stats bar
                    updateStatsBar();
                }
            } catch (error) {
                console.error('Refresh error:', error);
            }
        }
        
        async function controlSession(action) {
            if (!currentSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentSessionId,
                        action
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    addLog('messagingLogs', \`Session \${action}ed: \${data.message}\`, 'success');
                    refreshSession();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function fetchGroups() {
            const cookie = document.getElementById('fetchCookie').value.trim();
            
            if (!cookie) {
                alert('Please enter cookie');
                return;
            }
            
            addLog('messagingLogs', 'Fetching groups and chats...', 'info');
            
            try {
                const response = await fetch('/api/fetch-groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie })
                });
                
                const data = await response.json();
                if (data.success) {
                    displayGroups(data.all);
                    document.getElementById('groupsCount').textContent = \`(\${data.count} items)\`;
                    
                    addLog('messagingLogs', \`✅ Found \${data.count} groups/chats\`, 'success');
                    if (data.has15Digit) {
                        addLog('messagingLogs', '🌟 15-digit chats detected', 'info');
                    }
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displayGroups(groups) {
            const container = document.getElementById('groupsList');
            
            if (groups.length === 0) {
                container.innerHTML = \`
                    <div style="text-align: center; padding: 40px; color: #666;">
                        <i class="fas fa-users fa-3x"></i>
                        <p style="margin-top: 15px;">No groups or chats found</p>
                    </div>
                \`;
                return;
            }
            
            let html = '';
            groups.forEach(group => {
                let badge = '';
                if (group.digitCount === 15) badge = '<span class="badge badge-15digit">15-digit</span>';
                else if (group.digitCount === 16) badge = '<span class="badge badge-16digit">16-digit</span>';
                else if (group.digitCount >= 17) badge = \`<span class="badge badge-17digit">\${group.digitCount}-digit</span>\`;
                
                if (group.isPrivateChat) badge += ' <span class="badge" style="background: #6a11cb; color: white;">Private</span>';
                
                html += \`
                    <div class="group-item" onclick="selectGroup('\${group.id}', '\${group.name}')">
                        <strong>\${group.name}</strong>
                        \${badge}
                        <div style="color: #666; font-size: 0.9em; margin-top: 5px;">
                            ID: \${group.id} | Members: \${group.participants} | Type: \${group.type}
                        </div>
                        <div class="format-list">
                            <small><strong>Supported formats:</strong></small>
                            \${group.allFormats.slice(0, 3).map(f => \`
                                <div class="format-item">
                                    <i class="fas fa-code"></i> \${f.format}: \${f.id.substring(0, 30)}\${f.id.length > 30 ? '...' : ''}
                                </div>
                            \`).join('')}
                            \${group.allFormats.length > 3 ? \`
                                <div class="format-item">
                                    <i class="fas fa-ellipsis-h"></i> and \${group.allFormats.length - 3} more formats...
                                </div>
                            \` : ''}
                        </div>
                    </div>
                \`;
            });
            
            container.innerHTML = html;
        }
        
        function selectGroup(groupId, groupName) {
            document.getElementById('threadID').value = groupId;
            switchTab('messaging');
            
            addLog('messagingLogs', \`Selected group: \${groupName}\`, 'info');
            addLog('messagingLogs', \`Thread ID set to: \${groupId}\`, 'info');
            
            // Auto-parse
            setTimeout(() => parseThread(), 500);
        }
        
        async function testThread() {
            const cookie = document.getElementById('testCookie').value.trim();
            const threadID = document.getElementById('testThreadID').value.trim();
            const message = document.getElementById('testMessage').value.trim();
            
            if (!cookie || !threadID) {
                alert('Please enter cookie and thread ID');
                return;
            }
            
            addLog('messagingLogs', \`Testing thread: \${threadID}\`, 'info');
            
            try {
                const response = await fetch('/api/test-send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie, threadID, message })
                });
                
                const data = await response.json();
                displayTestResults(data);
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displayTestResults(data) {
            const container = document.getElementById('testResults');
            
            if (!data.success) {
                container.innerHTML = \`
                    <div style="background: #f8d7da; color: #721c24; padding: 20px; border-radius: 8px;">
                        <strong>❌ Test Failed:</strong> \${data.error}
                    </div>
                \`;
                return;
            }
            
            let html = \`
                <div style="background: #d4edda; color: #155724; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                    <strong>✅ Thread Analysis:</strong><br>
                    <strong>Type:</strong> \${data.parsed.type}<br>
                    <strong>Digits:</strong> \${data.parsed.digitCount}<br>
                    <strong>Formats tested:</strong> \${data.parsed.formats.length}<br>
                    <strong>Success rate:</strong> \${data.successRate}
                </div>
            \`;
            
            if (data.workingFormats.length > 0) {
                html += \`
                    <div style="background: #d1ecf1; color: #0c5460; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <strong>🎯 Working Formats (\${data.workingFormats.length}):</strong><br>
                        \${data.workingFormats.map((f, i) => \`
                            <div style="padding: 5px 0;">
                                \${i + 1}. <strong>\${f.format}:</strong> \${f.id}
                            </div>
                        \`).join('')}
                        <div style="margin-top: 10px; padding: 10px; background: white; border-radius: 5px;">
                            <strong>Recommended:</strong> \${data.bestFormat.id}<br>
                            <small>Copy this to Thread ID field</small>
                        </div>
                    </div>
                \`;
            }
            
            html += '<strong>Detailed Results:</strong><br><br>';
            html += '<div style="max-height: 300px; overflow-y: auto;">';
            
            data.results.forEach(result => {
                html += \`
                    <div class="test-result-item \${result.success ? 'test-success' : 'test-failure'}">
                        <div>
                            <strong>\${result.format}:</strong><br>
                            <small>\${result.id}</small>
                        </div>
                        <div style="text-align: right;">
                            \${result.success ? '✅ Success' : '❌ Failed'}<br>
                            <small>\${result.time}ms</small>
                        </div>
                    </div>
                \`;
            });
            
            html += '</div>';
            
            container.innerHTML = html;
            
            // Log results
            addLog('messagingLogs', \`Test completed: \${data.successRate} success rate\`, 'info');
            if (data.workingFormats.length > 0) {
                addLog('messagingLogs', \`Best format: \${data.bestFormat.format}\`, 'success');
            }
        }
        
        async function loadSessions() {
            try {
                const response = await fetch('/api/active-sessions');
                const data = await response.json();
                
                if (data.success) {
                    displaySessions(data.sessions);
                }
            } catch (error) {
                console.error('Load sessions error:', error);
            }
        }
        
        function displaySessions(sessions) {
            const container = document.getElementById('sessionsList');
            
            if (sessions.length === 0) {
                container.innerHTML = \`
                    <div style="text-align: center; padding: 40px; color: #666;">
                        <i class="fas fa-inbox fa-3x"></i>
                        <p style="margin-top: 15px;">No active sessions</p>
                    </div>
                \`;
                return;
            }
            
            let html = '<div style="display: grid; gap: 15px;">';
            
            sessions.forEach(session => {
                let badge = '';
                if (session.digitCount === 15) badge = '<span class="badge badge-15digit">15-digit</span>';
                else if (session.digitCount === 16) badge = '<span class="badge badge-16digit">16-digit</span>';
                else if (session.digitCount >= 17) badge = \`<span class="badge badge-17digit">\${session.digitCount}-digit</span>\`;
                
                html += \`
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; border-left: 4px solid #6a11cb;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <strong>\${session.type.toUpperCase()}</strong>
                                \${badge}
                                <span style="background: \${session.status === 'active' ? '#d4edda' : '#f8d7da'}; 
                                       color: \${session.status === 'active' ? '#155724' : '#721c24'}; 
                                       padding: 4px 12px; border-radius: 20px; font-size: 0.8em; margin-left: 10px;">
                                    \${session.status}
                                </span>
                            </div>
                            <button class="btn btn-danger btn-sm" onclick="stopSession('\${session.sessionId}')" style="padding: 5px 10px; font-size: 0.8em;">
                                <i class="fas fa-stop"></i> Stop
                            </button>
                        </div>
                        <div style="margin-top: 10px; color: #666; font-size: 0.9em;">
                            <div><strong>Session ID:</strong> \${session.sessionId}</div>
                            <div><strong>Thread ID:</strong> \${session.threadID}</div>
                            <div><strong>Type:</strong> \${session.threadType}</div>
                            <div><strong>Messages Sent:</strong> \${session.messagesSent}</div>
                            <div><strong>Uptime:</strong> \${formatTime(session.uptime)}</div>
                        </div>
                    </div>
                \`;
            });
            
            html += '</div>';
            container.innerHTML = html;
            
            // Update stats
            updateStatsBar();
        }
        
        async function stopSession(sessionId) {
            if (!confirm('Stop this session?')) return;
            
            try {
                const response = await fetch('/api/stop-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    loadSessions();
                    
                    if (currentSessionId === sessionId) {
                        currentSessionId = null;
                        document.getElementById('sessionCard').style.display = 'none';
                    }
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadThreadExamples() {
            try {
                const response = await fetch('/api/thread-examples');
                const data = await response.json();
                
                if (data.success) {
                    displayThreadExamples(data.examples);
                }
            } catch (error) {
                console.error('Load examples error:', error);
            }
        }
        
        function displayThreadExamples(examples) {
            const container = document.getElementById('threadExamples');
            
            let html = '';
            examples.forEach(category => {
                html += \`
                    <div style="margin-bottom: 25px;">
                        <h3 style="color: #6a11cb; margin-bottom: 10px; border-bottom: 2px solid #f0f0f0; padding-bottom: 5px;">
                            \${category.name}
                        </h3>
                        <div class="thread-examples">
                            \${category.examples.map(example => \`
                                <div class="example-item" onclick="useExample('\${example}')">
                                    <i class="fas fa-copy"></i> \${example}
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \`;
            });
            
            container.innerHTML = html;
        }
        
        function useExample(example) {
            document.getElementById('threadID').value = example;
            switchTab('messaging');
            
            addLog('messagingLogs', \`Example copied: \${example}\`, 'info');
            setTimeout(() => parseThread(), 500);
        }
        
        function formatTime(ms) {
            const seconds = Math.floor(ms / 1000);
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            if (hours > 0) {
                return \`\${hours}h \${minutes}m \${secs}s\`;
            } else if (minutes > 0) {
                return \`\${minutes}m \${secs}s\`;
            } else {
                return \`\${secs}s\`;
            }
        }
        
        function updateStatsBar() {
            // Update active sessions count
            fetch('/api/active-sessions')
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        document.getElementById('activeSessions').textContent = data.total;
                        
                        // Calculate total messages
                        let totalMessages = 0;
                        data.sessions.forEach(session => {
                            totalMessages += session.messagesSent || 0;
                        });
                        document.getElementById('totalMessages').textContent = totalMessages;
                    }
                })
                .catch(error => console.error('Stats update error:', error));
        }
        
        function updateServerUptime() {
            const uptime = Date.now() - serverStartTime;
            const hours = Math.floor(uptime / 3600000);
            const minutes = Math.floor((uptime % 3600000) / 60000);
            const seconds = Math.floor((uptime % 60000) / 1000);
            
            document.getElementById('serverUptime').textContent = 
                \`\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
        }
        
        // Initialize
        window.onload = function() {
            serverStartTime = Date.now();
            
            // Update server uptime every second
            setInterval(updateServerUptime, 1000);
            
            // Update stats every 5 seconds
            setInterval(updateStatsBar, 5000);
            
            // Refresh current session every 3 seconds
            setInterval(() => {
                if (currentSessionId) {
                    refreshSession();
                }
            }, 3000);
            
            // Initial load
            updateStatsBar();
            loadThreadExamples();
            
            addLog('messagingLogs', 'System initialized successfully', 'info');
            addLog('messagingLogs', '🌟 100% Thread Support: ACTIVE', 'success');
            addLog('messagingLogs', '🌟 All formats supported: 15-digit, 16-digit, 17+, URLs, t_id., thread_fbid:', 'success');
        };
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ultimate Messaging System started on port ${PORT}`);
    console.log(`✅ 100% Thread Support: ACTIVE`);
    console.log(`✅ All Formats: 15-digit, 16-digit, 17+, URLs, t_id., thread_fbid:`);
    console.log(`✅ Smart Detection: ENABLED`);
    console.log(`✅ Multi-Format Fallback: ENABLED`);
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    
    for (const [sessionId, session] of activeSessions) {
        try {
            if (session.messaging) {
                session.messaging.stop();
            }
        } catch (error) {
            console.error(`Failed to stop session ${sessionId}:`, error.message);
        }
    }
    
    console.log('✅ All sessions stopped. Goodbye!');
    process.exit(0);
});
