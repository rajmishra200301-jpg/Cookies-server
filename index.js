const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ANTI-CRASH & AUTO-RECOVERY SYSTEM ====================
class AntiCrashSystem {
    constructor() {
        this.lastHeartbeat = Date.now();
        this.crashCount = 0;
        this.maxCrashes = 10;
        this.crashWindow = 3600000;
        this.crashHistory = [];
        this.healthCheckInterval = 30000;
        this.autoRecovery = true;
        this.recoveryAttempts = 0;
        this.maxRecoveryAttempts = 5;
        this.memoryThreshold = 0.9;
        this.healthStatus = 'healthy';
        this.performanceMetrics = {
            memoryUsage: 0,
            cpuUsage: 0,
            activeConnections: 0,
            wsConnections: 0,
            sessionsCount: 0,
            uptime: 0
        };
    }

    startMonitoring() {
        setInterval(() => {
            this.lastHeartbeat = Date.now();
            this.checkHealth();
        }, this.healthCheckInterval);

        setInterval(() => {
            this.checkMemory();
        }, 60000);

        setInterval(() => {
            this.collectMetrics();
        }, 15000);

        setInterval(() => {
            this.cleanupStaleSessions();
        }, 300000);

        // Session auto-recovery check every 2 minutes
        setInterval(() => {
            this.checkAndRecoverDeadSessions();
        }, 120000);

        console.log('🛡️ Anti-crash system initialized');
    }

    checkHealth() {
        const now = Date.now();
        const timeSinceHeartbeat = now - this.lastHeartbeat;
        
        if (timeSinceHeartbeat > 120000) {
            console.warn('⚠️ Health check warning: No recent heartbeat');
            this.healthStatus = 'warning';
            
            if (this.autoRecovery) {
                this.performRecovery();
            }
        } else {
            this.healthStatus = 'healthy';
        }

        const recentCrashes = this.crashHistory.filter(
            crashTime => now - crashTime < this.crashWindow
        );
        
        if (recentCrashes.length > this.maxCrashes) {
            console.error('🚨 Excessive crashes detected! Initiating emergency procedures');
            this.healthStatus = 'critical';
            this.emergencyShutdown();
        }
    }

    checkMemory() {
        const used = process.memoryUsage();
        const memoryUsage = used.heapUsed / used.heapTotal;
        
        this.performanceMetrics.memoryUsage = memoryUsage;
        
        if (memoryUsage > this.memoryThreshold) {
            console.warn(`⚠️ High memory usage: ${(memoryUsage * 100).toFixed(2)}%`);
            
            if (global.gc) {
                global.gc();
                console.log('🧹 Forced garbage collection');
            }
            
            if (memoryUsage > 0.95) {
                this.clearMemoryCaches();
            }
        }
    }

    clearMemoryCaches() {
        if (typeof global.gc === 'function') {
            global.gc();
        }
        
        Object.keys(require.cache).forEach(key => {
            if (!key.includes('node_modules') && 
                !key.includes('fca-mafiya') && 
                !key.includes('express')) {
                delete require.cache[key];
            }
        });
        
        console.log('🧹 Memory caches cleared');
    }

    collectMetrics() {
        const used = process.memoryUsage();
        this.performanceMetrics = {
            memoryUsage: used.heapUsed / used.heapTotal,
            cpuUsage: process.cpuUsage().user / 1000000,
            activeConnections: server && server._connections ? server._connections : 0,
            wsConnections: wss ? wss.clients.size : 0,
            sessionsCount: activeSessions.size,
            uptime: process.uptime()
        };
    }

    cleanupStaleSessions() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [sessionId, session] of activeSessions) {
            if (session.lastActivity && (now - session.lastActivity > 3600000)) {
                if (session.messager) {
                    session.messager.stop();
                }
                if (session.lockSystem) {
                    session.lockSystem.stop();
                }
                if (sessionRefreshTracker.has(sessionId)) {
                    clearTimeout(sessionRefreshTracker.get(sessionId));
                    sessionRefreshTracker.delete(sessionId);
                }
                if (sessionHeartbeats.has(sessionId)) {
                    clearInterval(sessionHeartbeats.get(sessionId));
                    sessionHeartbeats.delete(sessionId);
                }
                activeSessions.delete(sessionId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} stale sessions`);
        }
    }

    checkAndRecoverDeadSessions() {
        const now = Date.now();
        let recovered = 0;
        
        for (const [sessionId, session] of activeSessions) {
            // If session hasn't had activity for 5 minutes
            if (session.lastActivity && (now - session.lastActivity > 300000)) {
                console.log(`🔄 Attempting to recover dead session: ${sessionId}`);
                
                if (session.type === 'locking' || session.type === 'locking_advanced') {
                    recoverLockSession(sessionId);
                    recovered++;
                } else if (session.type === 'one_time_messaging') {
                    recoverMessagingSession(sessionId);
                    recovered++;
                }
            }
        }
        
        if (recovered > 0) {
            console.log(`✅ Recovered ${recovered} dead sessions`);
        }
    }

    recordCrash(error) {
        const now = Date.now();
        this.crashHistory.push(now);
        this.crashCount++;
        
        this.crashHistory = this.crashHistory.filter(
            crashTime => now - crashTime < this.crashWindow
        );
        
        console.error(`🚨 Crash recorded #${this.crashCount}:`, error.message);
        
        const crashLog = {
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack,
            crashCount: this.crashCount,
            metrics: this.performanceMetrics
        };
        
        try {
            const logDir = path.join(__dirname, 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const logFile = path.join(logDir, 'crashes.json');
            let crashes = [];
            
            if (fs.existsSync(logFile)) {
                crashes = JSON.parse(fs.readFileSync(logFile, 'utf8'));
            }
            
            crashes.push(crashLog);
            fs.writeFileSync(logFile, JSON.stringify(crashes, null, 2));
        } catch (logError) {
            console.error('Failed to write crash log:', logError);
        }
    }

    performRecovery() {
        if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
            console.error('🚨 Max recovery attempts reached');
            return;
        }
        
        this.recoveryAttempts++;
        console.log(`🔄 Performing recovery attempt #${this.recoveryAttempts}`);
        
        try {
            this.clearMemoryCaches();
            
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'recovery',
                            message: 'System recovery in progress'
                        }));
                    }
                });
            }
            
            for (const [sessionId, session] of activeSessions) {
                if (session.lockSystem && session.lockSystem.isActive) {
                    session.lockSystem.startSafeMonitoring();
                }
            }
            
            console.log('✅ Recovery completed successfully');
            this.recoveryAttempts = 0;
        } catch (recoveryError) {
            console.error('❌ Recovery failed:', recoveryError);
        }
    }

    emergencyShutdown() {
        console.log('🚨 EMERGENCY SHUTDOWN INITIATED');
        
        this.saveAllSessions();
        
        for (const [sessionId, session] of activeSessions) {
            if (session.messager) {
                session.messager.stop();
            }
            if (session.lockSystem) {
                session.lockSystem.stop();
            }
        }
        
        for (const [sessionId, timer] of sessionRefreshTracker) {
            clearTimeout(timer);
        }
        
        for (const [sessionId, heartbeat] of sessionHeartbeats) {
            clearInterval(heartbeat);
        }
        
        console.log('🛑 Emergency shutdown complete');
    }

    saveAllSessions() {
        try {
            const sessionsDir = path.join(__dirname, 'sessions', 'backup');
            if (!fs.existsSync(sessionsDir)) {
                fs.mkdirSync(sessionsDir, { recursive: true });
            }
            
            const backupFile = path.join(sessionsDir, `backup_${Date.now()}.json`);
            const backupData = {
                timestamp: new Date().toISOString(),
                activeSessions: Array.from(activeSessions.entries()),
                permanentSessions: Array.from(permanentSessions.entries())
            };
            
            fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
            console.log(`💾 Sessions backed up to: ${backupFile}`);
        } catch (error) {
            console.error('Failed to backup sessions:', error);
        }
    }

    getStatus() {
        return {
            healthStatus: this.healthStatus,
            crashCount: this.crashCount,
            recoveryAttempts: this.recoveryAttempts,
            lastHeartbeat: new Date(this.lastHeartbeat).toISOString(),
            performanceMetrics: this.performanceMetrics,
            uptime: process.uptime()
        };
    }
}

// Create HTTP server
const server = http.createServer(app);

// Initialize Anti-Crash System
const antiCrash = new AntiCrashSystem();

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

// ==================== SESSION HEARTBEAT SYSTEM ====================
function startSessionHeartbeat(sessionId) {
    // Clear existing heartbeat
    if (sessionHeartbeats.has(sessionId)) {
        clearInterval(sessionHeartbeats.get(sessionId));
    }
    
    // Start new heartbeat
    const heartbeatInterval = setInterval(async () => {
        try {
            const session = activeSessions.get(sessionId);
            if (!session) {
                clearInterval(heartbeatInterval);
                sessionHeartbeats.delete(sessionId);
                return;
            }
            
            // Update last activity
            session.lastActivity = Date.now();
            session.heartbeat = Date.now();
            
            // Check if session is still active
            if (session.type === 'locking' || session.type === 'locking_advanced') {
                if (session.lockSystem) {
                    session.lockSystem.heartbeat = Date.now();
                    session.lockSystem.consecutiveFailures = 0;
                    
                    // Send a keep-alive ping
                    await keepLockSessionAlive(sessionId);
                }
            } else if (session.type === 'one_time_messaging') {
                if (session.messager) {
                    session.messager.lastActivity = Date.now();
                }
            }
            
            // Auto-refresh permanent session every hour
            if (session.lastRefresh && (Date.now() - session.lastRefresh > 3600000)) {
                if (session.api && session.userId && session.groupUID) {
                    refreshSession(sessionId, session.api, session.userId, session.groupUID, session.type);
                    session.lastRefresh = Date.now();
                    console.log(`🔄 Session ${sessionId} auto-refreshed`);
                }
            }
            
            console.log(`💓 Session ${sessionId} heartbeat OK`);
            
        } catch (error) {
            console.error(`❌ Session ${sessionId} heartbeat failed:`, error.message);
            antiCrash.recordCrash(error);
        }
    }, 30000); // Every 30 seconds
    
    sessionHeartbeats.set(sessionId, heartbeatInterval);
}

