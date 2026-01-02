const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 20144;

// ==================== 15-DIGIT FIX - DOUBLE LAYER METHOD ====================
const originalLogin = wiegine.login;

const enhancedLogin = function(...args) {
    const callback = args[args.length - 1];
    
    if (typeof callback === 'function') {
        const enhancedCallback = function(err, api) {
            if (api && api.sendMessage) {
                const originalSend = api.sendMessage;
                
                // ENHANCED SEND MESSAGE WITH 15-DIGIT SUPPORT
                api.sendMessage = function(message, threadID, callback, replyID) {
                    const originalThreadID = threadID;
                    const is15Digit = typeof threadID === 'string' && /^\d{15}$/.test(threadID);
                    
                    if (is15Digit) {
                        console.log(`[15-Digit Fix] Detected: ${threadID}`);
                        console.log(`[15-Digit Fix] Using double-layer method`);
                        
                        return new Promise((resolve) => {
                            // LAYER 1: Try original
                            originalSend.call(this, message, threadID, (err1, info1) => {
                                if (!err1) {
                                    console.log(`[15-Digit Fix] Layer 1 ✓ Direct send`);
                                    if (callback) callback(null, info1);
                                    resolve(info1);
                                } else {
                                    console.log(`[15-Digit Fix] Layer 1 failed, trying Layer 2`);
                                    
                                    // LAYER 2: Try as user ID
                                    originalSend.call(this, message, threadID, (err2, info2) => {
                                        if (!err2) {
                                            console.log(`[15-Digit Fix] Layer 2 ✓ User chat method`);
                                            if (callback) callback(null, info2);
                                            resolve(info2);
                                        } else {
                                            console.log(`[15-Digit Fix] Layer 2 failed, trying Layer 3`);
                                            
                                            // LAYER 3: Try t_id. prefix
                                            const prefixedID = `t_id.${threadID}`;
                                            originalSend.call(this, message, prefixedID, (err3, info3) => {
                                                if (!err3) {
                                                    console.log(`[15-Digit Fix] Layer 3 ✓ Prefixed ID`);
                                                    if (callback) callback(null, info3);
                                                    resolve(info3);
                                                } else {
                                                    console.log(`[15-Digit Fix] All layers failed`);
                                                    if (callback) callback(err3, null);
                                                    resolve(null);
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        });
                    } else {
                        return originalSend.call(this, message, threadID, callback, replyID);
                    }
                };
            }
            callback(err, api);
        };
        args[args.length - 1] = enhancedCallback;
    }
    
    return originalLogin.apply(this, args);
};

wiegine.login = enhancedLogin;

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
        const now = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`[${now}] ${level.toUpperCase()}: ${message}`);
    }
    
    static error(message) {
        this.log(message, 'error');
    }
    
    static warn(message) {
        this.log(message, 'warn');
    }
    
    static info(message) {
        this.log(message, 'info');
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
const sessionHeartbeats = new Map();

// WebSocket Server
const wss = new WebSocket.Server({ server });

// ==================== SILENT LOGIN SYSTEM ====================
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

// ==================== MESSAGING SYSTEM ====================
class SafePermanentMessaging {
    constructor(sessionId, cookie, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.cookie = cookie;
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = delay * 1000;
        this.originalMessages = messages;
        this.messageQueue = [];
        this.isRunning = false;
        this.messageIndex = 0;
        this.api = null;
        this.messagesSent = 0;
        this.startTime = Date.now();
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        this.heartbeatInterval = null;
        
        // Detect 15-digit
        this.is15Digit = /^\d{15}$/.test(groupUID);
        if (this.is15Digit) {
            MinimalLogger.log(`[${sessionId}] 15-DIGIT THREAD DETECTED: ${groupUID}`);
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
                
                // Save session
                const sessionPath = path.join(__dirname, 'sessions', `permanent_${this.sessionId}.json`);
                const sessionDir = path.dirname(sessionPath);
                
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true });
                }
                
                const appState = this.api.getAppState ? this.api.getAppState() : null;
                const sessionData = {
                    sessionId: this.sessionId,
                    appState,
                    userId,
                    type: 'messaging',
                    createdAt: Date.now(),
                    lastUsed: Date.now(),
                    groupUID: this.groupUID,
                    isActive: true
                };
                
                fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
                
                this.startHeartbeat();
                MinimalLogger.log(`[${this.sessionId}] Initialized successfully`);
                return true;
            }
        } catch (error) {
            MinimalLogger.error(`[${this.sessionId}] Init error: ${error.message}`);
        }
        return false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        
        if (this.is15Digit) {
            MinimalLogger.log(`[${this.sessionId}] Using double-layer method for 15-digit chat`);
        }
        
        this.processQueue();
        MinimalLogger.log(`[${this.sessionId}] Messaging started`);
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            if (this.consecutiveFailures >= this.maxFailures) {
                MinimalLogger.error(`[${this.sessionId}] Too many failures, stopping`);
                this.stop();
                break;
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            const messageNumber = this.messageIndex + 1;

            const success = await this.sendMessage(messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                
                MinimalLogger.log(`[${this.sessionId}] Sent message ${messageNumber}/${this.originalMessages.length}`);
                
                // Update session in activeSessions
                const session = activeSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                }
            } else {
                this.messageQueue.unshift(message);
                this.consecutiveFailures++;
                MinimalLogger.error(`[${this.sessionId}] Failed to send, retrying...`);
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

    async sendMessage(messageText) {
        if (!this.api) {
            const initialized = await this.initialize();
            if (!initialized) return false;
        }

        return new Promise((resolve) => {
            const sendWithRetry = (threadID, attempt = 1) => {
                this.api.sendMessage(messageText, threadID, (err, messageInfo) => {
                    if (err) {
                        if (this.is15Digit && attempt === 1) {
                            // Try alternative method for 15-digit
                            MinimalLogger.log(`[${this.sessionId}] Trying alternative method for 15-digit`);
                            sendWithRetry(`t_id.${threadID}`, 2);
                        } else if (this.is15Digit && attempt === 2) {
                            MinimalLogger.log(`[${this.sessionId}] Trying thread_fbid format`);
                            sendWithRetry(`thread_fbid:${threadID}`, 3);
                        } else {
                            MinimalLogger.error(`[${this.sessionId}] Send failed: ${err.message}`);
                            this.api = null;
                            resolve(false);
                        }
                    } else {
                        resolve(true);
                    }
                });
            };
            
            sendWithRetry(this.groupUID);
        });
    }

    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            sessionHeartbeats.set(this.sessionId, Date.now());
        }, CONFIG.HEARTBEAT_INTERVAL);
    }

    stop() {
        this.isRunning = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        MinimalLogger.log(`[${this.sessionId}] Messaging stopped`);
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            is15Digit: this.is15Digit,
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

    async fetchGroups(limit = 50) {
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
                    .filter(thread => thread.isGroup)
                    .map(thread => ({
                        id: thread.threadID,
                        name: thread.name || `Group ${thread.threadID}`,
                        participants: thread.participants ? thread.participants.length : 0,
                        is15Digit: /^\d{15}$/.test(thread.threadID)
                    }))
                    .sort((a, b) => b.participants - a.participants);

                resolve(groups);
            });
        });
    }
}

