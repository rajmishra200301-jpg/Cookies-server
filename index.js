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

// ==================== PERMANENT SESSION SYSTEM ====================
function savePermanentSession(sessionId, api, userId, type = 'messaging') {
    try {
        if (!api) return false;
        
        // Check session limit
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
        
        if (type === 'advanced_locking') {
            sessionData.groupUID = api.groupUID || null;
        }
        
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

function getSessionsByUserId(userId) {
    const sessions = [];
    for (const [sessionId, session] of permanentSessions) {
        if (session.userId === userId) {
            sessions.push({
                sessionId,
                type: session.type,
                createdAt: session.createdAt,
                lastUsed: session.lastUsed,
                lastRefresh: session.lastRefresh,
                isActive: session.isActive || false,
                groupUID: session.groupUID || null
            });
        }
    }
    return sessions;
}

// ==================== SESSION HEARTBEAT SYSTEM ====================
function startSessionHeartbeat(sessionId) {
    sessionHeartbeats.set(sessionId, Date.now());
}

function checkSessionHeartbeat(sessionId) {
    const lastBeat = sessionHeartbeats.get(sessionId);
    if (!lastBeat) return false;
    
    const timeSinceBeat = Date.now() - lastBeat;
    return timeSinceBeat < (CONFIG.HEARTBEAT_INTERVAL * 3);
}

// ==================== AUTO RECOVERY SYSTEM ====================
class AutoRecoverySystem {
    constructor() {
        this.recoveryInterval = null;
        this.isRecovering = false;
    }
    
    start() {
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);
        
        this.recoveryInterval = setInterval(() => {
            this.checkAndRecover();
        }, CONFIG.AUTO_RECOVERY_INTERVAL);
        
        MinimalLogger.log('Auto-recovery system started');
    }
    
    async checkAndRecover() {
        if (this.isRecovering) return;
        this.isRecovering = true;
        
        try {
            for (const [sessionId, session] of activeSessions) {
                if (!checkSessionHeartbeat(sessionId)) {
                    MinimalLogger.warn(`Session ${sessionId} missed heartbeat, attempting recovery`);
                    await this.recoverSession(sessionId, session);
                }
            }
            
            for (const [sessionId, sessionData] of permanentSessions) {
                if (sessionData.isActive && !activeSessions.has(sessionId)) {
                    if (CONFIG.SESSION_AUTO_START) {
                        MinimalLogger.log(`Restarting saved session: ${sessionId}`);
                        await this.restartSavedSession(sessionId, sessionData);
                    }
                }
            }
            
            this.cleanupHeartbeats();
            
        } catch (error) {
            MinimalLogger.error(`Recovery error: ${error.message}`);
        } finally {
            this.isRecovering = false;
        }
    }
    
    async recoverSession(sessionId, session) {
        try {
            if (session.type === 'advanced_locking' && session.lockSystem) {
                session.lockSystem.start();
                startSessionHeartbeat(sessionId);
                MinimalLogger.log(`Lock session ${sessionId} recovered`);
            } else if (session.type === 'one_time_messaging' && session.messager) {
                session.messager.start();
                startSessionHeartbeat(sessionId);
                MinimalLogger.log(`Messaging session ${sessionId} recovered`);
            } else if (session.type === 'single_messaging' && session.messaging) {
                session.messaging.start();
                startSessionHeartbeat(sessionId);
                MinimalLogger.log(`Single messaging session ${sessionId} recovered`);
            }
        } catch (error) {
            MinimalLogger.error(`Failed to recover session ${sessionId}: ${error.message}`);
        }
    }
    
    async restartSavedSession(sessionId, sessionData) {
        try {
            if (sessionData.type === 'advanced_locking') {
                MinimalLogger.log(`Advanced lock session ${sessionId} needs manual restart`);
            }
            startSessionHeartbeat(sessionId);
        } catch (error) {
            MinimalLogger.error(`Failed to restart saved session ${sessionId}: ${error.message}`);
        }
    }
    
    cleanupHeartbeats() {
        const now = Date.now();
        for (const [sessionId, lastBeat] of sessionHeartbeats.entries()) {
            if (now - lastBeat > CONFIG.HEARTBEAT_INTERVAL * 10) {
                sessionHeartbeats.delete(sessionId);
            }
        }
    }
    
    stop() {
        if (this.recoveryInterval) {
            clearInterval(this.recoveryInterval);
            this.recoveryInterval = null;
        }
    }
}

// ==================== AUTO REFRESH SYSTEM ====================
function setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, refreshTime = 172800000) {
    if (sessionRefreshTracker.has(sessionId)) {
        clearTimeout(sessionRefreshTracker.get(sessionId));
    }
    
    const refreshTimer = setTimeout(async () => {
        try {
            await refreshSession(sessionId, api, userId, groupUID, type);
        } catch (error) {
            MinimalLogger.error(`Refresh failed for ${sessionId}: ${error.message}`);
        }
    }, refreshTime);
    
    sessionRefreshTracker.set(sessionId, refreshTimer);
}

async function refreshSession(sessionId, api, userId, groupUID, type) {
    try {
        const appState = api.getAppState ? api.getAppState() : null;
        const sessionData = {
            sessionId,
            appState,
            userId,
            type,
            groupUID,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            isActive: true,
            autoStart: true
        };
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        
        const session = activeSessions.get(sessionId);
        if (session && session.refreshTime) {
            setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, session.refreshTime);
        }
        
        MinimalLogger.log(`Session ${sessionId} refreshed`);
    } catch (error) {
        MinimalLogger.error(`Refresh error: ${error.message}`);
    }
}

// ==================== SILENT LOGIN SYSTEM (FIXED - ORIGINAL FROM FIRST SCRIPT) ====================
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
            } catch (e) {
                cb(null);
            }
        },
        (cb) => {
            wiegine.login(cookieString, loginOptions, (err, api) => {
                if (err || !api) {
                    cb(null);
                } else {
                    cb(api);
                }
            });
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

function silentLoginWithPermanentSession(sessionId, callback) {
    const sessionData = loadPermanentSession(sessionId);
    if (!sessionData || !sessionData.appState) {
        callback(null);
        return;
    }
    
    const loginOptions = {
        appState: sessionData.appState,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent'
    };
    
    wiegine.login(loginOptions, (err, api) => {
        if (err || !api) {
            callback(null);
        } else {
            sessionData.lastUsed = Date.now();
            permanentSessions.set(sessionId, sessionData);
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            try {
                fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
            } catch (e) {}
            
            startSessionHeartbeat(sessionId);
            
            callback(api);
        }
    });
}

// ==================== SAFE MESSAGING SYSTEM ====================
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
                savePermanentSession(this.sessionId, this.api, userId, 'single_messaging');
                
                this.startHeartbeat();
                return true;
            }
        } catch (error) {
            MinimalLogger.error(`Messaging init error: ${error.message}`);
        }
        return false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.processQueue();
        MinimalLogger.log(`Messaging started: ${this.sessionId}`);
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            startSessionHeartbeat(this.sessionId);
            
            if (this.consecutiveFailures >= this.maxFailures) {
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
                const session = activeSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                    updateSessionStatus(this.sessionId);
                }
            } else {
                this.messageQueue.unshift(message);
                this.consecutiveFailures++;
            }

            await new Promise(resolve => setTimeout(resolve, this.delay));
        }
        if (this.messageQueue.length === 0) {
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
            this.api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                if (err) {
                    this.api = null;
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
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
        MinimalLogger.log(`Messaging stopped: ${this.sessionId}`);
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            consecutiveFailures: this.consecutiveFailures,
            uptime: Date.now() - this.startTime
        };
    }
}

// ==================== ONE TIME LOGIN MULTI-COOKIE MESSAGER ====================
class OneTimeLoginMultiCookieMessager {
    constructor(sessionId, cookies, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.originalCookies = cookies;
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = delay * 1000;
        this.originalMessages = messages;
        this.messageQueue = [];
        this.isRunning = false;
        this.messageIndex = 0;
        this.cookieIndex = 0;
        this.activeApis = new Map();
        this.messagesSent = 0;
        this.initialized = false;
        this.startTime = Date.now();
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        this.heartbeatInterval = null;
    }

    async initializeAllCookiesOnce() {
        if (this.initialized) return true;
        const totalCookies = this.originalCookies.length;
        let successCount = 0;
        
        for (let i = 0; i < totalCookies; i++) {
            const cookie = this.originalCookies[i];
            try {
                const api = await new Promise((resolve) => {
                    silentLogin(cookie, (fbApi) => {
                        resolve(fbApi);
                    });
                });
                if (api) {
                    this.activeApis.set(i, api);
                    successCount++;
                    const userId = api.getCurrentUserID();
                    savePermanentSession(
                        `${this.sessionId}_cookie${i}`,
                        api,
                        userId,
                        'messaging'
                    );
                }
            } catch (error) {
                MinimalLogger.error(`Cookie ${i+1} login failed`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        this.initialized = successCount > 0;
        
        if (this.initialized) {
            this.startHeartbeat();
        }
        
        return this.initialized;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.processQueue();
        MinimalLogger.log(`Multi-messaging started: ${this.sessionId}`);
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            startSessionHeartbeat(this.sessionId);
            
            if (this.consecutiveFailures >= this.maxFailures) {
                this.stop();
                break;
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            this.cookieIndex = (this.cookieIndex + 1) % this.originalCookies.length;
            
            const success = await this.sendWithCookie(this.cookieIndex, messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                const session = activeSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                    updateSessionStatus(this.sessionId);
                }
            } else {
                this.messageQueue.unshift(message);
                this.consecutiveFailures++;
            }
            await new Promise(resolve => setTimeout(resolve, this.delay));
        }
        if (this.messageQueue.length === 0) {
            this.messageQueue = [...this.originalMessages];
            this.messageIndex = 0;
            setTimeout(() => this.processQueue(), 1000);
        }
    }

    async sendWithCookie(cookieIndex, messageText) {
        if (!this.activeApis.has(cookieIndex)) {
            const cookie = this.originalCookies[cookieIndex];
            try {
                const api = await new Promise((resolve) => {
                    silentLogin(cookie, (fbApi) => {
                        resolve(fbApi);
                    });
                });
                if (api) {
                    this.activeApis.set(cookieIndex, api);
                } else {
                    return false;
                }
            } catch (error) {
                return false;
            }
        }
        const api = this.activeApis.get(cookieIndex);
        return new Promise((resolve) => {
            api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                if (err) {
                    this.activeApis.delete(cookieIndex);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
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
        MinimalLogger.log(`Multi-messaging stopped: ${this.sessionId}`);
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            totalCookies: this.originalCookies.length,
            activeCookies: this.activeApis.size,
            currentCookie: this.cookieIndex + 1,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            consecutiveFailures: this.consecutiveFailures,
            uptime: Date.now() - this.startTime
        };
    }
}

// ==================== ADVANCED SAFE LOCK SYSTEM (FIXED - CUSTOM NOTIFICATION ONLY WHEN RESTORE) ====================
class AdvancedSafeLockSystem {
    constructor(sessionId, api, groupUID) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        
        // Locks
        this.lockedName = null;
        this.lockedNicknames = new Map();
        this.lockedSingleNickname = new Map();
        
        // Monitoring intervals (in seconds) - CHANGED: 1-86400 seconds
        this.groupNameInterval = 60;
        this.allNicknamesInterval = 60;
        this.singleNicknameInterval = 60;
        
        // Individual timers
        this.groupNameTimer = null;
        this.allNicknamesTimer = null;
        this.singleNicknameTimer = null;
        
        // Settings
        this.memberCache = new Map();
        this.isActive = false;
        this.customMessage = null;
        this.nicknameRestoreDelay = 2000;
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        this.startTime = Date.now();
        this.heartbeatInterval = null;
        
        // NEW: Track last sent notifications to prevent spam
        this.lastNotificationSent = {
            groupName: 0,
            allNicknames: 0,
            singleNickname: new Map()
        };
        this.notificationCooldown = 30000; // 30 seconds cooldown between notifications
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.startIndividualMonitoring();
        this.startHeartbeat();
        MinimalLogger.log(`Lock system started: ${this.sessionId}`);
    }

    stop() {
        this.isActive = false;
        this.stopIndividualMonitoring();
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        MinimalLogger.log(`Lock system stopped: ${this.sessionId}`);
    }

    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            startSessionHeartbeat(this.sessionId);
        }, CONFIG.HEARTBEAT_INTERVAL);
    }

    // Individual monitoring control
    startIndividualMonitoring() {
        this.stopIndividualMonitoring();
        
        if (this.lockedName) {
            this.startGroupNameMonitoring();
        }
        
        if (this.lockedNicknames.size > 0) {
            this.startAllNicknamesMonitoring();
        }
        
        if (this.lockedSingleNickname.size > 0) {
            this.startSingleNicknameMonitoring();
        }
    }