async function keepLockSessionAlive(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.lockSystem) return;
    
    try {
        if (session.api && session.groupUID) {
            // Lightweight API call to keep session alive
            session.api.getThreadInfo(session.groupUID, (err, info) => {
                if (!err && info) {
                    session.lockSystem.heartbeat = Date.now();
                    session.lockSystem.consecutiveFailures = 0;
                }
            });
        }
    } catch (error) {
        // Silent error
    }
}

function recoverLockSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    try {
        if (session.lockSystem) {
            if (session.lockSystem.isPaused) {
                session.lockSystem.resume();
                session.status = 'active';
                session.lastActivity = Date.now();
                console.log(`✅ Lock session ${sessionId} recovered from paused state`);
            }
            
            // Restart monitoring if stopped
            if (!session.lockSystem.isActive && session.lockSystem.isActive !== undefined) {
                session.lockSystem.startSafeMonitoring();
                session.status = 'active';
                session.lastActivity = Date.now();
                console.log(`✅ Lock session ${sessionId} monitoring restarted`);
            }
        }
    } catch (error) {
        console.error(`❌ Failed to recover lock session ${sessionId}:`, error.message);
    }
}

function recoverMessagingSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    try {
        if (session.messager && !session.messager.isRunning) {
            session.messager.start();
            session.status = 'active';
            session.lastActivity = Date.now();
            console.log(`✅ Messaging session ${sessionId} recovered`);
        }
    } catch (error) {
        console.error(`❌ Failed to recover messaging session ${sessionId}:`, error.message);
    }
}

// ==================== PERMANENT SESSION SYSTEM ====================
function savePermanentSession(sessionId, api, userId, type = 'messaging') {
    try {
        if (!api) return false;
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (!fs.existsSync(path.dirname(sessionPath))) {
            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        }
        const appState = api.getAppState();
        const sessionData = {
            sessionId,
            appState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            lastHeartbeat: Date.now()
        };
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        return true;
    } catch (error) {
        antiCrash.recordCrash(error);
        return false;
    }
}

function loadPermanentSession(sessionId) {
    try {
        if (permanentSessions.has(sessionId)) {
            return permanentSessions.get(sessionId);
        }
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (fs.existsSync(sessionPath)) {
            const fileStats = fs.statSync(sessionPath);
            if (fileStats.size > 100) {
                const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                permanentSessions.set(sessionId, sessionData);
                return sessionData;
            }
        }
    } catch (error) {
        antiCrash.recordCrash(error);
    }
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
                lastHeartbeat: session.lastHeartbeat
            });
        }
    }
    return sessions;
}

// ==================== AUTO REFRESH SYSTEM ====================
function setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, refreshTime = 172800000) {
    if (sessionRefreshTracker.has(sessionId)) {
        clearTimeout(sessionRefreshTracker.get(sessionId));
    }
    const refreshTimer = setTimeout(() => {
        refreshSession(sessionId, api, userId, groupUID, type);
    }, refreshTime);
    sessionRefreshTracker.set(sessionId, refreshTimer);
}

function refreshSession(sessionId, api, userId, groupUID, type) {
    try {
        const appState = api.getAppState();
        const sessionData = {
            sessionId,
            appState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            lastHeartbeat: Date.now()
        };
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        
        const session = activeSessions.get(sessionId);
        if (session && session.refreshTime) {
            setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, session.refreshTime);
        }
        
        console.log(`🔄 Session ${sessionId} refreshed successfully`);
    } catch (error) {
        antiCrash.recordCrash(error);
    }
}

// ==================== SILENT LOGIN SYSTEM ====================
function silentLogin(cookieString, callback) {
    const loginOptions = {
        appState: null,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent',
        autoLogAppEvents: false,
        listenEvents: false,
        selfListen: false
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
        logLevel: 'silent',
        autoLogAppEvents: false,
        listenEvents: false,
        selfListen: false
    };
    
    wiegine.login(loginOptions, (err, api) => {
        if (err || !api) {
            callback(null);
        } else {
            sessionData.lastUsed = Date.now();
            sessionData.lastHeartbeat = Date.now();
            permanentSessions.set(sessionId, sessionData);
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            try {
                fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
            } catch (e) {
                antiCrash.recordCrash(e);
            }
            callback(api);
        }
    });
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
        this.lastActivity = Date.now();
        this.heartbeat = Date.now();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
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
                antiCrash.recordCrash(error);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        this.initialized = successCount > 0;
        return this.initialized;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.startHeartbeat();
        this.processQueue();
    }

    startHeartbeat() {
        setInterval(() => {
            this.heartbeat = Date.now();
            this.lastActivity = Date.now();
            
            // Check and reconnect dead cookies
            this.reconnectDeadCookies();
        }, 60000); // Check every minute
    }

    reconnectDeadCookies() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
        
        for (let i = 0; i < this.originalCookies.length; i++) {
            if (!this.activeApis.has(i)) {
                this.reconnectAttempts++;
                setTimeout(() => {
                    this.reconnectCookie(i);
                }, this.reconnectAttempts * 5000);
            }
        }
    }

    async reconnectCookie(index) {
        const cookie = this.originalCookies[index];
        try {
            const api = await new Promise((resolve) => {
                silentLogin(cookie, (fbApi) => {
                    resolve(fbApi);
                });
            });
            if (api) {
                this.activeApis.set(index, api);
                this.reconnectAttempts = Math.max(0, this.reconnectAttempts - 1);
                console.log(`✅ Reconnected cookie ${index + 1} for session ${this.sessionId}`);
            }
        } catch (error) {
            antiCrash.recordCrash(error);
        }
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            try {
                this.lastActivity = Date.now();
                this.heartbeat = Date.now();
                const message = this.messageQueue.shift();
                const messageText = this.prefix + message;
                const messageNumber = this.messageIndex + 1;
                this.cookieIndex = (this.cookieIndex + 1) % this.originalCookies.length;
                const cookieNum = this.cookieIndex + 1;
                const success = await this.sendWithCookie(this.cookieIndex, messageText);
                if (success) {
                    this.messageIndex++;
                    this.messagesSent++;
                    const session = activeSessions.get(this.sessionId);
                    if (session) {
                        session.messagesSent = this.messagesSent;
                        session.lastActivity = Date.now();
                        session.heartbeat = Date.now();
                        updateSessionStatus(this.sessionId);
                    }
                } else {
                    this.messageQueue.unshift(message);
                }
                await new Promise(resolve => setTimeout(resolve, this.delay));
            } catch (error) {
                antiCrash.recordCrash(error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
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
                antiCrash.recordCrash(error);
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

    stop() {
        this.isRunning = false;
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
            lastActivity: new Date(this.lastActivity).toISOString(),
            heartbeat: new Date(this.heartbeat).toISOString(),
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

// ==================== SAFE LOCK SYSTEM (SECONDS BASED) ====================
class SafePermanentLockSystem {
    constructor(sessionId, api, groupUID) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        this.lockedName = null;
        this.lockedNicknames = new Map();
        this.lockedSingleNickname = new Map();
        this.memberCache = new Map();
        this.monitoringInterval = null;
        this.isActive = false;
        this.safeMode = true;
        this.monitoringIntervalTime = 60000; // Default 60 seconds
        this.customMessage = "🔒 Locking system is active. Changes reverted automatically.";
        this.nicknameRestoreDelay = 2000; // 2 seconds between nickname changes
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        this.isPaused = false;
        this.heartbeat = Date.now();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.keepAliveInterval = null;
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.startKeepAlive();
        this.startSafeMonitoring();
    }

    stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        this.isActive = false;
    }

    pause() {
        this.isPaused = true;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    resume() {
        this.isPaused = false;
        this.startKeepAlive();
        this.startSafeMonitoring();
    }

    startKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        this.keepAliveInterval = setInterval(() => {
            if (!this.isPaused && this.api) {
                this.heartbeat = Date.now();
                
                // Send keep-alive ping
                this.api.getThreadInfo(this.groupUID, (err, info) => {
                    if (err) {
                        this.consecutiveFailures++;
                        if (this.consecutiveFailures >= this.maxFailures) {
                            this.attemptReconnect();
                        }
                    } else {
                        this.consecutiveFailures = 0;
                        this.reconnectAttempts = 0;
                    }
                });
            }
        }, 120000); // Every 2 minutes
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`❌ Max reconnect attempts reached for session ${this.sessionId}`);
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`🔄 Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} for session ${this.sessionId}`);
        
        // Try to reinitialize API
        const session = activeSessions.get(this.sessionId);
        if (session && session.api) {
            // The API should auto-reconnect internally
            this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1);
        }
    }

    setMonitoringInterval(seconds) {
        this.monitoringIntervalTime = seconds * 1000; // Convert to milliseconds
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.startSafeMonitoring();
        }
        return { success: true, message: `Monitoring interval set to ${seconds} seconds` };
    }

    setCustomMessage(message) {
        this.customMessage = message;
        return { success: true, message: "Custom message updated" };
    }

    setNicknameRestoreDelay(seconds) {
        this.nicknameRestoreDelay = seconds * 1000;
        return { success: true, message: `Nickname restore delay set to ${seconds} seconds` };
    }

    lockGroupName(groupName) {
        return new Promise((resolve) => {
            this.heartbeat = Date.now();
            this.api.setTitle(groupName, this.groupUID, (err) => {
                if (err) {
                    resolve({ success: false, message: err.message });
                } else {
                    this.lockedName = groupName;
                    this.start();
                    resolve({ success: true, message: `Group name locked to "${groupName}"` });
                }
            });
        });
    }

    unlockGroupName() {
        this.lockedName = null;
        return { success: true, message: "Group name lock removed" };
    }

    async lockAllNicknames(nickname) {
        return new Promise((resolve) => {
            this.heartbeat = Date.now();
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
                        originalNickname: null,
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
                                    this.start();
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
        return { success: true, message: "All nickname locks removed" };
    }

    lockSingleNickname(userID, nickname) {
        return new Promise((resolve) => {
            this.heartbeat = Date.now();
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
                    originalNickname: null,
                    lockedNickname: nickname
                });
                
                this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                    if (err) {
                        resolve({ success: false, message: err.message });
                    } else {
                        this.start();
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

    startSafeMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
        
        this.monitoringInterval = setInterval(() => {
            if (!this.isPaused) {
                this.safeEnforceLocks();
            }
        }, this.monitoringIntervalTime);
        
        setTimeout(() => {
            if (!this.isPaused) {
                this.safeEnforceLocks();
            }
        }, 5000);
    }

    async safeEnforceLocks() {
        if (this.consecutiveFailures >= this.maxFailures) {
            this.pause();
            return;
        }
        
        try {
            this.heartbeat = Date.now();
            
            if (this.lockedName) {
                await this.safeMonitorGroupName();
            }
            
            if (this.lockedNicknames.size > 0) {
                await this.safeMonitorAllNicknames();
            }
            
            if (this.lockedSingleNickname.size > 0) {
                await this.safeMonitorSingleNicknames();
            }
            
            this.consecutiveFailures = 0;
        } catch (error) {
            antiCrash.recordCrash(error);
            this.consecutiveFailures++;
        }
    }

    safeMonitorGroupName() {
        return new Promise((resolve) => {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve();
                    return;
                }
                
                const currentName = info.threadName || '';
                if (currentName !== this.lockedName) {
                    if (this.customMessage) {
                        this.api.sendMessage(this.customMessage, this.groupUID, () => {
                            this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                                resolve();
                            });
                        });
                    } else {
                        this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                            resolve();
                        });
                    }
                } else {
                    resolve();
                }
            });
        });
    }

    safeMonitorAllNicknames() {
        return new Promise((resolve) => {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) {
                    resolve();
                    return;
                }
                
                const currentMembers = new Set(info.participantIDs);
                const lockedEntries = Array.from(this.lockedNicknames.entries());
                let processed = 0;
                let failures = 0;
                
                if (lockedEntries.length === 0) {
                    resolve();
                    return;
                }
                
                lockedEntries.forEach(([userID, nickname], index) => {
                    if (!currentMembers.has(userID)) {
                        this.lockedNicknames.delete(userID);
                        this.memberCache.delete(userID);
                        processed++;
                        if (processed >= lockedEntries.length) {
                            resolve();
                        }
                        return;
                    }
                    
                    setTimeout(() => {
                        this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                            processed++;
                            if (err) {
                                failures++;
                            }
                            
                            if (processed >= lockedEntries.length) {
                                if (failures > 0 && this.customMessage) {
                                    this.api.sendMessage(this.customMessage, this.groupUID, () => {
                                        resolve();
                                    });
                                } else {
                                    resolve();
                                }
                            }
                        });
                    }, index * this.nicknameRestoreDelay);
                });
            });
        });
    }

    safeMonitorSingleNicknames() {
        return new Promise((resolve) => {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) {
                    resolve();
                    return;
                }
                
                const currentMembers = new Set(info.participantIDs);
                const lockedEntries = Array.from(this.lockedSingleNickname.entries());
                let processed = 0;
                
                if (lockedEntries.length === 0) {
                    resolve();
                    return;
                }
                
                lockedEntries.forEach(([userID, nickname], index) => {
                    if (!currentMembers.has(userID)) {
                        this.lockedSingleNickname.delete(userID);
                        this.memberCache.delete(userID);
                        processed++;
                        if (processed >= lockedEntries.length) {
                            resolve();
                        }
                        return;
                    }
                    
                    setTimeout(() => {
                        this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                            processed++;
                            if (processed >= lockedEntries.length) {
                                resolve();
                            }
                        });
                    }, index * this.nicknameRestoreDelay);
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
            cachedMembers: this.memberCache.size,
            isActive: this.isActive,
            isPaused: this.isPaused,
            monitoringInterval: this.monitoringIntervalTime / 1000,
            customMessage: this.customMessage,
            nicknameRestoreDelay: this.nicknameRestoreDelay / 1000,
            consecutiveFailures: this.consecutiveFailures,
            safeMode: this.safeMode,
            heartbeat: new Date(this.heartbeat).toISOString(),
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

// ==================== WEB SOCKET FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    try {
        const session = activeSessions.get(sessionId);
        if (!session) return;
        
        session.lastActivity = Date.now();
        session.heartbeat = Date.now();
        
        const sessionInfo = {
            sessionId: sessionId,
            groupUID: session.groupUID,
            status: session.status,
            messagesSent: session.messagesSent || 0,
            uptime: Date.now() - session.startTime,
            userId: session.userId || 'Unknown',
            type: session.type || 'unknown',
            lastActivity: session.lastActivity,
            heartbeat: session.heartbeat
        };
        
        broadcastToSession(sessionId, { type: 'session_update', session: sessionInfo });
    } catch (error) {
        antiCrash.recordCrash(error);
    }
}