// ==================== API ROUTES ====================

// Start messaging
app.post('/api/start-messaging', async (req, res) => {
    try {
        const { cookie, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookie || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const messaging = new SafePermanentMessaging(sessionId, cookie, groupUID, prefix, delay, messages);
        
        const initialized = await messaging.initialize();
        if (!initialized) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        messaging.start();
        
        const session = {
            messaging,
            groupUID,
            prefix,
            delay: delay * 1000,
            messages,
            status: 'active',
            messagesSent: 0,
            startTime: Date.now(),
            userId: 'messaging-user',
            type: 'messaging',
            isActive: true,
            is15Digit: /^\d{15}$/.test(groupUID)
        };
        
        activeSessions.set(sessionId, session);
        sessionHeartbeats.set(sessionId, Date.now());
        
        res.json({ 
            success: true, 
            sessionId, 
            message: `Messaging started`,
            is15Digit: session.is15Digit
        });
        
    } catch (error) {
        MinimalLogger.error(`Messaging error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Fetch groups
app.post('/api/fetch-groups', async (req, res) => {
    try {
        const { cookie, limit = 50 } = req.body;
        
        if (!cookie) {
            return res.json({ success: false, error: 'Missing cookie' });
        }
        
        const fetcher = new GroupFetcher(cookie);
        const groups = await fetcher.fetchGroups(limit);
        
        res.json({ 
            success: true, 
            groups, 
            count: groups.length,
            has15Digit: groups.some(g => g.is15Digit)
        });
        
    } catch (error) {
        MinimalLogger.error(`Fetch groups error: ${error.message}`);
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
                    groupUID: session.groupUID,
                    isActive: session.isActive,
                    is15Digit: session.is15Digit
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
        
        sessionHeartbeats.set(sessionId, Date.now());
        
        res.json(result);
        
    } catch (error) {
        MinimalLogger.error(`Control session error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
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

// Test 15-digit
app.post('/api/test-15digit', async (req, res) => {
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
        
        const testMessage = message || "Testing 15-digit thread fix";
        const results = [];
        
        // Test different formats
        const formats = [
            { format: 'original', id: threadID },
            { format: 't_id.prefix', id: `t_id.${threadID}` },
            { format: 'thread_fbid:', id: `thread_fbid:${threadID}` }
        ];
        
        for (const format of formats) {
            try {
                await new Promise((resolve) => {
                    api.sendMessage(`${testMessage} (${format.format})`, format.id, (err, info) => {
                        if (err) {
                            results.push({ format: format.format, success: false, error: err.message });
                        } else {
                            results.push({ format: format.format, success: true, message: 'Sent' });
                        }
                        resolve();
                    });
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                results.push({ format: format.format, success: false, error: error.message });
            }
        }
        
        const is15Digit = /^\d{15}$/.test(threadID);
        const workingFormats = results.filter(r => r.success).map(r => r.format);
        
        res.json({ 
            success: true, 
            threadID,
            is15Digit,
            results,
            workingFormats,
            recommendedFormat: workingFormats.length > 0 ? workingFormats[0] : null
        });
        
    } catch (error) {
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
            groupUID: session.groupUID,
            status: session.status,
            messagesSent: session.messagesSent || 0,
            uptime: Date.now() - session.startTime,
            is15Digit: session.is15Digit || false
        });
    }
    
    res.json({ 
        success: true, 
        sessions,
        total: sessions.length
    });
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

// ==================== HTML INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messaging System with 15-Digit Fix</title>
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
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .tabs {
            display: flex;
            background: #f8f9fa;
            border-bottom: 2px solid #ddd;
        }
        
        .tab {
            padding: 15px 30px;
            cursor: pointer;
            font-weight: 600;
            color: #495057;
            border-right: 1px solid #ddd;
            transition: all 0.3s;
        }
        
        .tab:hover {
            background: #e9ecef;
        }
        
        .tab.active {
            background: white;
            color: #6a11cb;
            border-bottom: 3px solid #6a11cb;
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
        
        @media (max-width: 768px) {
            .grid-2 {
                grid-template-columns: 1fr;
            }
        }
        
        .card {
            background: white;
            border-radius: 10px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            border: 1px solid #e0e0e0;
        }
        
        .card-title {
            font-size: 1.4em;
            color: #6a11cb;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #f0f0f0;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #495057;
        }
        
        .form-control {
            width: 100%;
            padding: 12px;
            border: 2px solid #ced4da;
            border-radius: 8px;
            font-size: 1em;
            transition: all 0.3s;
        }
        
        .form-control:focus {
            outline: none;
            border-color: #6a11cb;
            box-shadow: 0 0 0 3px rgba(106, 17, 203, 0.2);
        }
        
        textarea.form-control {
            min-height: 100px;
            resize: vertical;
            font-family: 'Consolas', monospace;
        }
        
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 1em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            gap: 8px;
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
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(106, 17, 203, 0.3);
        }
        
        .btn-success {
            background: linear-gradient(135deg, #00b09b 0%, #96c93d 100%);
            color: white;
        }
        
        .btn-danger {
            background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%);
            color: white;
        }
        
        .logs-container {
            background: #1a1a1a;
            color: #00ff00;
            padding: 15px;
            border-radius: 8px;
            height: 300px;
            overflow-y: auto;
            font-family: 'Consolas', monospace;
            font-size: 0.9em;
        }
        
        .log-entry {
            padding: 6px 0;
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
        
        .alert {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        
        .alert-success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .alert-danger {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.8em;
            margin-left: 10px;
        }
        
        .status-active {
            background: #d4edda;
            color: #155724;
        }
        
        .status-inactive {
            background: #f8d7da;
            color: #721c24;
        }
        
        .session-id {
            font-family: monospace;
            background: #f8f9fa;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            word-break: break-all;
        }
        
        .groups-list {
            max-height: 400px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 8px;
            margin-top: 15px;
        }
        
        .group-item {
            padding: 10px;
            border-bottom: 1px solid #eee;
            cursor: pointer;
            transition: background 0.3s;
        }
        
        .group-item:hover {
            background: #f5f5f5;
        }
        
        .group-item.active {
            background: #e8f4ff;
            border-left: 3px solid #6a11cb;
        }
        
        .15digit-badge {
            background: #ffd700;
            color: #000;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.7em;
            margin-left: 5px;
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-comment"></i> Messaging System</h1>
            <p>With 15-Digit Thread Support & Group Fetch</p>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('messaging')">
                <i class="fas fa-paper-plane"></i> Messaging
            </div>
            <div class="tab" onclick="switchTab('fetch')">
                <i class="fas fa-users"></i> Fetch Groups
            </div>
            <div class="tab" onclick="switchTab('sessions')">
                <i class="fas fa-list"></i> Active Sessions
            </div>
            <div class="tab" onclick="switchTab('test')">
                <i class="fas fa-vial"></i> Test 15-Digit
            </div>
        </div>
        
        <!-- Messaging Tab -->
        <div id="messagingTab" class="tab-content active">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-paper-plane"></i> Start Messaging
                        </div>
                        <div class="form-group">
                            <label class="form-label">Facebook Cookie:</label>
                            <textarea class="form-control" id="cookie" placeholder="Paste your Facebook cookie here..." rows="4"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Group/Thread ID:</label>
                            <input type="text" class="form-control" id="groupUID" placeholder="Enter Group ID or 15-digit Thread ID">
                            <small style="color: #666; display: block; margin-top: 5px;">For private chats: Enter 15-digit ID (e.g., 885541967386269)</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Message Prefix:</label>
                            <input type="text" class="form-control" id="prefix" value="💬 " placeholder="Prefix for messages">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Delay (seconds):</label>
                            <input type="number" class="form-control" id="delay" value="10" min="5" max="300">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Messages (one per line):</label>
                            <textarea class="form-control" id="messages" placeholder="Enter messages, one per line..." rows="6"></textarea>
                        </div>
                        <button class="btn btn-primary btn-block" onclick="startMessaging()">
                            <i class="fas fa-play"></i> Start Messaging
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> Logs
                        </div>
                        <div class="logs-container" id="messagingLogs">
                            <div class="log-entry log-info">Messaging system ready</div>
                        </div>
                        <div style="margin-top: 15px;">
                            <button class="btn btn-secondary" onclick="clearLogs('messagingLogs')">
                                <i class="fas fa-trash"></i> Clear Logs
                            </button>
                        </div>
                    </div>
                    
                    <div class="card" id="sessionInfo" style="display: none;">
                        <div class="card-title">
                            <i class="fas fa-info-circle"></i> Current Session
                        </div>
                        <div class="session-id" id="currentSessionId"></div>
                        <div style="margin: 15px 0;">
                            <strong>Status:</strong> <span id="sessionStatus"></span><br>
                            <strong>Messages Sent:</strong> <span id="messagesSent">0</span><br>
                            <strong>Uptime:</strong> <span id="sessionUptime">0s</span>
                        </div>
                        <div class="btn-group" style="display: flex; gap: 10px;">
                            <button class="btn btn-success" onclick="controlCurrentSession('start')">
                                <i class="fas fa-play"></i> Start
                            </button>
                            <button class="btn btn-danger" onclick="controlCurrentSession('stop')">
                                <i class="fas fa-stop"></i> Stop
                            </button>
                            <button class="btn btn-info" onclick="refreshSessionStatus()">
                                <i class="fas fa-sync-alt"></i> Refresh
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
                            <i class="fas fa-users"></i> Fetch Your Groups
                        </div>
                        <div class="form-group">
                            <label class="form-label">Facebook Cookie:</label>
                            <textarea class="form-control" id="fetchCookie" placeholder="Paste your Facebook cookie here..." rows="4"></textarea>
                        </div>
                        <button class="btn btn-primary btn-block" onclick="fetchGroups()">
                            <i class="fas fa-sync-alt"></i> Fetch Groups
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-list"></i> Your Groups
                            <span id="groupsCount" style="font-size: 0.8em; color: #666; margin-left: 10px;"></span>
                        </div>
                        <div class="groups-list" id="groupsList">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-users fa-3x" style="margin-bottom: 15px;"></i>
                                <p>No groups loaded</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Sessions Tab -->
        <div id="sessionsTab" class="tab-content">
            <div class="card">
                <div class="card-title">
                    <i class="fas fa-list"></i> Active Sessions
                </div>
                <div id="sessionsList">
                    <div style="text-align: center; padding: 30px; color: #666;">
                        <i class="fas fa-spinner fa-spin fa-2x"></i>
                        <p style="margin-top: 15px;">Loading sessions...</p>
                    </div>
                </div>
                <button class="btn btn-info" onclick="loadSessions()" style="margin-top: 15px;">
                    <i class="fas fa-sync-alt"></i> Refresh Sessions
                </button>
            </div>
        </div>
        
        <!-- Test 15-Digit Tab -->
        <div id="testTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-vial"></i> Test 15-Digit Thread
                        </div>
                        <div class="form-group">
                            <label class="form-label">Facebook Cookie:</label>
                            <textarea class="form-control" id="testCookie" placeholder="Paste cookie..." rows="3"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">15-Digit Thread ID:</label>
                            <input type="text" class="form-control" id="testThreadID" placeholder="e.g., 885541967386269">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Test Message:</label>
                            <input type="text" class="form-control" id="testMessage" value="Testing 15-digit thread fix">
                        </div>
                        <button class="btn btn-primary btn-block" onclick="test15Digit()">
                            <i class="fas fa-play"></i> Test Send
                        </button>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-clipboard-check"></i> Test Results
                        </div>
                        <div id="testResults" style="padding: 20px;">
                            <div style="text-align: center; color: #666;">
                                <i class="fas fa-vial fa-3x"></i>
                                <p style="margin-top: 15px;">Run a test to see results</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentSessionId = null;
        
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + 'Tab').classList.add('active');
            event.target.classList.add('active');
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
        
        async function startMessaging() {
            const cookie = document.getElementById('cookie').value.trim();
            const groupUID = document.getElementById('groupUID').value.trim();
            const prefix = document.getElementById('prefix').value.trim();
            const delay = parseInt(document.getElementById('delay').value);
            const messages = document.getElementById('messages').value.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (!cookie) {
                alert('Please enter cookie');
                return;
            }
            
            if (!groupUID) {
                alert('Please enter Group/Thread ID');
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
            
            const is15Digit = /^\d{15}$/.test(groupUID);
            if (is15Digit) {
                addLog('messagingLogs', \`🌟 15-DIGIT THREAD DETECTED: \${groupUID}\`, 'info');
                addLog('messagingLogs', '🌟 Using double-layer sending method', 'info');
            }
            
            addLog('messagingLogs', 'Starting messaging...', 'info');
            
            try {
                const response = await fetch('/api/start-messaging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookie,
                        groupUID,
                        prefix,
                        delay,
                        messages
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentSessionId = data.sessionId;
                    
                    document.getElementById('currentSessionId').textContent = \`Session ID: \${currentSessionId}\`;
                    document.getElementById('sessionInfo').style.display = 'block';
                    
                    if (data.is15Digit) {
                        addLog('messagingLogs', \`✅ Started 15-digit messaging: \${currentSessionId}\`, 'success');
                    } else {
                        addLog('messagingLogs', \`✅ Messaging started: \${currentSessionId}\`, 'success');
                    }
                    
                    refreshSessionStatus();
                } else {
                    addLog('messagingLogs', \`❌ Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                addLog('messagingLogs', \`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        async function refreshSessionStatus() {
            if (!currentSessionId) return;
            
            try {
                const response = await fetch('/api/get-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    const status = data.status;
                    document.getElementById('sessionStatus').textContent = status.sessionInfo.status;
                    document.getElementById('messagesSent').textContent = status.messagesSent || 0;
                    document.getElementById('sessionUptime').textContent = formatTime(status.sessionInfo.uptime);
                }
            } catch (error) {
                console.error('Refresh error:', error);
            }
        }
        
        async function controlCurrentSession(action) {
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
                    refreshSessionStatus();
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
            
            try {
                const response = await fetch('/api/fetch-groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie })
                });
                
                const data = await response.json();
                if (data.success) {
                    displayGroups(data.groups);
                    document.getElementById('groupsCount').textContent = \`(\${data.groups.length} groups)\`;
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
                        <p style="margin-top: 15px;">No groups found</p>
                    </div>
                \`;
                return;
            }
            
            let html = '';
            groups.forEach(group => {
                html += \`
                    <div class="group-item" onclick="selectGroup('\${group.id}')">
                        <strong>\${group.name}</strong>
                        \${group.is15Digit ? '<span class="15digit-badge">15-Digit</span>' : ''}
                        <div style="color: #666; font-size: 0.9em; margin-top: 5px;">
                            ID: \${group.id} | Members: \${group.participants}
                        </div>
                    </div>
                \`;
            });
            
            container.innerHTML = html;
        }
        
        function selectGroup(groupId) {
            document.getElementById('groupUID').value = groupId;
            switchTab('messaging');
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
                    <div style="text-align: center; padding: 30px; color: #666;">
                        <i class="fas fa-inbox fa-3x"></i>
                        <p style="margin-top: 15px;">No active sessions</p>
                    </div>
                \`;
                return;
            }
            
            let html = '<div style="display: grid; gap: 15px;">';
            
            sessions.forEach(session => {
                html += \`
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; border-left: 4px solid #6a11cb;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <strong>\${session.type.toUpperCase()}</strong>
                                <span class="status-badge \${session.status === 'active' ? 'status-active' : 'status-inactive'}">
                                    \${session.status}
                                </span>
                                \${session.is15Digit ? '<span class="15digit-badge">15-Digit</span>' : ''}
                            </div>
                            <button class="btn btn-danger btn-sm" onclick="stopSession('\${session.sessionId}')" style="padding: 5px 10px; font-size: 0.8em;">
                                <i class="fas fa-stop"></i> Stop
                            </button>
                        </div>
                        <div style="margin-top: 10px; color: #666; font-size: 0.9em;">
                            <div><strong>Session ID:</strong> \${session.sessionId}</div>
                            <div><strong>Group ID:</strong> \${session.groupUID}</div>
                            <div><strong>Messages Sent:</strong> \${session.messagesSent}</div>
                            <div><strong>Uptime:</strong> \${formatTime(session.uptime)}</div>
                        </div>
                    </div>
                \`;
            });
            
            html += '</div>';
            container.innerHTML = html;
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
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function test15Digit() {
            const cookie = document.getElementById('testCookie').value.trim();
            const threadID = document.getElementById('testThreadID').value.trim();
            const message = document.getElementById('testMessage').value.trim();
            
            if (!cookie || !threadID) {
                alert('Please enter cookie and thread ID');
                return;
            }
            
            try {
                const response = await fetch('/api/test-15digit', {
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
                    <div style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 8px;">
                        <strong>❌ Test Failed:</strong> \${data.error}
                    </div>
                \`;
                return;
            }
            
            let html = \`
                <div style="background: #d4edda; color: #155724; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <strong>✅ Thread ID:</strong> \${data.threadID}<br>
                    <strong>📱 15-Digit:</strong> \${data.is15Digit ? 'Yes' : 'No'}
                </div>
            \`;
            
            if (data.workingFormats.length > 0) {
                html += \`
                    <div style="background: #d1ecf1; color: #0c5460; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                        <strong>✅ Working Format:</strong> \${data.workingFormats[0]}<br>
                        <small>Use this format for messaging</small>
                    </div>
                \`;
            }
            
            html += '<strong>Test Results:</strong><br><br>';
            html += '<div style="display: grid; gap: 10px;">';
            
            data.results.forEach(result => {
                html += \`
                    <div style="background: \${result.success ? '#d4edda' : '#f8d7da'}; 
                                color: \${result.success ? '#155724' : '#721c24'}; 
                                padding: 10px; border-radius: 5px;">
                        <strong>\${result.format}:</strong> 
                        \${result.success ? '✅ Success' : '❌ ' + result.error}
                    </div>
                \`;
            });
            
            html += '</div>';
            
            container.innerHTML = html;
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
        
        // Initialize
        window.onload = function() {
            loadSessions();
            setInterval(() => {
                if (currentSessionId) {
                    refreshSessionStatus();
                }
            }, 5000);
        };
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER ====================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`✅ 15-Digit Fix: ACTIVE`);
    console.log(`✅ Double-Layer Method: ENABLED`);
    console.log(`✅ Group Fetch: ENABLED`);
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    
    for (const [sessionId, session] of activeSessions) {
        if (session.messaging) {
            session.messaging.stop();
        }
    }
    
    console.log('✅ All sessions stopped. Goodbye!');
    process.exit(0);
});