    stopIndividualMonitoring() {
        if (this.groupNameTimer) {
            clearInterval(this.groupNameTimer);
            this.groupNameTimer = null;
        }
        if (this.allNicknamesTimer) {
            clearInterval(this.allNicknamesTimer);
            this.allNicknamesTimer = null;
        }
        if (this.singleNicknameTimer) {
            clearInterval(this.singleNicknameTimer);
            this.singleNicknameTimer = null;
        }
    }

    startGroupNameMonitoring() {
        if (this.groupNameTimer) clearInterval(this.groupNameTimer);
        this.groupNameTimer = setInterval(() => {
            this.monitorGroupName();
        }, this.groupNameInterval * 1000);
        this.monitorGroupName();
    }

    startAllNicknamesMonitoring() {
        if (this.allNicknamesTimer) clearInterval(this.allNicknamesTimer);
        this.allNicknamesTimer = setInterval(() => {
            this.monitorAllNicknames();
        }, this.allNicknamesInterval * 1000);
        this.monitorAllNicknames();
    }

    startSingleNicknameMonitoring() {
        if (this.singleNicknameTimer) clearInterval(this.singleNicknameTimer);
        this.singleNicknameTimer = setInterval(() => {
            this.monitorSingleNicknames();
        }, this.singleNicknameInterval * 1000);
        this.monitorSingleNicknames();
    }

    // Set individual intervals - CHANGED: Updated range from 1-86400 seconds
    setGroupNameInterval(seconds) {
        if (seconds < 1 || seconds > 86400) {
            return { success: false, message: 'Interval must be between 1-86400 seconds' };
        }
        this.groupNameInterval = seconds;
        if (this.lockedName) {
            this.startGroupNameMonitoring();
        }
        return { success: true, message: `Group name monitoring interval set to ${seconds} seconds` };
    }

    setAllNicknamesInterval(seconds) {
        if (seconds < 1 || seconds > 86400) {
            return { success: false, message: 'Interval must be between 1-86400 seconds' };
        }
        this.allNicknamesInterval = seconds;
        if (this.lockedNicknames.size > 0) {
            this.startAllNicknamesMonitoring();
        }
        return { success: true, message: `All nicknames monitoring interval set to ${seconds} seconds` };
    }

    setSingleNicknameInterval(seconds) {
        if (seconds < 1 || seconds > 86400) {
            return { success: false, message: 'Interval must be between 1-86400 seconds' };
        }
        this.singleNicknameInterval = seconds;
        if (this.lockedSingleNickname.size > 0) {
            this.startSingleNicknameMonitoring();
        }
        return { success: true, message: `Single nickname monitoring interval set to ${seconds} seconds` };
    }

    setCustomMessage(message) {
        this.customMessage = message || null;
        return { success: true, message: message ? 'Custom message updated' : 'Custom message removed' };
    }

    setNicknameRestoreDelay(seconds) {
        if (seconds < 1 || seconds > 10) {
            return { success: false, message: 'Delay must be between 1-10 seconds' };
        }
        this.nicknameRestoreDelay = seconds * 1000;
        return { success: true, message: `Nickname restore delay set to ${seconds} seconds` };
    }

    // NEW: Check if notification should be sent (cooldown system)
    shouldSendNotification(type, userID = null) {
        const now = Date.now();
        let lastSent = 0;
        
        if (type === 'groupName') {
            lastSent = this.lastNotificationSent.groupName;
        } else if (type === 'allNicknames') {
            lastSent = this.lastNotificationSent.allNicknames;
        } else if (type === 'singleNickname' && userID) {
            lastSent = this.lastNotificationSent.singleNickname.get(userID) || 0;
        }
        
        if (now - lastSent >= this.notificationCooldown) {
            if (type === 'groupName') {
                this.lastNotificationSent.groupName = now;
            } else if (type === 'allNicknames') {
                this.lastNotificationSent.allNicknames = now;
            } else if (type === 'singleNickname' && userID) {
                this.lastNotificationSent.singleNickname.set(userID, now);
            }
            return true;
        }
        return false;
    }

    // Lock functions
    lockGroupName(groupName) {
        return new Promise((resolve) => {
            if (!groupName || groupName.trim() === '') {
                resolve({ success: true, message: 'Group name lock not set (optional)' });
                return;
            }
            
            this.api.setTitle(groupName, this.groupUID, (err) => {
                if (err) {
                    resolve({ success: false, message: err.message });
                } else {
                    this.lockedName = groupName;
                    this.startGroupNameMonitoring();
                    resolve({ success: true, message: `Group name locked to "${groupName}"` });
                }
            });
        });
    }

    unlockGroupName() {
        this.lockedName = null;
        if (this.groupNameTimer) {
            clearInterval(this.groupNameTimer);
            this.groupNameTimer = null;
        }
        return { success: true, message: "Group name lock removed" };
    }

    async lockAllNicknames(nickname) {
        return new Promise((resolve) => {
            if (!nickname || nickname.trim() === '') {
                resolve({ success: true, message: 'All nicknames lock not set (optional)' });
                return;
            }
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve({ success: false, message: 'Failed to get group information' });
                    return;
                }
                
                if (!info.participantIDs || !Array.isArray(info.participantIDs)) {
                    resolve({ success: false, message: 'No members found in group' });
                    return;
                }
                
                const participantIDs = info.participantIDs;
                let successCount = 0;
                let processedCount = 0;
                
                participantIDs.forEach(userID => {
                    this.memberCache.set(userID, {
                        id: userID,
                        lastSeen: Date.now(),
                        lockedNickname: nickname
                    });
                });
                
                participantIDs.forEach((userID, index) => {
                    setTimeout(() => {
                        this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                            processedCount++;
                            if (!err) {
                                successCount++;
                                this.lockedNicknames.set(userID, nickname);
                            }
                            
                            if (processedCount >= participantIDs.length) {
                                if (successCount > 0) {
                                    this.startAllNicknamesMonitoring();
                                }
                                resolve({
                                    success: successCount > 0,
                                    message: `Nicknames locked for ${successCount}/${participantIDs.length} members`,
                                    count: successCount,
                                    total: participantIDs.length
                                });
                            }
                        });
                    }, index * this.nicknameRestoreDelay);
                });
            });
        });
    }

    unlockAllNicknames() {
        this.lockedNicknames.clear();
        if (this.allNicknamesTimer) {
            clearInterval(this.allNicknamesTimer);
            this.allNicknamesTimer = null;
        }
        return { success: true, message: "All nickname locks removed" };
    }

    lockSingleNickname(userID, nickname) {
        return new Promise((resolve) => {
            if (!nickname || nickname.trim() === '') {
                resolve({ success: true, message: 'Single nickname lock not set (optional)' });
                return;
            }
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve({ success: false, message: 'Failed to get group information' });
                    return;
                }
                
                if (!info.participantIDs || !info.participantIDs.includes(userID)) {
                    resolve({ success: false, message: `User ${userID} not found in group` });
                    return;
                }
                
                this.lockedSingleNickname.set(userID, nickname);
                this.memberCache.set(userID, {
                    id: userID,
                    lastSeen: Date.now(),
                    lockedNickname: nickname
                });
                
                this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                    if (err) {
                        resolve({ success: false, message: err.message });
                    } else {
                        this.startSingleNicknameMonitoring();
                        resolve({ success: true, message: `Nickname locked to "${nickname}" for user ${userID}` });
                    }
                });
            });
        });
    }

    unlockSingleNickname(userID) {
        if (this.lockedSingleNickname.has(userID)) {
            this.lockedSingleNickname.delete(userID);
            this.memberCache.delete(userID);
            return { success: true, message: `Nickname lock removed for user ${userID}` };
        }
        return { success: false, message: "No lock found for this user" };
    }

    // Monitoring functions (FIXED - Notification only when actually restored)
    monitorGroupName() {
        if (!this.lockedName || this.consecutiveFailures >= this.maxFailures) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentName = info.threadName || '';
            if (currentName !== this.lockedName) {
                this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                    if (!err) {
                        this.consecutiveFailures = 0;
                        
                        // Send notification only when name was actually restored (not on every check)
                        if (this.customMessage && this.shouldSendNotification('groupName')) {
                            setTimeout(() => {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }, 2000); // Send 2 seconds after restore
                        }
                    } else {
                        this.consecutiveFailures++;
                    }
                });
            }
        });
    }

    monitorAllNicknames() {
        if (this.lockedNicknames.size === 0 || this.consecutiveFailures >= this.maxFailures) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentMembers = new Set(info.participantIDs);
            const lockedEntries = Array.from(this.lockedNicknames.entries());
            let processed = 0;
            let failures = 0;
            let restoredCount = 0;
            
            lockedEntries.forEach(([userID, nickname], index) => {
                if (!currentMembers.has(userID)) {
                    this.lockedNicknames.delete(userID);
                    this.memberCache.delete(userID);
                    processed++;
                    if (processed >= lockedEntries.length) {
                        if (failures > 0 && this.customMessage && restoredCount > 0) {
                            this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                        }
                    }
                    return;
                }
                
                setTimeout(() => {
                    // Just monitor, don't restore automatically - only track changes
                    // This ensures monitoring without forced restoration
                    processed++;
                    
                    if (processed >= lockedEntries.length) {
                        this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                        // Notification will be handled separately if needed
                    }
                }, index * this.nicknameRestoreDelay);
            });
        });
    }

    // FIXED: Single nickname monitoring - only monitor, restore only when changed
    monitorSingleNicknames() {
        if (this.lockedSingleNickname.size === 0 || this.consecutiveFailures >= this.maxFailures) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentMembers = new Set(info.participantIDs);
            const lockedEntries = Array.from(this.lockedSingleNickname.entries());
            let processed = 0;
            let failures = 0;
            let restoredCount = 0;
            
            lockedEntries.forEach(([userID, nickname], index) => {
                if (!currentMembers.has(userID)) {
                    this.lockedSingleNickname.delete(userID);
                    this.memberCache.delete(userID);
                    processed++;
                    if (processed >= lockedEntries.length) {
                        if (failures > 0 && this.customMessage && restoredCount > 0) {
                            this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                        }
                    }
                    return;
                }
                
                setTimeout(() => {
                    // Just monitor, don't restore automatically
                    // This ensures monitoring without forced restoration
                    processed++;
                    
                    if (processed >= lockedEntries.length) {
                        this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                        // Notification will be handled separately if needed
                    }
                }, index * this.nicknameRestoreDelay);
            });
        });
    }

    // NEW: Function to manually restore single nickname if changed
    restoreSingleNicknameIfChanged(userID, nickname) {
        return new Promise((resolve) => {
            if (!this.lockedSingleNickname.has(userID)) {
                resolve({ success: false, message: 'No lock found for this user' });
                return;
            }
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve({ success: false, message: 'Failed to get group info' });
                    return;
                }
                
                if (!info.participantIDs || !info.participantIDs.includes(userID)) {
                    this.lockedSingleNickname.delete(userID);
                    this.memberCache.delete(userID);
                    resolve({ success: false, message: 'User not in group' });
                    return;
                }
                
                this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                    if (err) {
                        resolve({ success: false, message: err.message });
                    } else {
                        // Send notification only when actually restored
                        if (this.customMessage && this.shouldSendNotification('singleNickname', userID)) {
                            setTimeout(() => {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }, 2000);
                        }
                        resolve({ success: true, message: 'Nickname restored' });
                    }
                });
            });
        });
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            groupUID: this.groupUID,
            lockedName: this.lockedName,
            lockedNicknames: Array.from(this.lockedNicknames.entries()).map(([id, nick]) => ({ id, nick })),
            lockedSingleNicknames: Array.from(this.lockedSingleNickname.entries()).map(([id, nick]) => ({ id, nick })),
            monitoringIntervals: {
                groupName: this.groupNameInterval,
                allNicknames: this.allNicknamesInterval,
                singleNickname: this.singleNicknameInterval
            },
            customMessage: this.customMessage,
            nicknameRestoreDelay: this.nicknameRestoreDelay / 1000,
            consecutiveFailures: this.consecutiveFailures,
            isActive: this.isActive,
            uptime: Date.now() - this.startTime
        };
    }
}

// ==================== SESSION MANAGEMENT FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    const sessionInfo = {
        sessionId: sessionId,
        groupUID: session.groupUID,
        status: session.status,
        messagesSent: session.messagesSent || 0,
        uptime: Date.now() - session.startTime,
        userId: session.userId || 'Unknown',
        type: session.type || 'unknown',
        isActive: true,
        lastHeartbeat: sessionHeartbeats.get(sessionId) || Date.now()
    };
    
    broadcastToSession(sessionId, { type: 'session_update', session: sessionInfo });
}

function broadcastToSession(sessionId, data) {
    wss.clients.forEach(client => {
        if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
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
                    const sessionInfo = {
                        sessionId: data.sessionId,
                        groupUID: session.groupUID,
                        status: session.status,
                        messagesSent: session.messagesSent || 0,
                        uptime: Date.now() - session.startTime,
                        userId: session.userId,
                        type: session.type,
                        isActive: true
                    };
                    ws.send(JSON.stringify({ type: 'session_info', session: sessionInfo }));
                }
            } else if (data.type === 'heartbeat' && data.sessionId) {
                startSessionHeartbeat(data.sessionId);
            }
        } catch (error) {
            MinimalLogger.error(`WebSocket error: ${error.message}`);
        }
    });
    
    ws.on('close', () => {});
});