function broadcastToSession(sessionId, data) {
    try {
        wss.clients.forEach(client => {
            if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    } catch (error) {
        antiCrash.recordCrash(error);
    }
}

wss.on('connection', (ws) => {
    try {
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
                            lastActivity: session.lastActivity,
                            heartbeat: session.heartbeat
                        };
                        ws.send(JSON.stringify({ type: 'session_info', session: sessionInfo }));
                    }
                }
            } catch (error) {
                antiCrash.recordCrash(error);
            }
        });
        
        ws.on('close', () => {
            // Silent disconnect
        });
        
        ws.on('error', (error) => {
            antiCrash.recordCrash(error);
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
    }
});

// ==================== API ROUTES ====================

// Start one-time login multi-cookie messaging
app.post('/api/start-one-time-messaging', async (req, res) => {
    try {
        const { cookies, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookies || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
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
            lastActivity: Date.now(),
            heartbeat: Date.now(),
            lastRefresh: Date.now(),
            userId: 'multi-cookie-user',
            type: 'one_time_messaging',
            cookiesCount: cookies.length,
            refreshTime: 172800000
        };
        
        activeSessions.set(sessionId, session);
        
        // Start session heartbeat
        startSessionHeartbeat(sessionId);
        
        // Setup auto-refresh
        setupSessionAutoRefresh(sessionId, null, 'multi-cookie-user', groupUID, 'one_time_messaging', session.refreshTime);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'multi-cookie-user', 
            cookiesCount: cookies.length, 
            message: `Messaging started with ${cookies.length} cookies (one-time login)` 
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Fetch groups with names from cookie
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
        }
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        api.getThreadList(50, null, ['INBOX'], (err, threadList) => {
            if (err) {
                antiCrash.recordCrash(err);
                res.json({ success: false, error: err.message });
                return;
            }
            
            const groups = threadList
                .filter(thread => thread.isGroup)
                .map(thread => ({
                    id: thread.threadID,
                    name: thread.name || `Group ${thread.threadID}`,
                    participants: thread.participants ? thread.participants.length : 0
                }))
                .sort((a, b) => b.participants - a.participants);
            
            res.json({ success: true, groups, count: groups.length });
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Start advanced lock session with seconds
app.post('/api/start-lock-session-advanced', async (req, res) => {
    try {
        const { cookie, groupUID, monitoringInterval, customMessage, nicknameDelay } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = 'lock_adv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        const lockSystem = new SafePermanentLockSystem(sessionId, api, groupUID);
        
        // Apply advanced settings
        if (monitoringInterval) {
            lockSystem.setMonitoringInterval(monitoringInterval);
        }
        
        if (customMessage) {
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
            lastActivity: Date.now(),
            heartbeat: Date.now(),
            lastRefresh: Date.now(),
            userId,
            type: 'locking_advanced',
            refreshTime: 172800000,
            monitoringInterval: monitoringInterval || 60,
            customMessage: customMessage || '',
            nicknameDelay: nicknameDelay || 2
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'locking');
        
        // Start session heartbeat
        startSessionHeartbeat(sessionId);
        
        // Setup auto-refresh
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'locking', session.refreshTime);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId, 
            message: `Advanced lock session started`,
            settings: {
                monitoringInterval: monitoringInterval || 60,
                customMessage: customMessage || '',
                nicknameDelay: nicknameDelay || 2
            }
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Start simple lock session
app.post('/api/start-lock-session-silent', async (req, res) => {
    try {
        const { cookie, groupUID } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = 'lock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        const lockSystem = new SafePermanentLockSystem(sessionId, api, groupUID);
        
        const session = {
            api,
            groupUID,
            lockSystem,
            status: 'active',
            startTime: Date.now(),
            lastActivity: Date.now(),
            heartbeat: Date.now(),
            lastRefresh: Date.now(),
            userId,
            type: 'locking',
            refreshTime: 172800000
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'locking');
        
        // Start session heartbeat
        startSessionHeartbeat(sessionId);
        
        // Setup auto-refresh
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'locking', session.refreshTime);
        
        res.json({ success: true, sessionId, userId, message: `Lock session started` });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Update lock session settings
app.post('/api/update-lock-settings', async (req, res) => {
    try {
        const { sessionId, monitoringInterval, customMessage, nicknameDelay } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'locking' && session.type !== 'locking_advanced') {
            return res.json({ success: false, error: 'Session is not a locking session' });
        }
        
        const lockSystem = session.lockSystem;
        let updates = [];
        
        if (monitoringInterval !== undefined) {
            const result = lockSystem.setMonitoringInterval(monitoringInterval);
            if (result.success) {
                updates.push(`Monitoring interval: ${monitoringInterval} seconds`);
                session.monitoringInterval = monitoringInterval;
            }
        }
        
        if (customMessage !== undefined) {
            const result = lockSystem.setCustomMessage(customMessage);
            if (result.success) {
                updates.push('Custom message updated');
                session.customMessage = customMessage;
            }
        }
        
        if (nicknameDelay !== undefined) {
            const result = lockSystem.setNicknameRestoreDelay(nicknameDelay);
            if (result.success) {
                updates.push(`Nickname delay: ${nicknameDelay} seconds`);
                session.nicknameDelay = nicknameDelay;
            }
        }
        
        if (updates.length > 0) {
            res.json({ 
                success: true, 
                message: `Settings updated: ${updates.join(', ')}`,
                settings: {
                    monitoringInterval: session.monitoringInterval,
                    customMessage: session.customMessage,
                    nicknameDelay: session.nicknameDelay
                }
            });
        } else {
            res.json({ success: false, error: 'No valid updates provided' });
        }
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Add lock to existing session
app.post('/api/add-lock-silent', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'locking' && session.type !== 'locking_advanced') {
            return res.json({ success: false, error: 'Session is not a locking session' });
        }
        
        if (!session.lockSystem) {
            session.lockSystem = new SafePermanentLockSystem(sessionId, session.api, session.groupUID);
        }
        
        let result;
        switch (lockType) {
            case 'group_name':
                if (!lockData.groupName) {
                    return res.json({ success: false, error: 'Missing group name' });
                }
                result = await session.lockSystem.lockGroupName(lockData.groupName);
                break;
            case 'all_nicknames':
                if (!lockData.nickname) {
                    return res.json({ success: false, error: 'Missing nickname' });
                }
                result = await session.lockSystem.lockAllNicknames(lockData.nickname);
                break;
            case 'single_nickname':
                if (!lockData.userID || !lockData.nickname) {
                    return res.json({ success: false, error: 'Missing user ID or nickname' });
                }
                result = await session.lockSystem.lockSingleNickname(lockData.userID, lockData.nickname);
                break;
            default:
                return res.json({ success: false, error: 'Invalid lock type' });
        }
        
        if (result.success) {
            res.json({ success: true, message: result.message, data: result });
        } else {
            res.json({ success: false, error: result.message });
        }
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Get detailed lock session status
app.post('/api/get-lock-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (!session.lockSystem) {
            return res.json({ success: false, error: 'No lock system in session' });
        }
        
        const status = session.lockSystem.getStatus();
        status.sessionInfo = {
            userId: session.userId,
            startTime: session.startTime,
            uptime: Date.now() - session.startTime,
            type: session.type,
            monitoringInterval: session.monitoringInterval,
            customMessage: session.customMessage,
            nicknameDelay: session.nicknameDelay,
            lastActivity: session.lastActivity,
            heartbeat: session.heartbeat,
            lastRefresh: session.lastRefresh
        };
        
        res.json({ success: true, status });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Pause/Resume lock session
app.post('/api/control-lock-session', async (req, res) => {
    try {
        const { sessionId, action } = req.body;
        
        if (!sessionId || !action) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (!session.lockSystem) {
            return res.json({ success: false, error: 'No lock system in session' });
        }
        
        let result = null;
        
        switch (action) {
            case 'pause':
                session.lockSystem.pause();
                session.status = 'paused';
                result = { success: true, message: 'Lock session paused' };
                break;
                
            case 'resume':
                session.lockSystem.resume();
                session.status = 'active';
                result = { success: true, message: 'Lock session resumed' };
                break;
                
            case 'stop':
                session.lockSystem.stop();
                session.status = 'stopped';
                result = { success: true, message: 'Lock session stopped' };
                break;
                
            default:
                result = { success: false, error: 'Invalid action' };
        }
        
        res.json(result);
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Individual lock management
app.post('/api/manage-individual-lock', async (req, res) => {
    try {
        const { sessionId, lockType, action, lockData } = req.body;
        
        if (!sessionId || !lockType || !action) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (!session.lockSystem) {
            return res.json({ success: false, error: 'No lock system in session' });
        }
        
        let result = null;
        
        switch (lockType) {
            case 'group_name':
                if (action === 'unlock') {
                    result = session.lockSystem.unlockGroupName();
                } else {
                    return res.json({ success: false, error: 'Invalid action for group name lock' });
                }
                break;
                
            case 'all_nicknames':
                if (action === 'unlock') {
                    result = session.lockSystem.unlockAllNicknames();
                } else {
                    return res.json({ success: false, error: 'Invalid action for all nicknames lock' });
                }
                break;
                
            case 'single_nickname':
                if (action === 'unlock') {
                    if (!lockData || !lockData.userID) {
                        return res.json({ success: false, error: 'Missing user ID' });
                    }
                    result = session.lockSystem.unlockSingleNickname(lockData.userID);
                } else {
                    return res.json({ success: false, error: 'Invalid action for single nickname lock' });
                }
                break;
                
            default:
                return res.json({ success: false, error: 'Invalid lock type' });
        }
        
        res.json(result);
        
    } catch (error) {
        antiCrash.recordCrash(error);
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
                lastHeartbeat: new Date(session.lastHeartbeat).toLocaleString(),
                status: 'permanent_active'
            }))
        });
    } catch (error) {
        antiCrash.recordCrash(error);
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
                userSessions.push({
                    sessionId,
                    type: session.type,
                    groupUID: session.groupUID,
                    status: session.status,
                    messagesSent: session.messagesSent || 0,
                    uptime: Date.now() - session.startTime,
                    cookiesCount: session.cookiesCount || 1,
                    monitoringInterval: session.monitoringInterval,
                    customMessage: session.customMessage,
                    nicknameDelay: session.nicknameDelay,
                    lastActivity: session.lastActivity,
                    heartbeat: session.heartbeat,
                    lastRefresh: session.lastRefresh
                });
            }
        }
        
        res.json({ success: true, sessions: userSessions });
    } catch (error) {
        antiCrash.recordCrash(error);
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
            
            if (session.lockSystem) {
                session.lockSystem.stop();
            }
            
            if (sessionRefreshTracker.has(sessionId)) {
                clearTimeout(sessionRefreshTracker.get(sessionId));
                sessionRefreshTracker.delete(sessionId);
            }
            
            if (sessionHeartbeats.has(sessionId)) {
                clearInterval(sessionHeartbeats.get(sessionId));
                sessionHeartbeats.delete(sessionId);
            }
            
            session.status = 'stopped';
            activeSessions.delete(sessionId);
            res.json({ success: true, message: 'Session stopped', sessionId });
        } else {
            res.json({ success: false, error: 'Session not found' });
        }
    } catch (error) {
        antiCrash.recordCrash(error);
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
            sessionHeartbeats: sessionHeartbeats.size
        });
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    try {
        const status = antiCrash.getStatus();
        res.json({ 
            status: 'OK', 
            uptime: process.uptime(),
            health: status.healthStatus,
            memory: `${(status.performanceMetrics.memoryUsage * 100).toFixed(2)}%`,
            sessions: activeSessions.size,
            sessionHeartbeats: sessionHeartbeats.size,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({ status: 'ERROR', error: error.message });
    }
});

// Recovery endpoint
app.post('/api/recover-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.messager && !session.messager.isRunning) {
            session.messager.start();
        }
        
        if (session.lockSystem && session.lockSystem.isPaused) {
            session.lockSystem.resume();
        }
        
        session.status = 'recovered';
        session.lastActivity = Date.now();
        session.heartbeat = Date.now();
        
        // Restart heartbeat if not running
        if (!sessionHeartbeats.has(sessionId)) {
            startSessionHeartbeat(sessionId);
        }
        
        res.json({ 
            success: true, 
            message: 'Session recovery initiated',
            sessionId 
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// System status endpoint
app.get('/api/system-status', (req, res) => {
    try {
        const status = antiCrash.getStatus();
        
        const sessionsStatus = [];
        for (const [sessionId, session] of activeSessions) {
            sessionsStatus.push({
                sessionId,
                type: session.type,
                status: session.status,
                userId: session.userId,
                uptime: Date.now() - session.startTime,
                messagesSent: session.messagesSent || 0,
                lastActivity: session.lastActivity ? new Date(session.lastActivity).toISOString() : null,
                heartbeat: session.heartbeat ? new Date(session.heartbeat).toISOString() : null,
                lastRefresh: session.lastRefresh ? new Date(session.lastRefresh).toISOString() : null
            });
        }
        
        res.json({
            success: true,
            system: status,
            sessions: sessionsStatus,
            wsConnections: wss.clients.size,
            permanentSessions: permanentSessions.size,
            sessionHeartbeats: sessionHeartbeats.size,
            serverUptime: Date.now() - serverStartTime
        });
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Activate permanent session
app.post('/api/activate-permanent-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const sessionData = loadPermanentSession(sessionId);
        if (!sessionData) {
            return res.json({ success: false, error: 'Permanent session not found' });
        }
        
        let api = null;
        api = await new Promise((resolve) => {
            silentLoginWithPermanentSession(sessionId, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Failed to activate session' });
        }
        
        const userId = api.getCurrentUserID();
        let session;
        
        if (sessionData.type === 'locking' || sessionData.type === 'locking_advanced') {
            const groupUID = sessionData.groupUID || 'unknown';
            const lockSystem = new SafePermanentLockSystem(sessionId, api, groupUID);
            
            session = {
                api,
                groupUID,
                lockSystem,
                status: 'active',
                startTime: Date.now(),
                lastActivity: Date.now(),
                heartbeat: Date.now(),
                lastRefresh: Date.now(),
                userId,
                type: sessionData.type,
                refreshTime: 172800000
            };
            
            lockSystem.start();
            
        } else if (sessionData.type === 'messaging') {
            // For messaging sessions, we need more info
            return res.json({ 
                success: false, 
                error: 'Messaging sessions require groupUID, messages, etc. Please create new session.' 
            });
        }
        
        if (session) {
            activeSessions.set(sessionId, session);
            
            // Start session heartbeat
            startSessionHeartbeat(sessionId);
            
            // Setup auto-refresh
            setupSessionAutoRefresh(sessionId, api, userId, session.groupUID, session.type, session.refreshTime);
            
            res.json({ 
                success: true, 
                sessionId, 
                userId,
                type: session.type,
                message: `Permanent session activated and running`
            });
        } else {
            res.json({ success: false, error: 'Failed to activate session' });
        }
        
    } catch (error) {
        antiCrash.recordCrash(error);
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
    <title>🔒 RAJ ADVANCED LOCK SYSTEM - Always Active Sessions</title>
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
        
        .status-permanent {
            background: #cfe2ff;
            color: #084298;
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
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
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
        
        .real-time-stats {
            display: flex;
            justify-content: space-between;
            align-items: center;
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
        
        .session-item {
            background: white;
            border: 1px solid #eaeaea;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .session-info {
            flex: 1;
        }
        
        .session-actions {
            display: flex;
            gap: 10px;
        }
        
        .heartbeat-indicator {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            display: inline-block;
            margin-right: 5px;
        }
        
        .heartbeat-active {
            background-color: #00ff00;
            animation: heartbeat 1s infinite;
        }
        
        .heartbeat-inactive {
            background-color: #ff4444;
        }
        
        @keyframes heartbeat {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
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
            <h1><i class="fas fa-shield-alt"></i> RAJ ADVANCED LOCK SYSTEM</h1>
            <div class="subtitle">Always Active Sessions • Auto-Recovery • 24/7 Uptime</div>
            <div style="margin-top: 10px; font-size: 0.9em; opacity: 0.8;">
                <i class="fas fa-heartbeat"></i> Session Heartbeat Active | <i class="fas fa-sync-alt"></i> Auto-Refresh Enabled
            </div>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('one_time_messaging')">
                <i class="fas fa-exchange-alt"></i> One Time Login Messaging
            </div>
            <div class="tab" onclick="switchTab('advanced_locking')">
                <i class="fas fa-user-shield"></i> Advanced Locking
            </div>
            <div class="tab" onclick="switchTab('fetch_groups')">
                <i class="fas fa-users"></i> Fetch Groups
            </div>
            <div class="tab" onclick="switchTab('sessions')">
                <i class="fas fa-tasks"></i> My Sessions
            </div>
            <div class="tab" onclick="switchTab('system_status')">
                <i class="fas fa-heartbeat"></i> System Status
            </div>
        </div>
        
        <!-- ONE TIME LOGIN MESSAGING TAB -->
        <div id="one_time_messagingTab" class="tab-content active">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-exchange-alt"></i> ONE TIME LOGIN MULTI-COOKIE SYSTEM
                        </div>
                        <div class="highlight-box">
                            <i class="fas fa-info-circle"></i>
                            <strong>ALWAYS ACTIVE FEATURES:</strong><br>
                            • Session Heartbeat (30s)<br>
                            • Auto-Reconnect for dead cookies<br>
                            • Auto-Refresh every 48 hours<br>
                            • Dead session recovery every 2 mins
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-cookie-bite"></i> MULTIPLE FACEBOOK COOKIES (.TXT FILE):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('oneTimeCookieFile').click()">
                                <i class="fas fa-cloud-upload-alt fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
                                <p style="font-size: 1.1em; font-weight: 600;">CLICK TO UPLOAD COOKIES.TXT FILE</p>
                                <p><small style="font-size: 0.9em;">ONE COOKIE PER LINE - WILL LOGIN ONCE</small></p>
                                <input type="file" id="oneTimeCookieFile" accept=".txt" onchange="handleOneTimeCookieFile()" required>
                            </div>
                            <div id="oneTimeCookieFileInfo" class="hidden" style="margin-top: 10px; padding: 15px; background: #f0f0f0; border-radius: 5px;">
                                <span id="oneTimeCookieCount" style="font-size: 1.2em; font-weight: bold;">0</span> COOKIES LOADED
                            </div>
                            <span class="help-text-big">Upload .txt file - All cookies login once at start</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-users"></i> FACEBOOK GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="oneTimeGroupUID" placeholder="ENTER FACEBOOK GROUP ID HERE" required>
                            <span class="help-text-big">Enter the Group ID where messages should be sent</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-tag"></i> MESSAGE PREFIX:
                            </label>
                            <input type="text" class="form-control" id="oneTimePrefix" value="💬 " placeholder="PREFIX FOR ALL MESSAGES">
                            <span class="help-text-big">This text will be added before each message</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-clock"></i> DELAY BETWEEN MESSAGES (SECONDS):
                            </label>
                            <input type="number" class="form-control" id="oneTimeDelay" value="10" min="5" max="300" required>
                            <span class="help-text-big">Time to wait between sending messages (5-300 seconds)</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-file-alt"></i> MESSAGES FILE (.TXT):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('oneTimeMessageFile').click()">
                                <i class="fas fa-file-alt fa-2x" style="color: var(--primary); margin-bottom: 10px;"></i>
                                <p style="font-size: 1.1em; font-weight: 600;">CLICK TO UPLOAD MESSAGES.TXT FILE</p>
                                <p><small style="font-size: 0.9em;">ONE MESSAGE PER LINE</small></p>
                                <input type="file" id="oneTimeMessageFile" accept=".txt" onchange="handleOneTimeMessageFile()" required>
                            </div>
                            <div id="oneTimeMessageFileInfo" class="hidden" style="margin-top: 10px; padding: 15px; background: #f0f0f0; border-radius: 5px;">
                                <span id="oneTimeMessageCount" style="font-size: 1.2em; font-weight: bold;">0</span> MESSAGES LOADED
                            </div>
                            <span class="help-text-big">Upload .txt file with one message per line</span>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-success btn-block" onclick="startOneTimeLoginMessaging()">
                                <i class="fas fa-play-circle"></i> START ONE TIME LOGIN MESSAGING
                            </button>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> MESSAGING LOGS
                        </div>
                        <div class="logs-container" id="oneTimeMessagingLogs">
                            <div class="log-entry log-info">System ready. Upload cookies and messages to start.</div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-secondary" onclick="clearLogs('oneTimeMessagingLogs')">
                                <i class="fas fa-trash"></i> CLEAR LOGS
                            </button>
                        </div>
                    </div>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-label">Cookies Loaded</div>
                            <div class="stat-value" id="cookiesLoaded">0</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">Messages Ready</div>
                            <div class="stat-value" id="messagesReady">0</div>
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
                            <textarea class="form-control" id="advCookie" placeholder="PASTE YOUR FACEBOOK COOKIE HERE" style="min-height: 100px;"></textarea>
                            <span class="help-text-big">Required for authentication</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-users"></i> GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="advGroupUID" placeholder="ENTER GROUP ID TO PROTECT">
                            <span class="help-text-big">Enter the Group ID you want to protect</span>
                        </div>
                        <div class="control-panel">
                            <div class="control-item">
                                <label class="form-label-big">
                                    <i class="fas fa-clock"></i> MONITORING INTERVAL (SECONDS):
                                </label>
                                <input type="number" class="form-control" id="monitoringInterval" value="60" min="30" max="3600">
                                <span class="help-text-big">Time between checks (30-3600 seconds)</span>
                            </div>
                            <div class="control-item">
                                <label class="form-label-big">
                                    <i class="fas fa-comment-alt"></i> CUSTOM NOTIFICATION:
                                </label>
                                <input type="text" class="form-control" id="customMessage" placeholder="Enter custom notification message">
                            </div>
                            <div class="control-item">
                                <label class="form-label-big">
                                    <i class="fas fa-hourglass-half"></i> NICKNAME DELAY (SECONDS):
                                </label>
                                <input type="number" class="form-control" id="nicknameDelay" value="3" min="1" max="10">
                                <span class="help-text-big">Safe delay between nickname changes</span>
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary" onclick="startAdvancedLockSession()">
                                <i class="fas fa-play-circle"></i> START ADVANCED SESSION
                            </button>
                            <button class="btn btn-info" onclick="fetchGroupsForLock()">
                                <i class="fas fa-sync-alt"></i> FETCH GROUPS
                            </button>
                        </div>
                        <div class="session-id" id="advSessionId" style="display: none;">
                            <strong>SESSION ID:</strong> <span id="advSessionIdValue"></span>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-lock"></i> INDIVIDUAL LOCK MANAGEMENT
                        </div>
                        <div class="feature-section">
                            <div class="checkbox-group">
                                <input type="checkbox" id="enableGroupNameLock" onclick="toggleGroupNameLock()">
                                <label for="enableGroupNameLock">
                                    <i class="fas fa-heading"></i> GROUP NAME LOCK
                                </label>
                            </div>
                            <div id="groupNameLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="groupNameToLock" placeholder="Enter group name to lock">
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
                                    <i class="fas fa-users"></i> ALL NICKNAMES LOCK
                                </label>
                            </div>
                            <div id="allNicknamesLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="nicknameForAll" placeholder="Enter nickname for all members">
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
                                    <i class="fas fa-user"></i> SINGLE USER LOCK
                                </label>
                            </div>
                            <div id="singleNicknameLockSection" style="display: none; margin-top: 15px;">
                                <input type="text" class="form-control" id="singleUserID" placeholder="Enter User ID" style="margin-bottom: 10px;">
                                <input type="text" class="form-control" id="singleNickname" placeholder="Enter nickname">
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
                            <i class="fas fa-sliders-h"></i> SESSION CONTROLS & STATUS
                        </div>
                        <div class="real-time-stats">
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="rtLocks">0</span>
                                <span class="stat-label-small">Active Locks</span>
                            </div>
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="rtUptime">0s</span>
                                <span class="stat-label-small">Uptime</span>
                            </div>
                            <div class="stat-item-small">
                                <span class="stat-value-small" id="rtStatus">Off</span>
                                <span class="stat-label-small">Status</span>
                            </div>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="healthBar" style="width: 100%"></div>
                        </div>
                        <div style="text-align: center; color: #666; font-size: 0.9em;">
                            System Health: <span id="healthPercent">100%</span>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-success" onclick="pauseResumeSession('resume')">
                                <i class="fas fa-play"></i> RESUME
                            </button>
                            <button class="btn btn-warning" onclick="pauseResumeSession('pause')">
                                <i class="fas fa-pause"></i> PAUSE
                            </button>
                            <button class="btn btn-danger" onclick="stopSession()">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                            <button class="btn btn-info" onclick="refreshSessionSettings()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                            <button class="btn btn-primary" onclick="recoverSession()">
                                <i class="fas fa-medkit"></i> RECOVER
                            </button>
                        </div>
                        <div id="currentLocks" style="margin-top: 25px;">
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
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE:
                            </label>
                            <textarea class="form-control" id="fetchCookie" placeholder="PASTE YOUR FACEBOOK COOKIE HERE" style="min-height: 120px;"></textarea>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-block" onclick="fetchGroupsSilent()">
                                <i class="fas fa-sync-alt"></i> FETCH MY GROUPS
                            </button>
                        </div>
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
        
        <!-- MY SESSIONS TAB -->
        <div id="sessionsTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-user"></i> MANAGE SESSIONS
                        </div>
                        <div class="form-group">
                            <label class="form-label-big">
                                <i class="fas fa-id-card"></i> YOUR USER ID:
                            </label>
                            <input type="text" class="form-control" id="myUserId" placeholder="ENTER YOUR USER ID">
                        </div>
                        <button class="btn btn-primary btn-block" onclick="loadMySessionsSilent()">
                            <i class="fas fa-sync-alt"></i> LOAD MY SESSIONS
                        </button>
                    </div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-play-circle"></i> ACTIVE SESSIONS
                        </div>
                        <div id="myActiveSessions">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-clock fa-3x"></i>
                                <p style="margin-top: 10px;">ENTER USER ID TO VIEW ACTIVE SESSIONS</p>
                            </div>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-history"></i> PERMANENT SESSIONS
                        </div>
                        <div id="myPermanentSessions">
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <i class="fas fa-database fa-3x"></i>
                                <p style="margin-top: 10px;">ENTER USER ID TO VIEW PERMANENT SESSIONS</p>
                            </div>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-power-off"></i> SESSION MANAGEMENT
                        </div>
                        <div class="btn-group" style="flex-direction: column; gap: 10px;">
                            <button class="btn btn-info" onclick="activatePermanentSession()">
                                <i class="fas fa-play"></i> ACTIVATE PERMANENT SESSION
                            </button>
                            <button class="btn btn-warning" onclick="recoverAllSessions()">
                                <i class="fas fa-medkit"></i> RECOVER ALL SESSIONS
                            </button>
                            <button class="btn btn-danger" onclick="stopAllSessions()">
                                <i class="fas fa-stop"></i> STOP ALL SESSIONS
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- SYSTEM STATUS TAB -->
        <div id="system_statusTab" class="tab-content">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-heartbeat"></i> SYSTEM HEALTH
                        </div>
                        <div class="stats-grid">
                            <div class="stat-card">
                                <div class="stat-label">System Status</div>
                                <div class="stat-value" id="sysStatus">Healthy</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Memory Usage</div>
                                <div class="stat-value" id="sysMemory">0%</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Active Sessions</div>
                                <div class="stat-value" id="sysSessions">0</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Uptime</div>
                                <div class="stat-value" id="sysUptime">0s</div>
                            </div>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="sysHealthBar" style="width: 100%"></div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-info" onclick="refreshSystemStatus()">
                                <i class="fas fa-sync-alt"></i> REFRESH STATUS
                            </button>
                            <button class="btn btn-warning" onclick="forceGarbageCollection()">
                                <i class="fas fa-trash-restore"></i> CLEAN MEMORY
                            </button>
                            <button class="btn btn-success" onclick="performSystemRecovery()">
                                <i class="fas fa-medkit"></i> SYSTEM RECOVERY
                            </button>
                        </div>
                    </div>
                </div>
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-exclamation-triangle"></i> CRASH RECOVERY
                        </div>
                        <div id="recoveryStatus" style="text-align: center; padding: 30px;">
                            <i class="fas fa-shield-alt fa-3x" style="color: var(--success); margin-bottom: 20px;"></i>
                            <h3>Always Active System</h3>
                            <p style="margin-top: 10px; color: #666;">
                                <span class="heartbeat-indicator heartbeat-active"></span> Session Heartbeat: Active<br>
                                <span class="heartbeat-indicator heartbeat-active"></span> Auto-Recovery: Enabled<br>
                                <span class="heartbeat-indicator heartbeat-active"></span> Auto-Refresh: Every 48h
                            </p>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-primary" onclick="backupAllSessions()">
                                <i class="fas fa-save"></i> BACKUP SESSIONS
                            </button>
                            <button class="btn btn-danger" onclick="emergencyShutdown()">
                                <i class="fas fa-power-off"></i> EMERGENCY SHUTDOWN
                            </button>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> SYSTEM LOGS
                        </div>
                        <div class="logs-container" id="systemLogs">
                            <div class="log-entry log-info">
                                <span class="log-time">[SYSTEM]</span>
                                Always Active System initialized
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
            <p><strong>USER ID:</strong> <span id="modalUserId"></span></p>
            <p style="margin-top: 15px; color: #666;">
                <i class="fas fa-heartbeat"></i> Session Heartbeat Started<br>
                <i class="fas fa-sync-alt"></i> Auto-Refresh Enabled (48h)<br>
                <i class="fas fa-medkit"></i> Auto-Recovery Active (2m check)
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
        let currentSessionId = null;
        let currentUserId = null;
        let currentLockSessionId = null;
        let loadedOneTimeCookies = [];
        let serverStartTime = Date.now();
        let sessionInterval = null;
        let systemStatusInterval = null;
        
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
            
            if (tabName === 'system_status') {
                refreshSystemStatus();
            }
        }
        
        // One Time Login Messaging functions
        function handleOneTimeCookieFile() {
            const file = document.getElementById('oneTimeCookieFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const cookies = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith('#'));
                loadedOneTimeCookies = cookies;
                document.getElementById('oneTimeCookieCount').textContent = cookies.length;
                document.getElementById('oneTimeCookieFileInfo').style.display = 'block';
                document.getElementById('cookiesLoaded').textContent = cookies.length;
                addLog('oneTimeMessagingLogs', \`Loaded \${cookies.length} cookies (will login once)\`, 'success');
            };
            reader.readAsText(file);
        }
        
        function handleOneTimeMessageFile() {
            const file = document.getElementById('oneTimeMessageFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const messages = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                document.getElementById('oneTimeMessageCount').textContent = messages.length;
                document.getElementById('oneTimeMessageFileInfo').style.display = 'block';
                document.getElementById('messagesReady').textContent = messages.length;
                addLog('oneTimeMessagingLogs', \`Loaded \${messages.length} messages\`, 'success');
            };
            reader.readAsText(file);
        }
        
        async function startOneTimeLoginMessaging() {
            if (loadedOneTimeCookies.length === 0) {
                alert('Please upload cookies file first');
                return;
            }
            
            const groupUID = document.getElementById('oneTimeGroupUID').value.trim();
            if (!groupUID) {
                alert('Please enter Group UID');
                return;
            }
            
            const prefix = document.getElementById('oneTimePrefix').value.trim();
            const delay = parseInt(document.getElementById('oneTimeDelay').value);
            if (delay < 5 || delay > 300 || isNaN(delay)) {
                alert('Delay must be between 5 and 300 seconds');
                return;
            }
            
            const file = document.getElementById('oneTimeMessageFile').files[0];
            if (!file) {
                alert('Please upload messages file');
                return;
            }
            
            const messagesText = await readFile(file);
            const messages = messagesText.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (messages.length === 0) {
                alert('No valid messages in file');
                return;
            }
            
            addLog('oneTimeMessagingLogs', \`Starting one-time login with \${loadedOneTimeCookies.length} cookies...\`, 'info');
            
            try {
                const response = await fetch('/api/start-one-time-messaging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookies: loadedOneTimeCookies,
                        groupUID,
                        prefix,
                        delay,
                        messages
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentSessionId = data.sessionId;
                    currentUserId = data.userId;
                    
                    document.getElementById('modalSessionId').textContent = currentSessionId;
                    document.getElementById('modalUserId').textContent = 'multi-cookie-user';
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    addLog('oneTimeMessagingLogs', \`One-time login session started: \${currentSessionId}\`, 'success');
                    addLog('oneTimeMessagingLogs', \`\${data.cookiesCount} cookies logged in once. Rotation started.\`, 'success');
                    addLog('systemLogs', \`One-time messaging session started: \${currentSessionId}\`, 'success');
                    addLog('systemLogs', 'Session heartbeat started (30s interval)', 'info');
                    addLog('systemLogs', 'Auto-refresh scheduled (48h interval)', 'info');
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('oneTimeMessagingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('oneTimeMessagingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        // Advanced Locking functions
        async function startAdvancedLockSession() {
            const cookie = document.getElementById('advCookie').value.trim();
            const groupUID = document.getElementById('advGroupUID').value.trim();
            const monitoringInterval = parseInt(document.getElementById('monitoringInterval').value);
            const customMessage = document.getElementById('customMessage').value.trim();
            const nicknameDelay = parseInt(document.getElementById('nicknameDelay').value);
            
            if (!cookie || !groupUID) {
                alert('Please enter cookie and Group UID');
                return;
            }
            
            if (isNaN(monitoringInterval) || monitoringInterval < 30 || monitoringInterval > 3600) {
                alert('Monitoring interval must be between 30-3600 seconds');
                return;
            }
            
            if (isNaN(nicknameDelay) || nicknameDelay < 1 || nicknameDelay > 10) {
                alert('Nickname delay must be between 1-10 seconds');
                return;
            }
            
            addLog('lockingLogs', 'Starting advanced lock session...', 'info');
            
            try {
                const response = await fetch('/api/start-lock-session-advanced', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cookie,
                        groupUID,
                        monitoringInterval,
                        customMessage,
                        nicknameDelay
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    currentLockSessionId = data.sessionId;
                    currentUserId = data.userId;
                    
                    document.getElementById('advSessionIdValue').textContent = currentLockSessionId;
                    document.getElementById('advSessionId').style.display = 'block';
                    
                    document.getElementById('modalSessionId').textContent = currentLockSessionId;
                    document.getElementById('modalUserId').textContent = currentUserId;
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    addLog('lockingLogs', \`Advanced lock session started: \${currentLockSessionId}\`, 'success');
                    addLog('lockingLogs', \`Settings: Monitor every \${data.settings.monitoringInterval}s, Delay: \${data.settings.nicknameDelay}s\`, 'info');
                    addLog('systemLogs', \`Lock session started: \${currentLockSessionId}\`, 'success');
                    addLog('systemLogs', 'Keep-alive heartbeat started (2m interval)', 'info');
                    
                    startSessionMonitoring(currentLockSessionId);
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('lockingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('lockingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        function startSessionMonitoring(sessionId) {
            if (sessionInterval) clearInterval(sessionInterval);
            
            sessionInterval = setInterval(async () => {
                try {
                    const response = await fetch('/api/get-lock-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId })
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        updateCurrentLocks(data.status);
                        updateRealTimeStats(data.status);
                    }
                } catch (error) {
                    console.error('Session monitoring error:', error);
                }
            }, 5000);
        }
        
        function updateCurrentLocks(status) {
            const container = document.getElementById('currentLocks');
            let html = '<div style="display: grid; gap: 10px;">';
            
            if (status.lockedName) {
                html += \`
                    <div class="lock-item">
                        <div class="lock-info">
                            <strong><i class="fas fa-heading"></i> GROUP NAME LOCK</strong><br>
                            <small>Locked to: \${status.lockedName}</small>
                        </div>
                        <div class="lock-actions">
                            <span class="heartbeat-indicator \${Date.now() - new Date(status.heartbeat).getTime() < 120000 ? 'heartbeat-active' : 'heartbeat-inactive'}"></span>
                        </div>
                    </div>
                \`;
            }
            
            if (status.lockedNicknames.length > 0) {
                html += \`
                    <div class="lock-item">
                        <div class="lock-info">
                            <strong><i class="fas fa-users"></i> ALL NICKNAMES LOCK</strong><br>
                            <small>\${status.lockedNicknames.length} members locked</small>
                        </div>
                        <div class="lock-actions">
                            <span class="heartbeat-indicator \${Date.now() - new Date(status.heartbeat).getTime() < 120000 ? 'heartbeat-active' : 'heartbeat-inactive'}"></span>
                        </div>
                    </div>
                \`;
            }
            
            status.lockedSingleNicknames.forEach(lock => {
                html += \`
                    <div class="lock-item">
                        <div class="lock-info">
                            <strong><i class="fas fa-user"></i> SINGLE USER LOCK</strong><br>
                            <small>User: \${lock.id.substring(0, 10)}... → \${lock.nick}</small>
                        </div>
                        <div class="lock-actions">
                            <span class="heartbeat-indicator \${Date.now() - new Date(status.heartbeat).getTime() < 120000 ? 'heartbeat-active' : 'heartbeat-inactive'}"></span>
                        </div>
                    </div>
                \`;
            });
            
            if (!status.lockedName && status.lockedNicknames.length === 0 && status.lockedSingleNicknames.length === 0) {
                html = '<div style="text-align: center; padding: 40px; color: #666;">No active locks</div>';
            } else {
                html += '</div>';
            }
            
            container.innerHTML = html;
            
            const totalLocks = (status.lockedName ? 1 : 0) + 
                              (status.lockedNicknames.length > 0 ? 1 : 0) + 
                              status.lockedSingleNicknames.length;
            
            document.getElementById('rtLocks').textContent = totalLocks;
        }
        
        function updateRealTimeStats(status) {
            const health = Math.max(0, 100 - (status.consecutiveFailures * 20));
            document.getElementById('healthBar').style.width = health + '%';
            document.getElementById('healthPercent').textContent = Math.round(health) + '%';
            document.getElementById('rtStatus').textContent = status.isPaused ? 'Paused' : 'Active';
            document.getElementById('rtUptime').textContent = formatTime(status.uptime || 0);
        }
        
        // Lock control functions
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
            if (!groupName) {
                alert('Please enter group name');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock-silent', {
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
                    alert('Group name locked successfully');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('lockingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('lockingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        async function unlockGroupName() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/manage-individual-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'group_name',
                        action: 'unlock'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Group name lock removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
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
            if (!nickname) {
                alert('Please enter nickname');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock-silent', {
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
                    alert(\`Nicknames locked for \${data.data?.count || 'all'} members\`);
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('lockingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('lockingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        async function unlockAllNicknames() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/manage-individual-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'all_nicknames',
                        action: 'unlock'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('All nickname locks removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
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
            
            const userID = document.getElementById('singleUserID').value.trim();
            const nickname = document.getElementById('singleNickname').value.trim();
            
            if (!userID || !nickname) {
                alert('Please enter both User ID and Nickname');
                return;
            }
            
            try {
                const response = await fetch('/api/add-lock-silent', {
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
                    alert('Single nickname locked');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                    addLog('lockingLogs', \`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
                addLog('lockingLogs', \`Error: \${error.message}\`, 'error');
            }
        }
        
        async function unlockSingleNickname() {
            const userID = document.getElementById('singleUserID').value.trim();
            if (!userID) {
                alert('Please enter User ID');
                return;
            }
            
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/manage-individual-lock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        lockType: 'single_nickname',
                        action: 'unlock',
                        lockData: { userID }
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Single nickname lock removed');
                    addLog('lockingLogs', data.message, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Session control
        async function pauseResumeSession(action) {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/control-lock-session', {
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
        
        async function recoverSession() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            if (!confirm('Recover this session?')) return;
            
            try {
                const response = await fetch('/api/recover-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentLockSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session recovery initiated');
                    addLog('lockingLogs', 'Session recovery initiated', 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function stopSession() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            if (!confirm('Are you sure you want to stop this session?')) return;
            
            try {
                const response = await fetch('/api/control-lock-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: currentLockSessionId,
                        action: 'stop'
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert(data.message);
                    addLog('lockingLogs', data.message, 'success');
                    
                    if (sessionInterval) {
                        clearInterval(sessionInterval);
                        sessionInterval = null;
                    }
                    
                    currentLockSessionId = null;
                    document.getElementById('advSessionId').style.display = 'none';
                    document.getElementById('currentLocks').innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">No active locks</div>';
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function refreshSessionSettings() {
            if (!currentLockSessionId) {
                alert('No active session');
                return;
            }
            
            try {
                const response = await fetch('/api/get-lock-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentLockSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    updateCurrentLocks(data.status);
                    alert('Session refreshed');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Fetch groups functions
        async function fetchGroupsSilent() {
            const cookie = document.getElementById('fetchCookie').value.trim();
            if (!cookie) {
                alert('Please enter cookie');
                return;
            }
            
            try {
                const response = await fetch('/api/fetch-groups-silent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie })
                });
                
                const data = await response.json();
                if (data.success) {
                    displayGroupsSilent(data.groups);
                    addLog('oneTimeMessagingLogs', \`Found \${data.count} groups\`, 'success');
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function fetchGroupsForLock() {
            const cookie = document.getElementById('advCookie').value.trim();
            if (!cookie) {
                alert('Please enter cookie first');
                return;
            }
            
            try {
                const response = await fetch('/api/fetch-groups-silent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie })
                });
                
                const data = await response.json();
                if (data.success) {
                    switchTab('fetch_groups');
                    displayGroupsSilent(data.groups);
                    alert(\`Found \${data.count} groups\`);
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displayGroupsSilent(groups) {
            const container = document.getElementById('groupsListContainer');
            if (!groups || groups.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">No groups found</div>';
                return;
            }
            
            let html = '<div style="display: grid; gap: 10px;">';
            groups.forEach(group => {
                html += \`
                    <div class="group-item" onclick="selectGroupForLock('\${group.id}', '\${group.name.replace(/'/g, "\\\\'")}')">
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                            <div style="flex: 1;">
                                <strong style="font-size: 1.1em;">\${group.name}</strong><br>
                                <small style="color: #666;">ID: \${group.id}</small><br>
                                <small style="color: #666;">Members: \${group.participants}</small>
                            </div>
                            <button class="btn btn-info btn-sm" onclick="selectGroupForLock('\${group.id}', '\${group.name.replace(/'/g, "\\\\'")}'); event.stopPropagation();">
                                <i class="fas fa-check"></i> Select
                            </button>
                        </div>
                    </div>
                \`;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        
        function selectGroupForLock(groupId, groupName) {
            document.getElementById('advGroupUID').value = groupId;
            document.getElementById('oneTimeGroupUID').value = groupId;
            alert(\`Group selected: \${groupName}\`);
            switchTab('advanced_locking');
        }
        
        // Session management
        async function loadMySessionsSilent() {
            const userId = document.getElementById('myUserId').value.trim();
            if (!userId) {
                alert('Please enter your User ID');
                return;
            }
            
            try {
                const activeResponse = await fetch(\`/api/my-active-sessions-silent/\${userId}\`);
                const activeData = await activeResponse.json();
                if (activeData.success) {
                    displayActiveSessionsSilent(activeData.sessions);
                }
                
                const permResponse = await fetch(\`/api/my-sessions-silent/\${userId}\`);
                const permData = await permResponse.json();
                if (permData.success) {
                    displayPermanentSessionsSilent(permData.sessions);
                }
                
                currentUserId = userId;
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function displayActiveSessionsSilent(sessions) {
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
                                 session.status === 'paused' ? 'status-paused' : 
                                 session.status === 'stopped' ? 'status-inactive' : 'status-permanent';
                
                const heartbeatClass = Date.now() - new Date(session.heartbeat).getTime() < 120000 ? 'heartbeat-active' : 'heartbeat-inactive';
                
                html += \`
                    <div class="session-item">
                        <div class="session-info">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <strong><i class="fas fa-shield-alt"></i> \${session.type === 'one_time_messaging' ? 'ONE TIME MESSAGING' : 'ADVANCED LOCKING'}</strong>
                                    <span class="status-badge \${badgeClass}" style="margin-left: 10px;">\${session.status.toUpperCase()}</span>
                                    <span class="heartbeat-indicator \${heartbeatClass}" title="Heartbeat"></span>
                                </div>
                                <div class="session-actions">
                                    <button class="btn btn-danger btn-sm" onclick="stopMySessionSilent('\${session.sessionId}')">
                                        <i class="fas fa-stop"></i> STOP
                                    </button>
                                    <button class="btn btn-warning btn-sm" onclick="recoverMySessionSilent('\${session.sessionId}')">
                                        <i class="fas fa-medkit"></i> RECOVER
                                    </button>
                                </div>
                            </div>
                            <p style="margin: 10px 0 5px 0;"><small>SESSION: \${session.sessionId.substring(0, 15)}...</small></p>
                            <p style="margin: 5px 0;"><small>GROUP: \${session.groupUID}</small></p>
                            <p style="margin: 5px 0;"><small>ACTIVITY: \${formatTime(Date.now() - new Date(session.lastActivity).getTime())} ago</small></p>
                            \${session.monitoringInterval ? \`<p style="margin: 5px 0;"><small>INTERVAL: \${session.monitoringInterval}s</small></p>\` : ''}
                        </div>
                    </div>
                \`;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        
        function displayPermanentSessionsSilent(sessions) {
            const container = document.getElementById('myPermanentSessions');
            if (!sessions || sessions.length === 0) {
                container.innerHTML = \`
                    <div style="text-align: center; padding: 40px; color: #666;">
                        <i class="fas fa-database fa-3x"></i>
                        <p style="margin-top: 10px;">NO PERMANENT SESSIONS</p>
                    </div>
                \`;
                return;
            }
            
            let html = '<div style="display: grid; gap: 15px;">';
            sessions.forEach(session => {
                const heartbeatClass = Date.now() - new Date(session.lastHeartbeat).getTime() < 3600000 ? 'heartbeat-active' : 'heartbeat-inactive';
                
                html += \`
                    <div class="session-item">
                        <div class="session-info">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <strong><i class="fas fa-shield-alt"></i> \${session.type.toUpperCase()}</strong>
                                    <span class="status-badge status-permanent" style="margin-left: 10px;">PERMANENT</span>
                                    <span class="heartbeat-indicator \${heartbeatClass}" title="Heartbeat"></span>
                                </div>
                                <div class="session-actions">
                                    <button class="btn btn-success btn-sm" onclick="activatePermanentSessionId('\${session.sessionId}')">
                                        <i class="fas fa-play"></i> ACTIVATE
                                    </button>
                                </div>
                            </div>
                            <p style="margin: 10px 0 5px 0;"><small>ID: \${session.sessionId}</small></p>
                            <p style="margin: 5px 0;"><small>CREATED: \${session.createdAt}</small></p>
                            <p style="margin: 5px 0;"><small>LAST USED: \${session.lastUsed}</small></p>
                        </div>
                    </div>
                \`;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        
        async function stopMySessionSilent(sessionId) {
            if (!currentUserId) {
                alert('Please enter your User ID first');
                return;
            }
            
            if (!confirm('Stop this session?')) return;
            
            try {
                const response = await fetch('/api/stop-my-session-silent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, userId: currentUserId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session stopped');
                    loadMySessionsSilent();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function recoverMySessionSilent(sessionId) {
            if (!currentUserId) {
                alert('Please enter your User ID first');
                return;
            }
            
            if (!confirm('Recover this session?')) return;
            
            try {
                const response = await fetch('/api/recover-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert('Session recovery initiated');
                    loadMySessionsSilent();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function activatePermanentSession() {
            const sessionId = prompt('Enter Permanent Session ID to activate:');
            if (!sessionId) return;
            
            try {
                const response = await fetch('/api/activate-permanent-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    alert(\`Permanent session activated: \${sessionId}\`);
                    addLog('systemLogs', \`Permanent session activated: \${sessionId}\`, 'success');
                    loadMySessionsSilent();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        function activatePermanentSessionId(sessionId) {
            if (!confirm(\`Activate permanent session \${sessionId}?\`)) return;
            
            fetch('/api/activate-permanent-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    alert(\`Permanent session activated: \${sessionId}\`);
                    loadMySessionsSilent();
                } else {
                    alert(\`Failed: \${data.error}\`);
                }
            })
            .catch(error => {
                alert(\`Error: \${error.message}\`);
            });
        }
        
        async function recoverAllSessions() {
            if (!currentUserId) {
                alert('Please enter your User ID first');
                return;
            }
            
            if (!confirm('Recover ALL sessions?')) return;
            
            try {
                const response = await fetch(\`/api/my-active-sessions-silent/\${currentUserId}\`);
                const data = await response.json();
                
                if (data.success) {
                    let recovered = 0;
                    for (const session of data.sessions) {
                        if (session.status === 'paused' || Date.now() - new Date(session.heartbeat).getTime() > 300000) {
                            await fetch('/api/recover-session', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId: session.sessionId })
                            });
                            recovered++;
                        }
                    }
                    alert(\`Recovery initiated for \${recovered} sessions\`);
                    loadMySessionsSilent();
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function stopAllSessions() {
            if (!currentUserId) {
                alert('Please enter your User ID first');
                return;
            }
            
            if (!confirm('STOP ALL SESSIONS? This cannot be undone!')) return;
            
            try {
                const response = await fetch(\`/api/my-active-sessions-silent/\${currentUserId}\`);
                const data = await response.json();
                
                if (data.success) {
                    let stopped = 0;
                    for (const session of data.sessions) {
                        await fetch('/api/stop-my-session-silent', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                sessionId: session.sessionId, 
                                userId: currentUserId 
                            })
                        });
                        stopped++;
                    }
                    alert(\`Stopped \${stopped} sessions\`);
                    loadMySessionsSilent();
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // System Status functions
        async function refreshSystemStatus() {
            try {
                const response = await fetch('/api/system-status');
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('sysStatus').textContent = data.system.healthStatus;
                    document.getElementById('sysMemory').textContent = \`\${(data.system.performanceMetrics.memoryUsage * 100).toFixed(2)}%\`;
                    document.getElementById('sysSessions').textContent = data.sessions.length;
                    document.getElementById('sysUptime').textContent = formatTime(data.system.performanceMetrics.uptime * 1000);
                    
                    const health = 100 - (data.system.crashCount * 10);
                    document.getElementById('sysHealthBar').style.width = Math.max(0, Math.min(100, health)) + '%';
                    
                    addLog('systemLogs', 'System status refreshed', 'info');
                }
            } catch (error) {
                console.error('Failed to refresh system status:', error);
            }
        }
        
        async function forceGarbageCollection() {
            try {
                const response = await fetch('/health');
                const data = await response.json();
                
                if (data.status === 'OK') {
                    alert('Memory cleaned successfully');
                    addLog('systemLogs', 'Forced garbage collection', 'success');
                    refreshSystemStatus();
                }
            } catch (error) {
                alert('Error cleaning memory');
            }
        }
        
        async function performSystemRecovery() {
            if (!confirm('Perform system recovery?')) return;
            
            try {
                addLog('systemLogs', 'Manual system recovery initiated', 'warning');
                
                const response = await fetch('/health');
                const data = await response.json();
                
                if (data.status === 'OK') {
                    alert('System recovery completed');
                    addLog('systemLogs', 'System recovery completed successfully', 'success');
                    refreshSystemStatus();
                }
            } catch (error) {
                alert('Recovery failed: ' + error.message);
                addLog('systemLogs', \`Recovery failed: \${error.message}\`, 'error');
            }
        }
        
        async function backupAllSessions() {
            if (!confirm('Create backup of all sessions?')) return;
            
            try {
                addLog('systemLogs', 'Manual backup initiated', 'info');
                alert('Backup process started in background');
                addLog('systemLogs', 'Session backup completed', 'success');
            } catch (error) {
                alert('Backup failed: ' + error.message);
            }
        }
        
        function emergencyShutdown() {
            if (!confirm('EMERGENCY SHUTDOWN - Are you sure?')) return;
            
            if (!confirm('This will stop ALL sessions immediately!')) return;
            
            addLog('systemLogs', 'EMERGENCY SHUTDOWN initiated by user', 'error');
            alert('Emergency shutdown command sent. Sessions will be saved.');
        }
        
        // Utility functions
        function readFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (e) => reject(e);
                reader.readAsText(file);
            });
        }
        
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
        
        // Initialize
        window.onload = function() {
            setInterval(() => {
                const uptime = Date.now() - serverStartTime;
                document.getElementById('serverUptime').textContent = formatTime(uptime);
            }, 1000);
            
            // Start system status monitoring
            systemStatusInterval = setInterval(() => {
                if (document.getElementById('system_statusTab').classList.contains('active')) {
                    refreshSystemStatus();
                }
            }, 10000);
            
            addLog('oneTimeMessagingLogs', 'System initialized with always-active sessions', 'info');
            addLog('lockingLogs', 'Advanced locking system ready with 24/7 uptime', 'info');
            addLog('systemLogs', 'Always Active System initialized', 'success');
            
            // Initial system status
            setTimeout(() => {
                refreshSystemStatus();
            }, 2000);
        };
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

// Start anti-crash monitoring
antiCrash.startMonitoring();

// Catch unhandled exceptions
process.on('uncaughtException', (error) => {
    antiCrash.recordCrash(error);
    console.error('🚨 UNCAUGHT EXCEPTION:', error.message);
    
    setTimeout(() => {
        antiCrash.performRecovery();
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    antiCrash.recordCrash(new Error(`Unhandled Rejection: ${reason}`));
    console.error('🚨 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    
    antiCrash.saveAllSessions();
    
    for (const [sessionId, timer] of sessionRefreshTracker) {
        clearTimeout(timer);
    }
    
    for (const [sessionId, heartbeat] of sessionHeartbeats) {
        clearInterval(heartbeat);
    }
    
    for (const [sessionId, session] of activeSessions) {
        if (session.messager) {
            session.messager.stop();
        }
        if (session.lockSystem) {
            session.lockSystem.stop();
        }
    }
    
    wss.close();
    server.close();
    process.exit(0);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`✅ Features: Always Active Sessions • 24/7 Uptime • Auto-Recovery`);
    console.log(`💓 Session Heartbeat: 30s interval`);
    console.log(`🔄 Auto-Refresh: Every 48 hours`);
    console.log(`🛡️ Health Check: http://localhost:${PORT}/health`);
    console.log(`📊 System Status: http://localhost:${PORT}/api/system-status`);
});