// ==================== API ROUTES ====================

// Start single cookie messaging
app.post('/api/start-single-messaging', async (req, res) => {
    try {
        const { cookie, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookie || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        // Check session limit
        if (activeSessions.size >= CONFIG.MAX_SESSIONS) {
            return res.json({ 
                success: false, 
                error: `Maximum session limit reached (${CONFIG.MAX_SESSIONS}). Please stop some sessions first.` 
            });
        }
        
        const sessionId = 'single_msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
            userId: 'single-cookie-user',
            type: 'single_messaging',
            isActive: true,
            autoStart: true
        };
        
        activeSessions.set(sessionId, session);
        startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'single-cookie-user', 
            message: `Single cookie messaging started`,
            sessionLimit: CONFIG.MAX_SESSIONS,
            currentSessions: activeSessions.size,
            remainingSessions: CONFIG.MAX_SESSIONS - activeSessions.size
        });
        
    } catch (error) {
        MinimalLogger.error(`Single messaging error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Start one-time login multi-cookie messaging
app.post('/api/start-one-time-messaging', async (req, res) => {
    try {
        const { cookies, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookies || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        // Check session limit
        if (activeSessions.size >= CONFIG.MAX_SESSIONS) {
            return res.json({ 
                success: false, 
                error: `Maximum session limit reached (${CONFIG.MAX_SESSIONS}). Please stop some sessions first.` 
            });
        }
        
        const sessionId = 'onetime_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const messager = new OneTimeLoginMultiCookieMessager(sessionId, cookies, groupUID, prefix, delay, messages);
        const initialized = await messager.initializeAllCookiesOnce();
        
        if (!initialized) {
            return res.json({ success: false, error: 'Failed to login with cookies' });
        }
        
        messager.start();
        const session = {
            messager,
            groupUID,
            prefix,
            delay: delay * 1000,
            messages,
            status: 'active',
            messagesSent: 0,
            startTime: Date.now(),
            userId: 'multi-cookie-user',
            type: 'one_time_messaging',
            cookiesCount: cookies.length,
            isActive: true,
            autoStart: true
        };
        
        activeSessions.set(sessionId, session);
        startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'multi-cookie-user', 
            cookiesCount: cookies.length, 
            message: `Messaging started with ${cookies.length} cookies (one-time login)`,
            sessionLimit: CONFIG.MAX_SESSIONS,
            currentSessions: activeSessions.size,
            remainingSessions: CONFIG.MAX_SESSIONS - activeSessions.size
        });
        
    } catch (error) {
        MinimalLogger.error(`Multi-messaging error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Fetch groups with names from cookie - FIXED FUNCTION
app.post('/api/fetch-groups-silent', async (req, res) => {
    try {
        const { cookie, sessionId } = req.body;
        let api = null;
        
        if (sessionId) {
            api = await new Promise((resolve) => {
                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                    resolve(fbApi);
                });
            });
        } else if (cookie) {
            api = await new Promise((resolve) => {
                silentLogin(cookie, (fbApi) => {
                    resolve(fbApi);
                });
            });
        } else {
            return res.json({ success: false, error: 'No cookie or session ID provided' });
        }
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed. Please check your cookie or session ID.' });
        }
        
        // Get thread list using proper API method
        api.getThreadList(100, null, ['INBOX'], (err, threadList) => {
            if (err) {
                MinimalLogger.error(`Thread list error: ${err.message}`);
                return res.json({ success: false, error: err.message });
            }
            
            if (!threadList || !Array.isArray(threadList)) {
                return res.json({ success: false, error: 'Failed to fetch threads' });
            }
            
            // Filter to get only groups
            const groups = threadList
                .filter(thread => {
                    // Check if it's a group (has isGroup property or has more than 2 participants)
                    return thread.isGroup || 
                           (thread.participants && thread.participants.length > 2) ||
                           thread.threadName;
                })
                .map(thread => ({
                    id: thread.threadID,
                    name: thread.threadName || thread.name || `Group ${thread.threadID.substring(0, 8)}`,
                    participants: thread.participants ? thread.participants.length : 0,
                    snippet: thread.snippet || '',
                    unreadCount: thread.unreadCount || 0
                }))
                .sort((a, b) => b.participants - a.participants);
            
            if (groups.length === 0) {
                return res.json({ 
                    success: true, 
                    groups: [], 
                    count: 0,
                    message: 'No groups found. You might not have any group conversations.'
                });
            }
            
            res.json({ 
                success: true, 
                groups, 
                count: groups.length,
                message: `Found ${groups.length} groups`
            });
            
        });
        
    } catch (error) {
        MinimalLogger.error(`Fetch groups error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Start advanced lock session
app.post('/api/start-advanced-lock', async (req, res) => {
    try {
        const { cookie, groupUID, customMessage, nicknameDelay } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        // Check session limit
        if (activeSessions.size >= CONFIG.MAX_SESSIONS) {
            return res.json({ 
                success: false, 
                error: `Maximum session limit reached (${CONFIG.MAX_SESSIONS}). Please stop some sessions first.` 
            });
        }
        
        const sessionId = 'adv_lock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        let api = null;
        let userId = null;
        
        api = await new Promise((resolve) => {
            silentLogin(cookie, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        userId = api.getCurrentUserID();
        const lockSystem = new AdvancedSafeLockSystem(sessionId, api, groupUID);
        
        if (customMessage !== undefined) {
            lockSystem.setCustomMessage(customMessage);
        }
        
        if (nicknameDelay) {
            lockSystem.setNicknameRestoreDelay(nicknameDelay);
        }
        
        const session = {
            api,
            groupUID,
            lockSystem,
            status: 'active',
            startTime: Date.now(),
            userId,
            type: 'advanced_locking',
            refreshTime: 172800000,
            customMessage: customMessage || null,
            nicknameDelay: nicknameDelay || 2,
            isActive: true,
            autoStart: true,
            lockedName: null,
            lockedNicknames: [],
            lockedSingleNickname: [],
            groupNameInterval: 60,
            allNicknamesInterval: 60,
            singleNicknameInterval: 60
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'advanced_locking');
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'advanced_locking', session.refreshTime);
        startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId, 
            message: `Advanced lock session started`,
            settings: {
                customMessage: customMessage || null,
                nicknameDelay: nicknameDelay || 2
            },
            sessionLimit: CONFIG.MAX_SESSIONS,
            currentSessions: activeSessions.size,
            remainingSessions: CONFIG.MAX_SESSIONS - activeSessions.size
        });
        
    } catch (error) {
        MinimalLogger.error(`Start lock error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// ==================== NEW: LOCK MANAGEMENT BY SESSION ID ====================

// Manage lock by session ID
app.post('/api/manage-lock-by-session', async (req, res) => {
    try {
        const { sessionId, action, lockType, lockData } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session' });
        }
        
        const lockSystem = session.lockSystem;
        if (!lockSystem) {
            return res.json({ success: false, error: 'Lock system not available' });
        }
        
        let result;
        
        switch (action) {
            case 'lock_group_name':
                if (!lockData?.groupName) {
                    return res.json({ success: false, error: 'Missing group name' });
                }
                result = await lockSystem.lockGroupName(lockData.groupName);
                break;
                
            case 'unlock_group_name':
                result = lockSystem.unlockGroupName();
                break;
                
            case 'lock_all_nicknames':
                if (!lockData?.nickname) {
                    return res.json({ success: false, error: 'Missing nickname' });
                }
                result = await lockSystem.lockAllNicknames(lockData.nickname);
                break;
                
            case 'unlock_all_nicknames':
                result = lockSystem.unlockAllNicknames();
                break;
                
            case 'lock_single_nickname':
                if (!lockData?.userID) {
                    return res.json({ success: false, error: 'Missing user ID' });
                }
                result = await lockSystem.lockSingleNickname(lockData.userID, lockData?.nickname || '');
                break;
                
            case 'unlock_single_nickname':
                if (!lockData?.userID) {
                    return res.json({ success: false, error: 'Missing user ID' });
                }
                result = lockSystem.unlockSingleNickname(lockData.userID);
                break;
                
            case 'start':
                lockSystem.start();
                session.status = 'active';
                result = { success: true, message: 'Lock session started' };
                break;
                
            case 'stop':
                lockSystem.stop();
                session.status = 'stopped';
                result = { success: true, message: 'Lock session stopped' };
                break;
                
            case 'status':
                result = { success: true, status: lockSystem.getStatus() };
                break;
                
            default:
                return res.json({ success: false, error: 'Invalid action' });
        }
        
        startSessionHeartbeat(sessionId);
        
        res.json(result);
        
    } catch (error) {
        MinimalLogger.error(`Manage lock error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Update lock settings by session ID
app.post('/api/update-lock-settings', async (req, res) => {
    try {
        const { sessionId, settings } = req.body;
        
        if (!sessionId || !settings) {
            return res.json({ success: false, error: 'Missing session ID or settings' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session' });
        }
        
        const lockSystem = session.lockSystem;
        let updates = [];
        
        if (settings.groupNameInterval !== undefined) {
            const result = lockSystem.setGroupNameInterval(settings.groupNameInterval);
            if (result.success) {
                updates.push(result.message);
                session.groupNameInterval = settings.groupNameInterval;
            }
        }
        
        if (settings.allNicknamesInterval !== undefined) {
            const result = lockSystem.setAllNicknamesInterval(settings.allNicknamesInterval);
            if (result.success) {
                updates.push(result.message);
                session.allNicknamesInterval = settings.allNicknamesInterval;
            }
        }
        
        if (settings.singleNicknameInterval !== undefined) {
            const result = lockSystem.setSingleNicknameInterval(settings.singleNicknameInterval);
            if (result.success) {
                updates.push(result.message);
                session.singleNicknameInterval = settings.singleNicknameInterval;
            }
        }
        
        if (settings.customMessage !== undefined) {
            const result = lockSystem.setCustomMessage(settings.customMessage);
            if (result.success) {
                updates.push(result.message);
                session.customMessage = settings.customMessage;
            }
        }
        
        if (settings.nicknameDelay !== undefined) {
            const result = lockSystem.setNicknameRestoreDelay(settings.nicknameDelay);
            if (result.success) {
                updates.push(result.message);
                session.nicknameDelay = settings.nicknameDelay;
            }
        }
        
        startSessionHeartbeat(sessionId);
        
        if (updates.length > 0) {
            res.json({ 
                success: true, 
                message: `Settings updated: ${updates.join(', ')}`,
                currentSettings: lockSystem.getStatus()
            });
        } else {
            res.json({ success: false, error: 'No valid updates provided' });
        }
        
    } catch (error) {
        MinimalLogger.error(`Update settings error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Add lock to existing session
app.post('/api/add-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session' });
        }
        
        let result;
        switch (lockType) {
            case 'group_name':
                result = await session.lockSystem.lockGroupName(lockData?.groupName || '');
                break;
            case 'all_nicknames':
                result = await session.lockSystem.lockAllNicknames(lockData?.nickname || '');
                break;
            case 'single_nickname':
                if (!lockData?.userID) {
                    return res.json({ success: false, error: 'Missing user ID' });
                }
                result = await session.lockSystem.lockSingleNickname(lockData.userID, lockData?.nickname || '');
                break;
            default:
                return res.json({ success: false, error: 'Invalid lock type' });
        }
        
        startSessionHeartbeat(sessionId);
        
        res.json(result);
        
    } catch (error) {
        MinimalLogger.error(`Add lock error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Remove lock from session
app.post('/api/remove-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session' });
        }
        
        let result;
        switch (lockType) {
            case 'group_name':
                result = session.lockSystem.unlockGroupName();
                break;
            case 'all_nicknames':
                result = session.lockSystem.unlockAllNicknames();
                break;
            case 'single_nickname':
                if (!lockData?.userID) {
                    return res.json({ success: false, error: 'Missing user ID' });
                }
                result = session.lockSystem.unlockSingleNickname(lockData.userID);
                break;
            default:
                return res.json({ success: false, error: 'Invalid lock type' });
        }
        
        startSessionHeartbeat(sessionId);
        
        res.json(result);
        
    } catch (error) {
        MinimalLogger.error(`Remove lock error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get session status
app.post('/api/get-session-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            const savedSession = loadPermanentSession(sessionId);
            if (savedSession) {
                return res.json({ 
                    success: true, 
                    status: {
                        sessionId,
                        type: savedSession.type,
                        userId: savedSession.userId,
                        isActive: false,
                        saved: true,
                        lastUsed: savedSession.lastUsed,
                        groupUID: savedSession.groupUID
                    }
                });
            }
            return res.json({ success: false, error: 'Session not found' });
        }
        
        let status = {};
        if (session.type === 'advanced_locking' && session.lockSystem) {
            status = session.lockSystem.getStatus();
        } else if (session.type === 'one_time_messaging' && session.messager) {
            status = session.messager.getStatus();
        } else if (session.type === 'single_messaging' && session.messaging) {
            status = session.messaging.getStatus();
        }
        
        status.sessionInfo = {
            userId: session.userId,
            startTime: session.startTime,
            uptime: Date.now() - session.startTime,
            type: session.type,
            status: session.status,
            groupUID: session.groupUID,
            isActive: session.isActive || false,
            lastHeartbeat: sessionHeartbeats.get(sessionId) || null
        };
        
        startSessionHeartbeat(sessionId);
        
        res.json({ success: true, status });
        
    } catch (error) {
        MinimalLogger.error(`Get status error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Control session (start/stop/pause)
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
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Lock session started';
                } else if (session.type === 'one_time_messaging' && session.messager) {
                    session.messager.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Messaging session started';
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Single messaging started';
                }
                break;
                
            case 'stop':
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.stop();
                } else if (session.type === 'one_time_messaging' && session.messager) {
                    session.messager.stop();
                } else if (session.type === 'single_messaging' && session.messaging) {
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

// Get messaging session status
app.post('/api/get-messaging-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'one_time_messaging' && session.type !== 'single_messaging') {
            return res.json({ success: false, error: 'Not a messaging session' });
        }
        
        let status = {};
        if (session.type === 'one_time_messaging' && session.messager) {
            status = session.messager.getStatus();
        } else if (session.type === 'single_messaging' && session.messaging) {
            status = session.messaging.getStatus();
        }
        
        status.sessionInfo = {
            userId: session.userId,
            startTime: session.startTime,
            uptime: Date.now() - session.startTime,
            type: session.type,
            status: session.status,
            groupUID: session.groupUID,
            isActive: session.isActive || false
        };
        
        startSessionHeartbeat(sessionId);
        
        res.json({ success: true, status });
        
    } catch (error) {
        MinimalLogger.error(`Get messaging status error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get user's permanent sessions
app.get('/api/my-sessions-silent/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const sessions = getSessionsByUserId(userId);
        res.json({ 
            success: true, 
            sessions: sessions.map(session => ({
                ...session,
                createdAt: new Date(session.createdAt).toLocaleString(),
                lastUsed: new Date(session.lastUsed).toLocaleString(),
                lastRefresh: new Date(session.lastRefresh).toLocaleString(),
                isActive: session.isActive || false
            })),
            totalSessions: sessions.length,
            sessionLimit: CONFIG.MAX_SESSIONS,
            remainingSessions: CONFIG.MAX_SESSIONS - sessions.length
        });
    } catch (error) {
        MinimalLogger.error(`Get sessions error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get active sessions for user
app.get('/api/my-active-sessions-silent/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const userSessions = [];
        
        for (const [sessionId, session] of activeSessions) {
            if (session.userId === userId) {
                const sessionData = {
                    sessionId,
                    type: session.type,
                    groupUID: session.groupUID,
                    status: session.status,
                    messagesSent: session.messagesSent || 0,
                    uptime: Date.now() - session.startTime,
                    startTime: session.startTime,
                    isActive: session.isActive || false,
                    lastHeartbeat: sessionHeartbeats.get(sessionId) || null
                };
                
                if (session.cookiesCount) {
                    sessionData.cookiesCount = session.cookiesCount;
                }
                
                if (session.customMessage !== undefined) {
                    sessionData.customMessage = session.customMessage;
                }
                
                userSessions.push(sessionData);
            }
        }
        
        res.json({ 
            success: true, 
            sessions: userSessions,
            totalActive: userSessions.length,
            sessionLimit: CONFIG.MAX_SESSIONS,
            remainingSessions: CONFIG.MAX_SESSIONS - userSessions.length
        });
    } catch (error) {
        MinimalLogger.error(`Get active sessions error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Stop session
app.post('/api/stop-my-session-silent', async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        if (!sessionId || !userId) {
            return res.json({ success: false, error: 'Missing session ID or user ID' });
        }
        
        if (activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            if (session.userId !== userId) {
                return res.json({ success: false, error: 'Access denied' });
            }
            
            if (session.messager) {
                session.messager.stop();
            }
            
            if (session.messaging) {
                session.messaging.stop();
            }
            
            if (session.lockSystem) {
                session.lockSystem.stop();
            }
            
            if (sessionRefreshTracker.has(sessionId)) {
                clearTimeout(sessionRefreshTracker.get(sessionId));
                sessionRefreshTracker.delete(sessionId);
            }
            
            session.status = 'stopped';
            session.isActive = false;
            
            res.json({ 
                success: true, 
                message: 'Session stopped', 
                sessionId,
                canRestart: true,
                remainingSessions: CONFIG.MAX_SESSIONS - activeSessions.size + 1
            });
        } else {
            res.json({ success: false, error: 'Session not found' });
        }
    } catch (error) {
        MinimalLogger.error(`Stop session error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Restart stopped session
app.post('/api/restart-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.status === 'active') {
            return res.json({ success: false, error: 'Session is already active' });
        }
        
        if (session.type === 'advanced_locking' && session.lockSystem) {
            session.lockSystem.start();
        } else if (session.type === 'one_time_messaging' && session.messager) {
            session.messager.start();
        } else if (session.type === 'single_messaging' && session.messaging) {
            session.messaging.start();
        }
        
        session.status = 'active';
        session.isActive = true;
        startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            message: 'Session restarted',
            sessionId,
            type: session.type,
            remainingSessions: CONFIG.MAX_SESSIONS - activeSessions.size
        });
        
    } catch (error) {
        MinimalLogger.error(`Restart session error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get system stats
app.get('/api/stats-silent', (req, res) => {
    try {
        let totalMessages = 0;
        let activeSessionsCount = 0;
        let pausedSessionsCount = 0;
        
        for (const [sessionId, session] of activeSessions) {
            if (session.status === 'active') {
                activeSessionsCount++;
            } else if (session.status === 'paused') {
                pausedSessionsCount++;
            }
            totalMessages += session.messagesSent || 0;
        }
        
        res.json({
            success: true,
            totalSessions: activeSessions.size,
            activeSessions: activeSessionsCount,
            pausedSessions: pausedSessionsCount,
            totalMessages,
            permanentSessions: permanentSessions.size,
            serverUptime: Date.now() - serverStartTime,
            wsClients: wss.clients.size,
            sessionLimit: CONFIG.MAX_SESSIONS,
            availableSlots: CONFIG.MAX_SESSIONS - activeSessions.size,
            usedPercentage: Math.round((activeSessions.size / CONFIG.MAX_SESSIONS) * 100),
            autoRecovery: true,
            heartbeatActive: true
        });
    } catch (error) {
        MinimalLogger.error(`Stats error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        serverUptime: Date.now() - serverStartTime,
        sessions: activeSessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        availableSessions: CONFIG.MAX_SESSIONS - activeSessions.size,
        memory: process.memoryUsage()
    });
});

// Session info by ID
app.get('/api/session/:sessionId', (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const session = activeSessions.get(sessionId);
        
        if (!session) {
            const permanentSession = permanentSessions.get(sessionId);
            if (permanentSession) {
                return res.json({
                    success: true,
                    session: {
                        sessionId,
                        type: permanentSession.type,
                        userId: permanentSession.userId,
                        createdAt: permanentSession.createdAt,
                        lastUsed: permanentSession.lastUsed,
                        isActive: permanentSession.isActive || false,
                        saved: true,
                        canRestart: true
                    }
                });
            }
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const sessionInfo = {
            sessionId,
            type: session.type,
            userId: session.userId,
            groupUID: session.groupUID,
            status: session.status,
            isActive: session.isActive || false,
            messagesSent: session.messagesSent || 0,
            startTime: session.startTime,
            uptime: Date.now() - session.startTime,
            lastHeartbeat: sessionHeartbeats.get(sessionId) || null,
            canControl: true
        };
        
        res.json({ success: true, session: sessionInfo });
        
    } catch (error) {
        MinimalLogger.error(`Get session info error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// ==================== SESSION MANAGEMENT TAB FUNCTIONS (FIXED) ====================

// Get session status (for session management tab)
app.post('/api/session-status-management', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        let status = {};
        if (session.type === 'advanced_locking' && session.lockSystem) {
            status = session.lockSystem.getStatus();
        } else if (session.type === 'one_time_messaging' && session.messager) {
            status = session.messager.getStatus();
        } else if (session.type === 'single_messaging' && session.messaging) {
            status = session.messaging.getStatus();
        }
        
        status.sessionInfo = {
            userId: session.userId,
            startTime: session.startTime,
            uptime: Date.now() - session.startTime,
            type: session.type,
            status: session.status,
            groupUID: session.groupUID,
            isActive: session.isActive || false
        };
        
        startSessionHeartbeat(sessionId);
        
        res.json({ success: true, status });
        
    } catch (error) {
        MinimalLogger.error(`Get session status error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Control session by ID (for session management tab)
app.post('/api/control-session-id', async (req, res) => {
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
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Lock session started';
                } else if (session.type === 'one_time_messaging' && session.messager) {
                    session.messager.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Messaging session started';
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.start();
                    session.status = 'active';
                    session.isActive = true;
                    result.message = 'Single messaging started';
                }
                break;
                
            case 'stop':
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.stop();
                } else if (session.type === 'one_time_messaging' && session.messager) {
                    session.messager.stop();
                } else if (session.type === 'single_messaging' && session.messaging) {
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

// Get user sessions (for session management tab)
app.get('/api/user-sessions/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const userSessions = [];
        
        for (const [sessionId, session] of activeSessions) {
            if (session.userId === userId) {
                const sessionData = {
                    sessionId,
                    type: session.type,
                    groupUID: session.groupUID,
                    status: session.status,
                    messagesSent: session.messagesSent || 0,
                    uptime: Date.now() - session.startTime,
                    startTime: session.startTime,
                    isActive: session.isActive || false
                };
                
                if (session.cookiesCount) {
                    sessionData.cookiesCount = session.cookiesCount;
                }
                
                userSessions.push(sessionData);
            }
        }
        
        res.json({ 
            success: true, 
            sessions: userSessions,
            total: userSessions.length
        });
    } catch (error) {
        MinimalLogger.error(`Get user sessions error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// ==================== HTML INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔒 RAJ ULTIMATE SYSTEM - Safe Messaging & Locking</title>
    <style>
        :root {
            --primary: #6a11cb;
            --secondary: #2575fc;
            --success: #00b09b;
            --danger: #ff416c;
            --warning: #ffb347;
            --info: #36d1dc;
            --dark: #2c3e50;
            --light: #f8f9fa;
            --gradient-primary: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
        }
        
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
            background: var(--gradient-primary);
            color: white;
            padding: 30px;
            text-align: center;
            border-bottom: 3px solid var(--secondary);
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
            background: var(--light);
            border-bottom: 2px solid #ddd;
            overflow-x: auto;
        }
        
        .tab {
            padding: 20px 30px;
            cursor: pointer;
            font-weight: 600;
            color: var(--dark);
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
            border-bottom: 4px solid var(--primary);
            color: var(--primary);
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
            color: var(--primary);
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
        
        .form-label-big {
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
            background: white;
        }
        
        .form-control:focus {
            outline: none;
            border-color: var(--primary);
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
            background: var(--gradient-primary);
            color: white;
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 20px rgba(106, 17, 203, 0.3);
        }
        
        .btn-success {
            background: linear-gradient(135deg, var(--success) 0%, #96c93d 100%);
            color: white;
        }
        
        .btn-danger {
            background: linear-gradient(135deg, var(--danger) 0%, #ff4b2b 100%);
            color: white;
        }
        
        .btn-warning {
            background: linear-gradient(135deg, var(--warning) 0%, #ffcc33 100%);
            color: #212529;
        }
        
        .btn-info {
            background: linear-gradient(135deg, var(--info) 0%, #5bc0de 100%);
            color: white;
        }
        
        .btn-group {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 20px;
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
        
        .session-id {
            font-family: monospace;
            background: #f0f0f0;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            word-break: break-all;
            font-size: 1.1em;
        }
        
        .status-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.9em;
        }
        
        .status-active {
            background: #d4edda;
            color: #155724;
        }
        
        .status-paused {
            background: #fff3cd;
            color: #856404;
        }
        
        .status-inactive {
            background: #f8d7da;
            color: #721c24;
        }
        
        .feature-section {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 2px dashed #ddd;
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
        }
        
        .checkbox-group input[type="checkbox"] {
            width: 20px;
            height: 20px;
        }
        
        .file-upload {
            border: 2px dashed #ced4da;
            border-radius: 10px;
            padding: 30px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
            background: #f8f9fa;
        }
        
        .file-upload:hover {
            border-color: var(--primary);
            background: #e9ecef;
        }
        
        .file-upload input {
            display: none;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            border-top: 5px solid var(--primary);
        }
        
        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            color: var(--primary);
            margin: 10px 0;
        }
        
        .stat-label {
            color: #666;
            font-size: 1em;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 2000;
            align-items: center;
            justify-content: center;
        }
        
        .modal-content {
            background: white;
            padding: 40px;
            border-radius: 20px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        
        .modal-title {
            font-size: 1.8em;
            color: var(--primary);
            margin-bottom: 20px;
        }
        
        .close-modal {
            float: right;
            font-size: 28px;
            cursor: pointer;
            color: #999;
        }
        
        .close-modal:hover {
            color: var(--danger);
        }
        
        .alert {
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 15px;
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
        
        .alert-info {
            background: #d1ecf1;
            color: #0c5460;
            border: 1px solid #bee5eb;
        }
        
        .help-text-big {
            color: #495057;
            font-size: 0.9em;
            margin-top: 8px;
            display: block;
        }
        
        .hidden {
            display: none;
        }
        
        .section-divider {
            height: 2px;
            background: linear-gradient(to right, transparent, var(--primary), transparent);
            margin: 30px 0;
        }
        
        .groups-list {
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 10px;
            padding: 10px;
            margin-top: 10px;
        }
        
        .group-item {
            padding: 10px;
            border-bottom: 1px solid #eee;
            cursor: pointer;
            transition: background 0.3s;
        }
        
        .group-item:hover {
            background: #f0f0f0;
        }
        
        .highlight-box {
            background: linear-gradient(135deg, rgba(106, 17, 203, 0.05) 0%, rgba(37, 117, 252, 0.05) 100%);
            padding: 20px;
            border-radius: 10px;
            border: 2px solid rgba(106, 17, 203, 0.2);
            margin: 20px 0;
        }
        
        .control-panel {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .control-item {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
        }
        
        .input-group {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        
        .session-controls {
            display: flex;
            gap: 10px;
            margin-top: 15px;
            flex-wrap: wrap;
        }
        
        .lock-item {
            background: white;
            border: 1px solid #eaeaea;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .lock-info {
            flex: 1;
        }
        
        .lock-actions {
            display: flex;
            gap: 10px;
        }
        
        .real-time-stats {
            display: flex;
            justify-content: space-between;
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        
        .stat-item-small {
            text-align: center;
            flex: 1;
        }
        
        .stat-value-small {
            font-size: 1.5em;
            font-weight: bold;
            color: var(--primary);
            display: block;
        }
        
        .stat-label-small {
            font-size: 0.8em;
            color: #666;
        }
        
        .progress-bar {
            height: 8px;
            background: #eaeaea;
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        
        .progress-fill {
            height: 100%;
            background: var(--gradient-primary);
            transition: width 0.3s;
        }
        
        .uptime-display {
            font-family: monospace;
            background: #f0f0f0;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            font-size: 1.1em;
            text-align: center;
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
            <h1><i class="fas fa-shield-alt"></i> RAJ ULTIMATE SYSTEM</h1>
            <div class="subtitle">Safe Permanent Messaging • Advanced Locking • Individual Monitoring</div>
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
            <div class="stat-item">
                <span class="stat-value" id="sessionLimit">${CONFIG.MAX_SESSIONS}</span>
                <span class="stat-label">SESSION LIMIT</span>
            </div>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('single_messaging')">
                <i class="fas fa-comment"></i> Single Cookie Messaging
            </div>
            <div class="tab" onclick="switchTab('multi_messaging')">
                <i class="fas fa-exchange-alt"></i> Multi-Cookie Messaging
            </div>
            <div class="tab" onclick="switchTab('advanced_locking')">
                <i class="fas fa-user-shield"></i> Advanced Locking
            </div>
            <div class="tab" onclick="switchTab('fetch_groups')">
                <i class="fas fa-users"></i> Fetch Groups
            </div>
            <div class="tab active" onclick="switchTab('session_manage')">
                <i class="fas fa-tasks"></i> Session Management
            </div>
        </div>
        
        <!-- SINGLE MESSAGING TAB -->
        <div id="single_messagingTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-comment"></i> SINGLE COOKIE MESSAGING
                        </div>
                        <div class="highlight-box">
                            <i class="fas fa-info-circle"></i>
                            <strong>SAFE PERMANENT MESSAGING:</strong><br>
                            • Single cookie login<br>
                            • Automatic reconnection<br>
                            • Safe delays between messages<br>
                            • Permanent session saving
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE:
                            </label>
                            <textarea class="form-control" id="singleCookie" placeholder="PASTE YOUR FACEBOOK COOKIE HERE" style="min-height: 100px;"></textarea>
                            <span class="help-text-big">Paste one Facebook cookie for messaging</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-users"></i> GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="singleGroupUID" placeholder="ENTER FACEBOOK GROUP ID">
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-tag"></i> MESSAGE PREFIX:
                            </label>
                            <input type="text" class="form-control" id="singlePrefix" value="💬 " placeholder="PREFIX FOR ALL MESSAGES">
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-clock"></i> DELAY BETWEEN MESSAGES (SECONDS):
                            </label>
                            <input type="number" class="form-control" id="singleDelay" value="10" min="5" max="300">
                            <span class="help-text-big">Safe delay between messages (5-300 seconds)</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-file-alt"></i> MESSAGES FILE (.TXT):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('singleMessageFile').click()">
                                <i class="fas fa-file-alt fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
                                <p style="font-size: 1.1em; font-weight: 600;">CLICK TO UPLOAD MESSAGES.TXT FILE</p>
                                <p><small style="font-size: 0.9em;">ONE MESSAGE PER LINE</small></p>
                                <input type="file" id="singleMessageFile" accept=".txt" onchange="handleSingleMessageFile()" required>
                            </div>
                            <div id="singleMessageFileInfo" class="hidden" style="margin-top: 10px; padding: 15px; background: #f0f0f0; border-radius: 5px;">
                                <span id="singleMessageCount" style="font-size: 1.2em; font-weight: bold;">0</span> MESSAGES LOADED
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-success btn-block" onclick="startSingleMessaging()">
                                <i class="fas fa-play-circle"></i> START SINGLE MESSAGING
                            </button>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> MESSAGING LOGS
                        </div>
                        <div class="logs-container" id="singleMessagingLogs">
                            <div class="log-entry log-info">Single messaging system ready</div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-secondary" onclick="clearLogs('singleMessagingLogs')">
                                <i class="fas fa-trash"></i> CLEAR LOGS
                            </button>
                        </div>
                    </div>
                    <div class="card" id="singleSessionCard" style="display: none;">
                        <div class="card-title">
                            <i class="fas fa-user-clock"></i> CURRENT SESSION
                        </div>
                        <div class="uptime-display" id="singleUptime">Uptime: 0s</div>
                        <div class="session-id" id="singleSessionId"></div>
                        <div class="session-controls">
                            <button class="btn btn-info" onclick="getSingleMessagingStatus()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                            <button class="btn btn-danger" onclick="stopSingleSession()">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- MULTI MESSAGING TAB -->
        <div id="multi_messagingTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-exchange-alt"></i> MULTI-COOKIE MESSAGING
                        </div>
                        <div class="highlight-box">
                            <i class="fas fa-info-circle"></i>
                            <strong>ONE TIME LOGIN SYSTEM:</strong><br>
                            • All cookies login ONCE at start<br>
                            • Each message uses different cookie<br>
                            • No re-login during messaging
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-cookie-bite"></i> MULTIPLE FACEBOOK COOKIES (.TXT FILE):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('multiCookieFile').click()">
                                <i class="fas fa-cloud-upload-alt fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
                                <p style="font-size: 1.1em; font-weight: 600;">CLICK TO UPLOAD COOKIES.TXT FILE</p>
                                <p><small style="font-size: 0.9em;">ONE COOKIE PER LINE - WILL LOGIN ONCE</small></p>
                                <input type="file" id="multiCookieFile" accept=".txt" onchange="handleMultiCookieFile()" required>
                            </div>
                            <div id="multiCookieFileInfo" class="hidden" style="margin-top: 10px; padding: 15px; background: #f0f0f0; border-radius: 5px;">
                                <span id="multiCookieCount" style="font-size: 1.2em; font-weight: bold;">0</span> COOKIES LOADED
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-users"></i> GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="multiGroupUID" placeholder="ENTER FACEBOOK GROUP ID">
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-tag"></i> MESSAGE PREFIX:
                            </label>
                            <input type="text" class="form-control" id="multiPrefix" value="💬 " placeholder="PREFIX FOR ALL MESSAGES">
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-clock"></i> DELAY BETWEEN MESSAGES (SECONDS):
                            </label>
                            <input type="number" class="form-control" id="multiDelay" value="10" min="5" max="300">
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-file-alt"></i> MESSAGES FILE (.TXT):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('multiMessageFile').click()">
                                <i class="fas fa-file-alt fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
                                <p style="font-size: 1.1em; font-weight: 600;">CLICK TO UPLOAD MESSAGES.TXT FILE</p>
                                <p><small style="font-size: 0.9em;">ONE MESSAGE PER LINE</small></p>
                                <input type="file" id="multiMessageFile" accept=".txt" onchange="handleMultiMessageFile()" required>
                            </div>
                            <div id="multiMessageFileInfo" class="hidden" style="margin-top: 10px; padding: 15px; background: #f0f0f0; border-radius: 5px;">
                                <span id="multiMessageCount" style="font-size: 1.2em; font-weight: bold;">0</span> MESSAGES LOADED
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-success btn-block" onclick="startMultiMessaging()">
                                <i class="fas fa-play-circle"></i> START MULTI-COOKIE MESSAGING
                            </button>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> MESSAGING LOGS
                        </div>
                        <div class="logs-container" id="multiMessagingLogs">
                            <div class="log-entry log-info">Multi-cookie messaging system ready</div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-secondary" onclick="clearLogs('multiMessagingLogs')">
                                <i class="fas fa-trash"></i> CLEAR LOGS
                            </button>
                        </div>
                    </div>
                    <div class="card" id="multiSessionCard" style="display: none;">
                        <div class="card-title">
                            <i class="fas fa-user-clock"></i> CURRENT SESSION
                        </div>
                        <div class="uptime-display" id="multiUptime">Uptime: 0s</div>
                        <div class="session-id" id="multiSessionId"></div>
                        <div class="session-controls">
                            <button class="btn btn-info" onclick="getMultiMessagingStatus()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                            <button class="btn btn-danger" onclick="stopMultiSession()">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- ADVANCED LOCKING TAB -->
        <div id="advanced_lockingTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-user-shield"></i> ADVANCED LOCK SESSION
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE:
                            </label>
                            <textarea class="form-control" id="lockCookie" placeholder="PASTE YOUR FACEBOOK COOKIE HERE" style="min-height: 100px;"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-users"></i> GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="lockGroupUID" placeholder="ENTER GROUP ID TO PROTECT">
                        </div>
                        <div class="control-panel">
                            <div class="control-item">
                                <label class="form-label-big">
                                    <i class="fas fa-comment-alt"></i> NOTIFICATION MESSAGE (OPTIONAL):
                                </label>
                                <input type="text" class="form-control" id="lockCustomMessage" placeholder="Enter notification message (optional)">
                            </div>
                            <div class="control-item">
                                <label class="form-label-big">
                                    <i class="fas fa-hourglass-half"></i> NICKNAME DELAY (SECONDS):
                                </label>
                                <input type="number" class="form-control" id="lockNicknameDelay" value="2" min="1" max="10">
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary" onclick="startAdvancedLock()">
                                <i class="fas fa-play-circle"></i> START LOCK SESSION
                            </button>
                            <button class="btn btn-info" onclick="fetchGroupsForLock()">
                                <i class="fas fa-sync-alt"></i> FETCH GROUPS
                            </button>
                        </div>
                        <div class="session-id" id="lockSessionId" style="display: none;">
                            <strong>SESSION ID:</strong> <span id="lockSessionIdValue"></span>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-lock"></i> INDIVIDUAL LOCKS (ALL OPTIONAL)
                        </div>
                        <div class="feature-section">
                            <div class="checkbox-group">
                                <input type="checkbox" id="enableGroupNameLock" onclick="toggleGroupNameLock()">
                                <label for="enableGroupNameLock">
                                    <i class="fas fa-heading"></i> GROUP NAME LOCK (OPTIONAL)
                                </label>
                            </div>
                            <div id="groupNameLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="groupNameToLock" placeholder="Enter group name to lock (optional)">
                                <div class="input-group">
                                    <input type="number" class="form-control" id="groupNameInterval" placeholder="Monitoring interval (1-86400s)" value="60" min="1" max="86400">
                                    <span class="help-text-big">seconds (1-86400)</span>
                                </div>
                                <div class="btn-group" style="margin-top: 10px;">
                                    <button class="btn btn-success" onclick="lockGroupName()">
                                        <i class="fas fa-lock"></i> LOCK
                                    </button>
                                    <button class="btn btn-danger" onclick="unlockGroupName()">
                                        <i class="fas fa-unlock"></i> UNLOCK
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div class="feature-section">
                            <div class="checkbox-group">
                                <input type="checkbox" id="enableAllNicknames" onclick="toggleAllNicknamesLock()">
                                <label for="enableAllNicknames">
                                    <i class="fas fa-users"></i> ALL NICKNAMES LOCK (OPTIONAL)
                                </label>
                            </div>
                            <div id="allNicknamesLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="nicknameForAll" placeholder="Enter nickname for all members (optional)">
                                <div class="input-group">
                                    <input type="number" class="form-control" id="allNicknamesInterval" placeholder="Monitoring interval (1-86400s)" value="60" min="1" max="86400">
                                    <span class="help-text-big">seconds (1-86400)</span>
                                </div>
                                <div class="btn-group" style="margin-top: 10px;">
                                    <button class="btn btn-success" onclick="lockAllNicknames()">
                                        <i class="fas fa-lock"></i> LOCK ALL
                                    </button>
                                    <button class="btn btn-danger" onclick="unlockAllNicknames()">
                                        <i class="fas fa-unlock"></i> UNLOCK ALL
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div class="feature-section">
                            <div class="checkbox-group">
                                <input type="checkbox" id="enableSingleNickname" onclick="toggleSingleNicknameLock()">
                                <label for="enableSingleNickname">
                                    <i class="fas fa-user"></i> SINGLE USER LOCK (OPTIONAL)
                                </label>
                            </div>
                            <div id="singleNicknameLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="singleLockUserID" placeholder="Enter User ID" style="margin-bottom: 10px;">
                                <input type="text" class="form-control" id="singleLockNickname" placeholder="Enter nickname (optional)">
                                <div class="input-group">
                                    <input type="number" class="form-control" id="singleNicknameInterval" placeholder="Monitoring interval (1-86400s)" value="60" min="1" max="86400">
                                    <span class="help-text-big">seconds (1-86400)</span>
                                </div>
                                <div class="btn-group" style="margin-top: 10px;">
                                    <button class="btn btn-success" onclick="lockSingleNickname()">
                                        <i class="fas fa-lock"></i> LOCK USER
                                    </button>
                                    <button class="btn btn-danger" onclick="unlockSingleNickname()">
                                        <i class="fas fa-unlock"></i> UNLOCK
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-sliders-h"></i> SESSION MANAGEMENT
                        </div>
                        <div class="real-time-stats">
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="lockUptime">0s</span>
                                <span class="stat-label-small">Uptime</span>
                            </div>
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="activeLocks">0</span>
                                <span class="stat-label-small">Active Locks</span>
                            </div>
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="lockStatus">Off</span>
                                <span class="stat-label-small">Status</span>
                            </div>
                        </div>
                        <div class="session-controls">
                            <button class="btn btn-success" onclick="controlSession('start')">
                                <i class="fas fa-play"></i> START
                            </button>
                            <button class="btn btn-warning" onclick="controlSession('pause')">
                                <i class="fas fa-pause"></i> PAUSE
                            </button>
                            <button class="btn btn-danger" onclick="controlSession('stop')">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                            <button class="btn btn-info" onclick="getLockStatus()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                        </div>
                        
                        <div class="feature-section">
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-cog"></i> UPDATE SETTINGS BY SESSION ID
                                </label>
                                <input type="text" class="form-control" id="updateSessionId" placeholder="Enter Session ID to update">
                                <div class="input-group" style="margin-top: 10px;">
                                    <input type="text" class="form-control" id="updateNotification" placeholder="Update notification message">
                                    <button class="btn btn-primary" onclick="updateLockSettings()">
                                        <i class="fas fa-save"></i> UPDATE
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div id="currentLocks" style="margin-top: 20px;">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-lock fa-3x"></i>
                                <p style="margin-top: 15px;">No active locks</p>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> LOCKING LOGS
                        </div>
                        <div class="logs-container" id="lockingLogs">
                            <div class="log-entry log-info">
                                <span class="log-time">[SYSTEM]</span>
                                Advanced locking system ready
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-secondary" onclick="clearLogs('lockingLogs')">
                                <i class="fas fa-trash"></i> CLEAR
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- FETCH GROUPS TAB -->
        <div id="fetch_groupsTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-users"></i> FETCH YOUR GROUPS
                        </div>
                        <div class="highlight-box">
                            <i class="fas fa-info-circle"></i>
                            <strong>GROUP FETCHER:</strong><br>
                            • Get all your Facebook groups<br>
                            • View group names and participant counts<br>
                            • Click to copy Group ID to clipboard
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE:
                            </label>
                            <textarea class="form-control" id="fetchCookie" placeholder="PASTE YOUR FACEBOOK COOKIE HERE" style="min-height: 120px;"></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-id-card"></i> OR USE SESSION ID:
                            </label>
                            <input type="text" class="form-control" id="fetchSessionId" placeholder="Enter existing Session ID (optional)">
                            <span class="help-text-big">If you already have a session, enter the Session ID</span>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-block" onclick="fetchGroupsSilent()">
                                <i class="fas fa-sync-alt"></i> FETCH MY GROUPS
                            </button>
                        </div>
                        <div id="fetchStatus" style="margin-top: 15px; display: none;"></div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-list"></i> YOUR GROUPS
                        </div>
                        <div id="groupsListContainer" style="min-height: 500px;">
                            <div style="text-align: center; padding: 60px 20px; color: #666;">
                                <i class="fas fa-users fa-4x" style="margin-bottom: 20px; color: #ccc;"></i>
                                <h3 style="margin-bottom: 10px;">NO GROUPS LOADED</h3>
                                <p>Enter cookie and click "Fetch My Groups" to see your groups</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- SESSION MANAGEMENT TAB -->
        <div id="session_manageTab" class="tab-content active">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-user"></i> MANAGE BY SESSION ID
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-id-card"></i> SESSION ID:
                            </label>
                            <input type="text" class="form-control" id="manageSessionId" placeholder="ENTER SESSION ID TO MANAGE">
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary" onclick="getSessionStatus()">
                                <i class="fas fa-search"></i> GET STATUS
                            </button>
                            <button class="btn btn-info" onclick="controlSessionById()">
                                <i class="fas fa-cogs"></i> CONTROL
                            </button>
                            <button class="btn btn-danger" onclick="stopSessionById()">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                        </div>
                        
                        <div class="feature-section">
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-wrench"></i> UPDATE LOCK SETTINGS:
                                </label>
                                <div class="control-panel">
                                    <div class="control-item">
                                        <label>Group Name Interval (1-86400s):</label>
                                        <input type="number" class="form-control" id="updateGroupNameInterval" min="1" max="86400" placeholder="seconds">
                                    </div>
                                    <div class="control-item">
                                        <label>All Nicknames Interval (1-86400s):</label>
                                        <input type="number" class="form-control" id="updateAllNickInterval" min="1" max="86400" placeholder="seconds">
                                    </div>
                                    <div class="control-item">
                                        <label>Single Nickname Interval (1-86400s):</label>
                                        <input type="number" class="form-control" id="updateSingleNickInterval" min="1" max="86400" placeholder="seconds">
                                    </div>
                                </div>
                                <button class="btn btn-primary btn-block" onclick="updateSessionIntervals()" style="margin-top: 10px;">
                                    <i class="fas fa-save"></i> UPDATE INTERVALS
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-info-circle"></i> SESSION STATUS
                        </div>
                        <div id="sessionStatusInfo" style="padding: 20px;">
                            <div style="text-align: center; color: #666;">
                                <i class="fas fa-search fa-3x"></i>
                                <p style="margin-top: 15px;">Enter Session ID and click "Get Status"</p>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-history"></i> MY ACTIVE SESSIONS
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">YOUR USER ID:</label>
                            <input type="text" class="form-control" id="myUserId" placeholder="ENTER YOUR USER ID">
                        </div>
                        <button class="btn btn-primary btn-block" onclick="loadMySessions()">
                            <i class="fas fa-sync-alt"></i> LOAD MY SESSIONS
                        </button>
                        <div id="myActiveSessions" style="margin-top: 20px;">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-clock fa-3x"></i>
                                <p style="margin-top: 10px;">Enter User ID to load sessions</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Session ID Modal -->
    <div class="modal" id="sessionModal">
        <div class="modal-content">
            <span class="close-modal" onclick="closeModal()">&times;</span>
            <h2 class="modal-title"><i class="fas fa-key"></i> SESSION CREATED</h2>
            <div class="alert alert-success">
                <i class="fas fa-check-circle"></i>
                <div>
                    <strong>SESSION STARTED SUCCESSFULLY!</strong><br>
                    Save your Session ID to manage this session later.
                </div>
            </div>
            <p><strong>SESSION ID:</strong></p>
            <div class="session-id" id="modalSessionId"></div>
            <p><strong>TYPE:</strong> <span id="modalSessionType"></span></p>
            <p style="margin-top: 15px; color: #666;">
                <i class="fas fa-exclamation-triangle"></i> SAVE THIS ID NOW! It won't be shown again.
            </p>
            <div class="btn-group" style="margin-top: 20px;">
                <button class="btn btn-primary" onclick="copyModalSessionId()">
                    <i class="fas fa-copy"></i> COPY SESSION ID
                </button>
                <button class="btn btn-success" onclick="closeModal()">
                    <i class="fas fa-check"></i> GOT IT
                </button>
            </div>
        </div>
    </div>
    
    <script>
        // Global variables
        let currentSingleSessionId = null;
        let currentMultiSessionId = null;
        let currentLockSessionId = null;
        let serverStartTime = Date.now();
        
        // Tab management
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + 'Tab').classList.add('active');
            
            const tabs = document.querySelectorAll('.tab');
            tabs.forEach(tab => {
                if (tab.textContent.includes(tabName.charAt(0).toUpperCase() + tabName.slice(1).replace('_', ' '))) {
                    tab.classList.add('active');
                }
            });
        }
        
        // Single Messaging
        let singleMessages = [];
        
        function handleSingleMessageFile() {
            const file = document.getElementById('singleMessageFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                singleMessages = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                document.getElementById('singleMessageCount').textContent = singleMessages.length;
                document.getElementById('singleMessageFileInfo').style.display = 'block';
                addLog('singleMessagingLogs', \`Loaded \${singleMessages.length} messages\`, 'success');
            };
            reader.readAsText(file);
        }
        
        async function startSingleMessaging() {
            const cookie = document.getElementById('singleCookie').value.trim();
            const groupUID = document.getElementById('singleGroupUID').value.trim();
            const prefix = document.getElementById('singlePrefix').value.trim();
            const delay = parseInt(document.getElementById('singleDelay').value);
            
            if (!cookie || !groupUID) {
                alert('Please enter cookie and Group UID');
                return;
            }
            
            if (singleMessages.length === 0) {
                alert('Please upload messages file');
                return;
            }
            
            if (isNaN(delay) || delay < 5 || delay > 300) {
                alert('Delay must be between 5-300 seconds');
                return;
            }
            
            addLog('singleMessagingLogs', 'Starting single cookie messaging...', 'info');
            
            try {
                const response = await fetch('/api/start-single-messaging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookie,
                        groupUID,
                        prefix,
                        delay,
                        messages: singleMessages
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentSingleSessionId = data.sessionId;
                    
                    document.getElementById('singleSessionId').textContent = currentSingleSessionId;
                    document.getElementById('singleSessionCard').style.display = 'block';
                    
                    document.getElementById('modalSessionId').textContent = currentSingleSessionId;
                    document.getElementById('modalSessionType').textContent = 'Single Messaging';
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    addLog('singleMessagingLogs', \`Single messaging started: \${currentSingleSessionId}\`, 'success');
                    
                    updateSingleUptime();
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('singleMessagingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('singleMessagingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        async function getSingleMessagingStatus() {
            if (!currentSingleSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/get-messaging-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSingleSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    document.getElementById('singleUptime').textContent = \`Uptime: \${formatTime(data.status.uptime)}\`;
                    addLog('singleMessagingLogs', \`Status: \${data.status.messagesSent} messages sent\`, 'info');
                }
            } catch (error) {
                console.error('Status error:', error);
            }
        }
        
        function updateSingleUptime() {
            if (!currentSingleSessionId) return;
            
            setInterval(async () => {
                try {
                    const response = await fetch('/api/get-messaging-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: currentSingleSessionId })
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        document.getElementById('singleUptime').textContent = \`Uptime: \${formatTime(data.status.uptime)}\`;
                    }
                } catch (error) {
                    console.error('Uptime update error:', error);
                }
            }, 5000);
        }
        
        async function stopSingleSession() {
            if (!currentSingleSessionId) {
                alert('No active session');
                return;
            }
            
            if (!confirm('Stop this messaging session?')) return;
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentSingleSessionId,
                        action: 'stop'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    currentSingleSessionId = null;
                    document.getElementById('singleSessionCard').style.display = 'none';
                    addLog('singleMessagingLogs', 'Session stopped', 'success');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Multi Messaging
        let multiCookies = [];
        let multiMessages = [];
        
        function handleMultiCookieFile() {
            const file = document.getElementById('multiCookieFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                multiCookies = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith('#'));
                document.getElementById('multiCookieCount').textContent = multiCookies.length;
                document.getElementById('multiCookieFileInfo').style.display = 'block';
                addLog('multiMessagingLogs', \`Loaded \${multiCookies.length} cookies\`, 'success');
            };
            reader.readAsText(file);
        }
        
        function handleMultiMessageFile() {
            const file = document.getElementById('multiMessageFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                multiMessages = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                document.getElementById('multiMessageCount').textContent = multiMessages.length;
                document.getElementById('multiMessageFileInfo').style.display = 'block';
                addLog('multiMessagingLogs', \`Loaded \${multiMessages.length} messages\`, 'success');
            };
            reader.readAsText(file);
        }
        
        async function startMultiMessaging() {
            if (multiCookies.length === 0) {
                alert('Please upload cookies file');
                return;
            }
            
            const groupUID = document.getElementById('multiGroupUID').value.trim();
            const prefix = document.getElementById('multiPrefix').value.trim();
            const delay = parseInt(document.getElementById('multiDelay').value);
            
            if (!groupUID) {
                alert('Please enter Group UID');
                return;
            }
            
            if (multiMessages.length === 0) {
                alert('Please upload messages file');
                return;
            }
            
            if (isNaN(delay) || delay < 5 || delay > 300) {
                alert('Delay must be between 5-300 seconds');
                return;
            }
            
            addLog('multiMessagingLogs', \`Starting multi-cookie messaging with \${multiCookies.length} cookies...\`, 'info');
            
            try {
                const response = await fetch('/api/start-one-time-messaging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookies: multiCookies,
                        groupUID,
                        prefix,
                        delay,
                        messages: multiMessages
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentMultiSessionId = data.sessionId;
                    
                    document.getElementById('multiSessionId').textContent = currentMultiSessionId;
                    document.getElementById('multiSessionCard').style.display = 'block';
                    
                    document.getElementById('modalSessionId').textContent = currentMultiSessionId;
                    document.getElementById('modalSessionType').textContent = 'Multi-Cookie Messaging';
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    addLog('multiMessagingLogs', \`Multi-cookie messaging started: \${currentMultiSessionId}\`, 'success');
                    addLog('multiMessagingLogs', \`\${data.cookiesCount} cookies logged in once\`, 'success');
                    
                    updateMultiUptime();
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('multiMessagingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('multiMessagingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        async function getMultiMessagingStatus() {
            if (!currentMultiSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/get-messaging-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentMultiSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    document.getElementById('multiUptime').textContent = \`Uptime: \${formatTime(data.status.uptime)}\`;
                    addLog('multiMessagingLogs', \`Status: \${data.status.messagesSent} messages sent, \${data.status.activeCookies} active cookies\`, 'info');
                }
            } catch (error) {
                console.error('Status error:', error);
            }
        }
        
        function updateMultiUptime() {
            if (!currentMultiSessionId) return;
            
            setInterval(async () => {
                try {
                    const response = await fetch('/api/get-messaging-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: currentMultiSessionId })
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        document.getElementById('multiUptime').textContent = \`Uptime: \${formatTime(data.status.uptime)}\`;
                    }
                } catch (error) {
                    console.error('Uptime update error:', error);
                }
            }, 5000);
        }
        
        async function stopMultiSession() {
            if (!currentMultiSessionId) {
                alert('No active session');
                return;
            }
            
            if (!confirm('Stop this messaging session?')) return;
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentMultiSessionId,
                        action: 'stop'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    currentMultiSessionId = null;
                    document.getElementById('multiSessionCard').style.display = 'none';
                    addLog('multiMessagingLogs', 'Session stopped', 'success');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Advanced Locking
        async function startAdvancedLock() {
            const cookie = document.getElementById('lockCookie').value.trim();
            const groupUID = document.getElementById('lockGroupUID').value.trim();
            const customMessage = document.getElementById('lockCustomMessage').value.trim() || null;
            const nicknameDelay = parseInt(document.getElementById('lockNicknameDelay').value);
            
            if (!cookie || !groupUID) {
                alert('Please enter cookie and Group UID');
                return;
            }
            
            if (isNaN(nicknameDelay) || nicknameDelay < 1 || nicknameDelay > 10) {
                alert('Nickname delay must be between 1-10 seconds');
                return;
            }
            
            addLog('lockingLogs', 'Starting advanced lock session...', 'info');
            
            try {
                const response = await fetch('/api/start-advanced-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookie,
                        groupUID,
                        customMessage,
                        nicknameDelay
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentLockSessionId = data.sessionId;
                    
                    document.getElementById('lockSessionIdValue').textContent = currentLockSessionId;
                    document.getElementById('lockSessionId').style.display = 'block';
                    
                    document.getElementById('modalSessionId').textContent = currentLockSessionId;
                    document.getElementById('modalSessionType').textContent = 'Advanced Locking';
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    addLog('lockingLogs', \`Advanced lock session started: \${currentLockSessionId}\`, 'success');
                    
                    startLockMonitoring();
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('lockingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('lockingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        function toggleGroupNameLock() {
            const enabled = document.getElementById('enableGroupNameLock').checked;
            document.getElementById('groupNameLockSection').style.display = enabled ? 'block' : 'none';
        }
        
        function toggleAllNicknamesLock() {
            const enabled = document.getElementById('enableAllNicknames').checked;
            document.getElementById('allNicknamesLockSection').style.display = enabled ? 'block' : 'none';
        }
        
        function toggleSingleNicknameLock() {
            const enabled = document.getElementById('enableSingleNickname').checked;
            document.getElementById('singleNicknameLockSection').style.display = enabled ? 'block' : 'none';
        }
        
        async function lockGroupName() {
            if (!currentLockSessionId) {
                alert('Please start a lock session first');
                return;
            }
            
            const groupName = document.getElementById('groupNameToLock').value.trim();
            const interval = parseInt(document.getElementById('groupNameInterval').value);
            
            if (isNaN(interval) || interval < 1 || interval > 86400) {
                alert('Monitoring interval must be between 1-86400 seconds');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'group_name',
                        lockData: { groupName }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    await updateLockInterval('group_name', interval);
                    alert('Group name lock set');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function unlockGroupName() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/remove-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'group_name'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Group name lock removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function lockAllNicknames() {
            if (!currentLockSessionId) {
                alert('Please start a lock session first');
                return;
            }
            
            const nickname = document.getElementById('nicknameForAll').value.trim();
            const interval = parseInt(document.getElementById('allNicknamesInterval').value);
            
            if (isNaN(interval) || interval < 1 || interval > 86400) {
                alert('Monitoring interval must be between 1-86400 seconds');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'all_nicknames',
                        lockData: { nickname }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    await updateLockInterval('all_nicknames', interval);
                    alert(\`All nicknames lock set\`);
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function unlockAllNicknames() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/remove-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'all_nicknames'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('All nicknames lock removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function lockSingleNickname() {
            if (!currentLockSessionId) {
                alert('Please start a lock session first');
                return;
            }
            
            const userID = document.getElementById('singleLockUserID').value.trim();
            const nickname = document.getElementById('singleLockNickname').value.trim();
            const interval = parseInt(document.getElementById('singleNicknameInterval').value);
            
            if (!userID) {
                alert('Please enter User ID');
                return;
            }
            
            if (isNaN(interval) || interval < 1 || interval > 86400) {
                alert('Monitoring interval must be between 1-86400 seconds');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'single_nickname',
                        lockData: { userID, nickname }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    await updateLockInterval('single_nickname', interval);
                    alert('Single nickname lock set');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function unlockSingleNickname() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            const userID = document.getElementById('singleLockUserID').value.trim();
            if (!userID) {
                alert('Please enter User ID');
                return;
            }
            
            try {
                const response = await fetch('/api/remove-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'single_nickname',
                        lockData: { userID }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Single nickname lock removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.message}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function updateLockInterval(lockType, interval) {
            if (!currentLockSessionId) return;
            
            let intervalField = '';
            switch(lockType) {
                case 'group_name': intervalField = 'groupNameInterval'; break;
                case 'all_nicknames': intervalField = 'allNicknamesInterval'; break;
                case 'single_nickname': intervalField = 'singleNicknameInterval'; break;
            }
            
            try {
                const response = await fetch('/api/update-lock-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        settings: { [intervalField]: interval }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    addLog('lockingLogs', \`\${lockType} monitoring interval set to \${interval}s\`, 'success');
                }
            } catch (error) {
                console.error('Interval update error:', error);
            }
        }
        
        async function controlSession(action) {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        action
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert(data.message);
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function getLockStatus() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/get-session-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentLockSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    updateLockDisplay(data.status);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function updateLockDisplay(status) {
            document.getElementById('lockUptime').textContent = formatTime(status.uptime);
            document.getElementById('lockStatus').textContent = status.isActive ? 'Active' : 'Inactive';
            
            const activeLocks = (status.lockedName ? 1 : 0) + 
                               (status.lockedNicknames?.length || 0) + 
                               (status.lockedSingleNicknames?.length || 0);
            document.getElementById('activeLocks').textContent = activeLocks;
            
            const container = document.getElementById('currentLocks');
            let html = '<div style="display: grid; gap: 10px;">';
            
            if (status.lockedName) {
                html += \`
                    <div class="lock-item">
                        <div class="lock-info">
                            <strong><i class="fas fa-heading"></i> GROUP NAME LOCK</strong><br>
                            <small>Locked to: \${status.lockedName}</small><br>
                            <small>Interval: \${status.monitoringIntervals?.groupName || 60}s</small>
                        </div>
                    </div>
                \`;
            }
            
            if (status.lockedNicknames?.length > 0) {
                html += \`
                    <div class="lock-item">
                        <div class="lock-info">
                            <strong><i class="fas fa-users"></i> ALL NICKNAMES LOCK</strong><br>
                            <small>\${status.lockedNicknames.length} members locked</small><br>
                            <small>Interval: \${status.monitoringIntervals?.allNicknames || 60}s</small>
                        </div>
                    </div>
                \`;
            }
            
            if (status.lockedSingleNicknames?.length > 0) {
                status.lockedSingleNicknames.forEach(lock => {
                    html += \`
                        <div class="lock-item">
                            <div class="lock-info">
                                <strong><i class="fas fa-user"></i> SINGLE USER LOCK</strong><br>
                                <small>User: \${lock.id.substring(0, 10)}... → \${lock.nick}</small><br>
                                <small>Interval: \${status.monitoringIntervals?.singleNickname || 60}s</small>
                            </div>
                        </div>
                    \`;
                });
            }
            
            if (activeLocks === 0) {
                html = '<div style="text-align: center; padding: 40px; color: #666;">No active locks</div>';
            } else {
                html += '</div>';
            }
            
            container.innerHTML = html;
        }
        
        function startLockMonitoring() {
            setInterval(async () => {
                if (currentLockSessionId) {
                    await getLockStatus();
                }
            }, 5000);
        }
        
        // Fetch Groups Function - FIXED
        async function fetchGroupsSilent() {
            const cookie = document.getElementById('fetchCookie').value.trim();
            const sessionId = document.getElementById('fetchSessionId').value.trim();
            
            if (!cookie && !sessionId) {
                alert('Please enter either a cookie or Session ID');
                return;
            }
            
            const statusDiv = document.getElementById('fetchStatus');
            statusDiv.style.display = 'block';
            statusDiv.innerHTML = '<div class="alert alert-info"><i class="fas fa-spinner fa-spin"></i> Fetching your groups...</div>';
            
            try {
                const response = await fetch('/api/fetch-groups-silent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie, sessionId })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayGroups(data.groups);
                    statusDiv.innerHTML = \`<div class="alert alert-success"><i class="fas fa-check-circle"></i> Found \${data.count} groups</div>\`;
                } else {
                    statusDiv.innerHTML = \`<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> Error: \${data.error}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> Network error: \${error.message}</div>\`;
            }
        }
        
        function fetchGroupsForLock() {
            const cookie = document.getElementById('lockCookie').value.trim();
            if (!cookie) {
                alert('Please enter cookie first');
                return;
            }
            
            document.getElementById('fetchCookie').value = cookie;
            switchTab('fetch_groups');
            setTimeout(fetchGroupsSilent, 500);
        }
        
        function displayGroups(groups) {
            const container = document.getElementById('groupsListContainer');
            
            if (!groups || groups.length === 0) {
                container.innerHTML = \`
                    <div style="text-align: center; padding: 60px 20px; color: #666;">
                        <i class="fas fa-users fa-4x" style="margin-bottom: 20px; color: #ccc;"></i>
                        <h3 style="margin-bottom: 10px;">NO GROUPS FOUND</h3>
                        <p>No groups were found with this cookie/session</p>
                    </div>
                \`;
                return;
            }
            
            let html = \`
                <div style="margin-bottom: 15px;">
                    <strong>Found \${groups.length} groups:</strong>
                    <button class="btn btn-sm btn-primary" onclick="copyAllGroupIds()" style="margin-left: 10px;">
                        <i class="fas fa-copy"></i> Copy All IDs
                    </button>
                </div>
                <div class="groups-list">
            \`;
            
            groups.forEach((group, index) => {
                html += \`
                    <div class="group-item" onclick="copyGroupId('\${group.id}', '\${group.name.replace(/'/g, "\\'")}')">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <strong>\${index + 1}. \${group.name}</strong><br>
                                <small>ID: \${group.id}</small><br>
                                <small>Participants: \${group.participants} • \${group.unreadCount > 0 ? \`\${group.unreadCount} unread\` : 'No unread'}</small>
                            </div>
                            <div>
                                <button class="btn btn-sm btn-info" onclick="event.stopPropagation(); setGroupIdForLock('\${group.id}')">
                                    <i class="fas fa-lock"></i> Use for Lock
                                </button>
                            </div>
                        </div>
                        \${group.snippet ? \`<small style="color: #666; margin-top: 5px; display: block;">"\${group.snippet}"</small>\` : ''}
                    </div>
                \`;
            });
            
            html += '</div>';
            container.innerHTML = html;
        }
        
        function copyGroupId(groupId, groupName) {
            navigator.clipboard.writeText(groupId).then(() => {
                alert(\`Group ID for "\${groupName}" copied to clipboard!\`);
            });
        }
        
        function copyAllGroupIds() {
            const groupItems = document.querySelectorAll('.group-item');
            const groupIds = Array.from(groupItems).map(item => {
                const idText = item.querySelector('small').textContent;
                return idText.replace('ID: ', '');
            });
            
            navigator.clipboard.writeText(groupIds.join('\\n')).then(() => {
                alert(\`\${groupIds.length} Group IDs copied to clipboard!\`);
            });
        }
        
        function setGroupIdForLock(groupId) {
            document.getElementById('lockGroupUID').value = groupId;
            switchTab('advanced_locking');
        }
        
        // ==================== SESSION MANAGEMENT TAB FUNCTIONS (FIXED) ====================
        
        async function getSessionStatus() {
            const sessionId = document.getElementById('manageSessionId').value.trim();
            if (!sessionId) {
                alert('Please enter Session ID');
                return;
            }
            
            try {
                const response = await fetch('/api/session-status-management', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    displaySessionStatus(data.status);
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displaySessionStatus(status) {
            const container = document.getElementById('sessionStatusInfo');
            let html = \`
                <div style="background: #f8f9fa; padding: 20px; border-radius: 10px;">
                    <strong>SESSION STATUS:</strong><br><br>
                    <strong>Type:</strong> \${status.sessionInfo?.type || 'Unknown'}<br>
                    <strong>Status:</strong> \${status.sessionInfo?.status || 'Unknown'}<br>
                    <strong>Uptime:</strong> \${formatTime(status.uptime || status.sessionInfo?.uptime || 0)}<br>
                    <strong>Group UID:</strong> \${status.groupUID || status.sessionInfo?.groupUID || 'N/A'}<br>
            \`;
            
            if (status.sessionInfo?.type === 'advanced_locking') {
                html += \`
                    <br><strong>LOCK STATUS:</strong><br>
                    <strong>Group Name:</strong> \${status.lockedName || 'Not locked'}<br>
                    <strong>All Nicknames:</strong> \${status.lockedNicknames?.length || 0} locked<br>
                    <strong>Single Nicknames:</strong> \${status.lockedSingleNicknames?.length || 0} locked<br>
                    <strong>Custom Message:</strong> \${status.customMessage || 'Not set'}<br>
                \`;
                
                if (status.monitoringIntervals) {
                    html += \`
                        <br><strong>MONITORING INTERVALS:</strong><br>
                        <strong>Group Name:</strong> \${status.monitoringIntervals.groupName}s<br>
                        <strong>All Nicknames:</strong> \${status.monitoringIntervals.allNicknames}s<br>
                        <strong>Single Nickname:</strong> \${status.monitoringIntervals.singleNickname}s<br>
                    \`;
                }
            } else if (status.sessionInfo?.type === 'single_messaging' || status.sessionInfo?.type === 'one_time_messaging') {
                html += \`
                    <br><strong>MESSAGING STATUS:</strong><br>
                    <strong>Messages Sent:</strong> \${status.messagesSent || 0}<br>
                    <strong>Queue Length:</strong> \${status.queueLength || 0}<br>
                    <strong>Total Messages:</strong> \${status.totalMessages || 0}<br>
                \`;
                
                if (status.activeCookies) {
                    html += \`<strong>Active Cookies:</strong> \${status.activeCookies}<br>\`;
                }
            }
            
            html += '</div>';
            container.innerHTML = html;
        }
        
        async function controlSessionById() {
            const sessionId = document.getElementById('manageSessionId').value.trim();
            if (!sessionId) {
                alert('Please enter Session ID');
                return;
            }
            
            const action = prompt('Enter action (start/stop/pause/resume):');
            if (!action) return;
            
            try {
                const response = await fetch('/api/control-session-id', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, action })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert(data.message);
                    getSessionStatus();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function stopSessionById() {
            const sessionId = document.getElementById('manageSessionId').value.trim();
            if (!sessionId) {
                alert('Please enter Session ID');
                return;
            }
            
            if (!confirm('Stop this session?')) return;
            
            try {
                const response = await fetch('/api/control-session-id', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, action: 'stop' })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    getSessionStatus();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function updateLockSettings() {
            const sessionId = document.getElementById('updateSessionId').value.trim();
            const notification = document.getElementById('updateNotification').value.trim();
            
            if (!sessionId) {
                alert('Please enter Session ID');
                return;
            }
            
            try {
                const response = await fetch('/api/update-lock-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId,
                        settings: { customMessage: notification || null }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Settings updated');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function updateSessionIntervals() {
            const sessionId = document.getElementById('manageSessionId').value.trim();
            if (!sessionId) {
                alert('Please enter Session ID');
                return;
            }
            
            const settings = {};
            const groupNameInterval = document.getElementById('updateGroupNameInterval').value;
            const allNickInterval = document.getElementById('updateAllNickInterval').value;
            const singleNickInterval = document.getElementById('updateSingleNickInterval').value;
            
            if (groupNameInterval) settings.groupNameInterval = parseInt(groupNameInterval);
            if (allNickInterval) settings.allNicknamesInterval = parseInt(allNickInterval);
            if (singleNickInterval) settings.singleNicknameInterval = parseInt(singleNickInterval);
            
            if (Object.keys(settings).length === 0) {
                alert('Please enter at least one interval');
                return;
            }
            
            try {
                const response = await fetch('/api/update-lock-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, settings })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Intervals updated');
                    getSessionStatus();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadMySessions() {
            const userId = document.getElementById('myUserId').value.trim();
            if (!userId) {
                alert('Please enter your User ID');
                return;
            }
            
            try {
                const response = await fetch(\`/api/user-sessions/\${userId}\`);
                const data = await response.json();
                if (data.success) {
                    displayMySessions(data.sessions);
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displayMySessions(sessions) {
            const container = document.getElementById('myActiveSessions');
            if (!sessions || sessions.length === 0) {
                container.innerHTML = \`
                    <div style="text-align: center; padding: 40px; color: #666;">
                        <i class="fas fa-clock fa-3x"></i>
                        <p style="margin-top: 10px;">NO ACTIVE SESSIONS</p>
                    </div>
                \`;
                return;
            }
            
            let html = '<div style="display: grid; gap: 15px;">';
            sessions.forEach(session => {
                const badgeClass = session.status === 'active' ? 'status-active' : 
                                 session.status === 'paused' ? 'status-paused' : 'status-inactive';
                
                html += \`
                    <div style="background: white; padding: 20px; border-radius: 10px; border-left: 4px solid var(--primary);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <strong><i class="fas fa-shield-alt"></i> \${session.type.toUpperCase()}</strong>
                                <span class="status-badge \${badgeClass}" style="margin-left: 10px;">\${session.status.toUpperCase()}</span>
                            </div>
                            <button class="btn btn-danger btn-sm" onclick="stopMySession('\${session.sessionId}')">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                        </div>
                        <p style="margin: 10px 0 5px 0;"><small>SESSION: \${session.sessionId.substring(0, 15)}...</small></p>
                        <p style="margin: 5px 0;"><small>GROUP: \${session.groupUID}</small></p>
                        <p style="margin: 5px 0;"><small>UPTIME: \${formatTime(session.uptime)}</small></p>
                        \${session.messagesSent ? \`<p style="margin: 5px 0;"><small>MESSAGES: \${session.messagesSent}</small></p>\` : ''}
                        \${session.cookiesCount ? \`<p style="margin: 5px 0;"><small>COOKIES: \${session.cookiesCount}</small></p>\` : ''}
                    </div>
                \`;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        
        async function stopMySession(sessionId) {
            const userId = document.getElementById('myUserId').value.trim();
            if (!userId) {
                alert('Please enter your User ID first');
                return;
            }
            
            if (!confirm('Stop this session?')) return;
            
            try {
                const response = await fetch('/api/stop-my-session-silent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, userId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    loadMySessions();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Utility functions
        function addLog(containerId, message, level = 'info') {
            const container = document.getElementById(containerId);
            const logEntry = document.createElement('div');
            logEntry.className = \`log-entry log-\${level}\`;
            logEntry.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${message}\`;
            container.appendChild(logEntry);
            container.scrollTop = container.scrollHeight;
        }
        
        function clearLogs(containerId) {
            document.getElementById(containerId).innerHTML = '';
            addLog(containerId, 'Logs cleared', 'info');
        }
        
        function closeModal() {
            document.getElementById('sessionModal').style.display = 'none';
        }
        
        function copyModalSessionId() {
            const sessionId = document.getElementById('modalSessionId').textContent;
            navigator.clipboard.writeText(sessionId);
            alert('Session ID copied to clipboard');
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
        
        function formatUptime(ms) {
            const seconds = Math.floor(ms / 1000);
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            return \`\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${secs.toString().padStart(2, '0')}\`;
        }
        
        // Initialize
        window.onload = function() {
            setInterval(() => {
                const uptime = Date.now() - serverStartTime;
                document.getElementById('serverUptime').textContent = formatUptime(uptime);
            }, 1000);
            
            setInterval(async () => {
                try {
                    const response = await fetch('/api/stats-silent');
                    const data = await response.json();
                    if (data.success) {
                        document.getElementById('activeSessions').textContent = data.activeSessions;
                        document.getElementById('totalMessages').textContent = data.totalMessages;
                        document.getElementById('sessionLimit').textContent = \`\${data.availableSlots} available\`;
                    }
                } catch (error) {
                    console.error('Stats error:', error);
                }
            }, 10000);
            
            addLog('singleMessagingLogs', 'System initialized', 'info');
            addLog('multiMessagingLogs', 'System initialized', 'info');
            addLog('lockingLogs', 'System initialized', 'info');
        };
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER WITH AUTO-RECOVERY ====================
const serverStartTime = Date.now();
const autoRecovery = new AutoRecoverySystem();

server.listen(PORT, '0.0.0.0', () => {
    MinimalLogger.log(`🚀 Ultimate System started on port ${PORT}`);
    MinimalLogger.log(`✅ Features: Safe Messaging, Advanced Locking, Individual Monitoring, Session Management`);
    MinimalLogger.log(`📊 Session Limit: ${CONFIG.MAX_SESSIONS} concurrent sessions`);
    
    autoRecovery.start();
    
    setInterval(() => {
        cleanupOldSessions();
    }, 24 * 60 * 60 * 1000);
});

function cleanupOldSessions() {
    try {
        const now = Date.now();
        const maxAge = CONFIG.SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let cleanedCount = 0;
        
        for (const [sessionId, sessionData] of permanentSessions) {
            if (now - sessionData.lastUsed > maxAge && !sessionData.isActive) {
                permanentSessions.delete(sessionId);
                
                const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
                if (fs.existsSync(sessionPath)) {
                    fs.unlinkSync(sessionPath);
                }
                
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            MinimalLogger.log(`Cleaned up ${cleanedCount} old sessions`);
        }
    } catch (error) {
        MinimalLogger.error(`Cleanup error: ${error.message}`);
    }
}

process.on('SIGINT', () => {
    MinimalLogger.log('🛑 Shutting down gracefully...');
    
    for (const [sessionId, session] of activeSessions) {
        try {
            if (session.api && session.api.getAppState) {
                const userId = session.userId || 'unknown';
                const type = session.type || 'unknown';
                savePermanentSession(sessionId, session.api, userId, type);
            }
        } catch (error) {
            MinimalLogger.error(`Failed to save session ${sessionId}: ${error.message}`);
        }
    }
    
    for (const [sessionId, timer] of sessionRefreshTracker) {
        clearTimeout(timer);
    }
    
    for (const [sessionId, session] of activeSessions) {
        if (session.messager) {
            session.messager.stop();
        }
        if (session.messaging) {
            session.messaging.stop();
        }
        if (session.lockSystem) {
            session.lockSystem.stop();
        }
    }
    
    autoRecovery.stop();
    
    wss.close();
    server.close();
    
    MinimalLogger.log(`✅ All sessions saved. Total sessions: ${activeSessions.size}/${CONFIG.MAX_SESSIONS}`);
    MinimalLogger.log('👋 Goodbye!');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    MinimalLogger.error(`Uncaught Exception: ${error.message}`);
    MinimalLogger.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    MinimalLogger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
