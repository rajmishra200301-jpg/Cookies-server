const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== PERSISTENT SESSION MANAGER ====================
class PersistentSessionManager {
    constructor() {
        this.heartbeatInterval = 30000; // 30 seconds
        this.reconnectAttempts = new Map();
        this.maxReconnectAttempts = 10;
        this.sessionKeepAliveTimers = new Map();
        this.sessionCheckInterval = null;
    }

    initialize() {
        // Start session monitoring
        this.sessionCheckInterval = setInterval(() => {
            this.checkAllSessions();
        }, 60000); // Check every minute
        
        console.log('🔄 Persistent Session Manager initialized');
    }

    startSessionHeartbeat(sessionId) {
        // Clear existing timer
        if (this.sessionKeepAliveTimers.has(sessionId)) {
            clearInterval(this.sessionKeepAliveTimers.get(sessionId));
        }

        // Start new heartbeat
        const timer = setInterval(() => {
            this.keepSessionAlive(sessionId);
        }, this.heartbeatInterval);

        this.sessionKeepAliveTimers.set(sessionId, timer);
        console.log(`❤️ Started heartbeat for session: ${sessionId}`);
        
        // Reset reconnect attempts
        this.reconnectAttempts.set(sessionId, 0);
    }

    keepSessionAlive(sessionId) {
        const session = activeSessions.get(sessionId);
        if (!session) {
            this.stopSessionHeartbeat(sessionId);
            return;
        }

        // Update last activity
        session.lastActivity = Date.now();
        session.heartbeatCount = (session.heartbeatCount || 0) + 1;
        
        // Check session health
        this.checkSessionHealth(sessionId, session);
        
        // Update session in permanent storage
        if (session.api && session.userId) {
            try {
                savePermanentSession(sessionId, session.api, session.userId, session.type);
                session.lastSaved = Date.now();
            } catch (error) {
                antiCrash.recordCrash(error);
            }
        }

        // Broadcast status update
        updateSessionStatus(sessionId);
    }

    checkSessionHealth(sessionId, session) {
        const now = Date.now();
        
        // Check lock system
        if (session.lockSystem) {
            if (session.lockSystem.isPaused || !session.lockSystem.isActive) {
                console.log(`⚠️ Lock system inactive for session: ${sessionId}, restarting...`);
                try {
                    if (session.lockSystem.isPaused) {
                        session.lockSystem.resume();
                    } else {
                        session.lockSystem.start();
                    }
                    session.status = 'active';
                    console.log(`✅ Lock system restarted for session: ${sessionId}`);
                } catch (error) {
                    console.error(`❌ Failed to restart lock system: ${error.message}`);
                }
            }
        }
        
        // Check messager
        if (session.messager && !session.messager.isRunning) {
            console.log(`⚠️ Messager stopped for session: ${sessionId}, restarting...`);
            try {
                session.messager.start();
                session.status = 'active';
                console.log(`✅ Messager restarted for session: ${sessionId}`);
            } catch (error) {
                console.error(`❌ Failed to restart messager: ${error.message}`);
            }
        }
    }

    checkAllSessions() {
        const now = Date.now();
        
        for (const [sessionId, session] of activeSessions) {
            // Check if session is stale (no activity for 5 minutes)
            if (session.lastActivity && (now - session.lastActivity > 300000)) {
                console.log(`🔄 Auto-recovering stale session: ${sessionId}`);
                this.recoverSession(sessionId);
            }
            
            // Force save session every 30 minutes
            if (!session.lastSaved || (now - session.lastSaved > 1800000)) {
                if (session.api && session.userId) {
                    try {
                        savePermanentSession(sessionId, session.api, session.userId, session.type);
                        session.lastSaved = now;
                    } catch (error) {
                        antiCrash.recordCrash(error);
                    }
                }
            }
        }
    }

    recoverSession(sessionId) {
        const session = activeSessions.get(sessionId);
        if (!session) return false;

        const attempts = this.reconnectAttempts.get(sessionId) || 0;
        
        if (attempts >= this.maxReconnectAttempts) {
            console.error(`❌ Max recovery attempts reached for session: ${sessionId}`);
            return false;
        }

        console.log(`🔄 Recovery attempt ${attempts + 1} for session: ${sessionId}`);

        try {
            // For lock sessions
            if (session.lockSystem) {
                // Try to restart lock system
                if (session.lockSystem.isPaused) {
                    session.lockSystem.resume();
                } else if (!session.lockSystem.isActive) {
                    session.lockSystem.start();
                }
                
                // Update session
                session.status = 'active';
                session.lastActivity = Date.now();
                session.lastRecovery = Date.now();
                
                this.reconnectAttempts.set(sessionId, 0);
                console.log(`✅ Session recovered: ${sessionId}`);
                return true;
            }
            
            // For messaging sessions
            if (session.messager && !session.messager.isRunning) {
                session.messager.start();
                session.status = 'active';
                session.lastActivity = Date.now();
                
                this.reconnectAttempts.set(sessionId, 0);
                console.log(`✅ Session recovered: ${sessionId}`);
                return true;
            }
            
            // For sessions with API
            if (session.api && session.userId) {
                // Just update activity and status
                session.status = 'active';
                session.lastActivity = Date.now();
                
                this.reconnectAttempts.set(sessionId, attempts + 1);
                return true;
            }
        } catch (error) {
            console.error(`❌ Recovery failed for session ${sessionId}:`, error.message);
            this.reconnectAttempts.set(sessionId, attempts + 1);
            antiCrash.recordCrash(error);
        }
        
        return false;
    }

    stopSessionHeartbeat(sessionId) {
        if (this.sessionKeepAliveTimers.has(sessionId)) {
            clearInterval(this.sessionKeepAliveTimers.get(sessionId));
            this.sessionKeepAliveTimers.delete(sessionId);
            console.log(`⏹️ Stopped heartbeat for session: ${sessionId}`);
        }
    }

    cleanup() {
        // Stop all heartbeats
        for (const [sessionId, timer] of this.sessionKeepAliveTimers) {
            clearInterval(timer);
        }
        this.sessionKeepAliveTimers.clear();
        
        // Clear check interval
        if (this.sessionCheckInterval) {
            clearInterval(this.sessionCheckInterval);
        }
    }
}

// ==================== ANTI-CRASH SYSTEM ====================
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
            // Only clean sessions inactive for 2 hours (increased from 1 hour)
            if (session.lastActivity && (now - session.lastActivity > 7200000)) {
                console.log(`🧹 Cleaning stale session: ${sessionId}`);
                
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
                
                // Stop heartbeat
                persistentSessionManager.stopSessionHeartbeat(sessionId);
                
                activeSessions.delete(sessionId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} stale sessions`);
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
            
            // Recover all active sessions
            for (const [sessionId, session] of activeSessions) {
                persistentSessionManager.recoverSession(sessionId);
            }
            
            // Broadcast recovery status
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
            
            console.log('✅ Recovery completed successfully');
            this.recoveryAttempts = 0;
        } catch (recoveryError) {
            console.error('❌ Recovery failed:', recoveryError);
        }
    }

    emergencyShutdown() {
        console.log('🚨 EMERGENCY SHUTDOWN INITIATED');
        
        this.saveAllSessions();
        
        // Stop persistent session manager
        persistentSessionManager.cleanup();
        
        for (const [sessionId, session] of activeSessions) {
            if (session.messager) {
                session.messager.stop();
            }
            if (session.lockSystem) {
                session.lockSystem.stop();
            }
            persistentSessionManager.stopSessionHeartbeat(sessionId);
        }
        
        for (const [sessionId, timer] of sessionRefreshTracker) {
            clearTimeout(timer);
        }
        
        console.log('💾 Emergency shutdown complete');
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

// Initialize Persistent Session Manager
const persistentSessionManager = new PersistentSessionManager();

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions
const activeSessions = new Map();
const permanentSessions = new Map();
const sessionRefreshTracker = new Map();

// WebSocket Server
const wss = new WebSocket.Server({ server });

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
            lastSaved: Date.now()
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
                lastRefresh: session.lastRefresh
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
            lastRefresh: Date.now()
        };
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        
        const session = activeSessions.get(sessionId);
        if (session && session.refreshTime) {
            setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, session.refreshTime);
        }
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
        this.failedCookies = new Set();
        this.retryCount = 0;
        this.maxRetries = 3;
        this.lastActivity = Date.now();
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
                } else {
                    this.failedCookies.add(i);
                }
            } catch (error) {
                this.failedCookies.add(i);
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
        
        // Start heartbeat
        this.startHeartbeat();
        
        // Start processing
        this.processQueue();
    }

    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        this.heartbeatInterval = setInterval(() => {
            this.lastActivity = Date.now();
            
            // Check and revive dead cookies
            this.checkAndReviveCookies();
        }, 60000); // Check every minute
    }

    async checkAndReviveCookies() {
        const totalCookies = this.originalCookies.length;
        const failedCount = this.failedCookies.size;
        
        if (failedCount > 0 && this.activeApis.size < Math.ceil(totalCookies / 2)) {
            console.log(`🔄 Attempting to revive ${failedCount} failed cookies for session: ${this.sessionId}`);
            
            for (const cookieIndex of Array.from(this.failedCookies)) {
                try {
                    const cookie = this.originalCookies[cookieIndex];
                    const api = await new Promise((resolve) => {
                        silentLogin(cookie, (fbApi) => {
                            resolve(fbApi);
                        });
                    });
                    
                    if (api) {
                        this.activeApis.set(cookieIndex, api);
                        this.failedCookies.delete(cookieIndex);
                        console.log(`✅ Revived cookie ${cookieIndex + 1}/${totalCookies}`);
                    }
                } catch (error) {
                    antiCrash.recordCrash(error);
                }
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            try {
                this.lastActivity = Date.now();
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
                    this.failedCookies.add(cookieIndex);
                    return false;
                }
            } catch (error) {
                antiCrash.recordCrash(error);
                this.failedCookies.add(cookieIndex);
                return false;
            }
        }
        const api = this.activeApis.get(cookieIndex);
        return new Promise((resolve) => {
            api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                if (err) {
                    this.activeApis.delete(cookieIndex);
                    this.failedCookies.add(cookieIndex);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    stop() {
        this.isRunning = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
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
            lastActivity: new Date(this.lastActivity).toISOString()
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
        this.lastActivity = Date.now();
        this.autoRecover = true;
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.startSafeMonitoring();
        console.log(`🔒 Lock system started for session: ${this.sessionId}`);
    }

    stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        this.isActive = false;
        console.log(`⏹️ Lock system stopped for session: ${this.sessionId}`);
    }

    pause() {
        this.isPaused = true;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        console.log(`⏸️ Lock system paused for session: ${this.sessionId}`);
    }

    resume() {
        this.isPaused = false;
        this.startSafeMonitoring();
        console.log(`▶️ Lock system resumed for session: ${this.sessionId}`);
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
            this.lastActivity = Date.now();
            this.api.setTitle(groupName, this.groupUID, (err) => {
                if (err) {
                    this.consecutiveFailures++;
                    resolve({ success: false, message: err.message });
                } else {
                    this.lockedName = groupName;
                    this.consecutiveFailures = 0;
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
            this.lastActivity = Date.now();
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    this.consecutiveFailures++;
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
                                    this.consecutiveFailures = 0;
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
            this.lastActivity = Date.now();
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    this.consecutiveFailures++;
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
                        this.consecutiveFailures++;
                        resolve({ success: false, message: err.message });
                    } else {
                        this.consecutiveFailures = 0;
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
        
        // Initial check after 5 seconds
        setTimeout(() => {
            if (!this.isPaused) {
                this.safeEnforceLocks();
            }
        }, 5000);
    }

    async safeEnforceLocks() {
        if (this.consecutiveFailures >= this.maxFailures) {
            console.warn(`⚠️ Too many failures for session ${this.sessionId}, pausing...`);
            this.pause();
            return;
        }
        
        try {
            this.heartbeat = Date.now();
            this.lastActivity = Date.now();
            
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
                    this.consecutiveFailures++;
                    resolve();
                    return;
                }
                
                const currentName = info.threadName || '';
                if (currentName !== this.lockedName) {
                    if (this.customMessage) {
                        this.api.sendMessage(this.customMessage, this.groupUID, () => {
                            this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                                if (err) this.consecutiveFailures++;
                                resolve();
                            });
                        });
                    } else {
                        this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                            if (err) this.consecutiveFailures++;
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
                    this.consecutiveFailures++;
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
                                this.consecutiveFailures++;
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
                    this.consecutiveFailures++;
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
                            if (err) this.consecutiveFailures++;
                            
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
            monitoringInterval: this.monitoringIntervalTime / 1000, // Convert to seconds
            customMessage: this.customMessage,
            nicknameRestoreDelay: this.nicknameRestoreDelay / 1000, // Convert to seconds
            consecutiveFailures: this.consecutiveFailures,
            safeMode: this.safeMode,
            heartbeat: new Date(this.heartbeat).toISOString(),
            lastActivity: new Date(this.lastActivity).toISOString()
        };
    }
}

// ==================== WEB SOCKET FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    try {
        const session = activeSessions.get(sessionId);
        if (!session) return;
        
        session.lastActivity = Date.now();
        
        const sessionInfo = {
            sessionId: sessionId,
            groupUID: session.groupUID,
            status: session.status,
            messagesSent: session.messagesSent || 0,
            uptime: Date.now() - session.startTime,
            userId: session.userId || 'Unknown',
            type: session.type || 'unknown',
            lastActivity: session.lastActivity,
            heartbeatCount: session.heartbeatCount || 0
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
                            lastActivity: session.lastActivity
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

// ==================== AUTO-RECOVERY SYSTEM ====================
function startAutoRecovery() {
    console.log('🔄 Auto-recovery system starting...');
    
    // Session auto-recovery every 5 minutes
    setInterval(() => {
        try {
            const now = Date.now();
            let recovered = 0;
            
            for (const [sessionId, session] of activeSessions) {
                // Check if session needs recovery
                if (session.lastActivity && (now - session.lastActivity > 300000)) { // 5 minutes
                    console.log(`🔄 Auto-recovering session: ${sessionId}`);
                    
                    if (session.messager && !session.messager.isRunning) {
                        session.messager.start();
                        session.status = 'active';
                        session.lastActivity = Date.now();
                        recovered++;
                    }
                    
                    if (session.lockSystem && session.lockSystem.isPaused) {
                        session.lockSystem.resume();
                        session.status = 'active';
                        session.lastActivity = Date.now();
                        recovered++;
                    }
                }
            }
            
            if (recovered > 0) {
                console.log(`✅ Auto-recovered ${recovered} sessions`);
            }
        } catch (error) {
            antiCrash.recordCrash(error);
            console.error('Auto-recovery error:', error.message);
        }
    }, 300000); // 5 minutes
    
    // Auto-save sessions every 30 minutes
    setInterval(() => {
        try {
            for (const [sessionId, session] of activeSessions) {
                if (session.api && session.userId) {
                    savePermanentSession(sessionId, session.api, session.userId, session.type);
                }
            }
            console.log('💾 Auto-saved all sessions');
        } catch (error) {
            antiCrash.recordCrash(error);
        }
    }, 1800000); // 30 minutes
    
    console.log('✅ Auto-recovery system active');
}

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
            lastSaved: Date.now(),
            userId: 'multi-cookie-user',
            type: 'one_time_messaging',
            cookiesCount: cookies.length,
            heartbeatCount: 0
        };
        
        activeSessions.set(sessionId, session);
        
        // Start persistent heartbeat
        persistentSessionManager.startSessionHeartbeat(sessionId);
        
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
            lastSaved: Date.now(),
            userId,
            type: 'locking_advanced',
            refreshTime: 172800000,
            monitoringInterval: monitoringInterval || 60, // Default 60 seconds
            customMessage: customMessage || '',
            nicknameDelay: nicknameDelay || 2,
            heartbeatCount: 0
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'locking');
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'locking', session.refreshTime);
        
        // Start persistent heartbeat
        persistentSessionManager.startSessionHeartbeat(sessionId);
        
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
            lastSaved: Date.now(),
            userId,
            type: 'locking',
            heartbeatCount: 0
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'locking');
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'locking');
        
        // Start persistent heartbeat
        persistentSessionManager.startSessionHeartbeat(sessionId);
        
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
            heartbeatCount: session.heartbeatCount || 0
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
                persistentSessionManager.stopSessionHeartbeat(sessionId);
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

// Force keep session alive
app.post('/api/keep-alive', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        // Update activity
        session.lastActivity = Date.now();
        
        // Restart heartbeat if stopped
        persistentSessionManager.startSessionHeartbeat(sessionId);
        
        res.json({ 
            success: true, 
            message: 'Session kept alive',
            lastActivity: session.lastActivity 
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Recover session manually
app.post('/api/recover-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const recovered = persistentSessionManager.recoverSession(sessionId);
        
        if (recovered) {
            res.json({ 
                success: true, 
                message: 'Session recovery initiated',
                sessionId 
            });
        } else {
            res.json({ 
                success: false, 
                error: 'Failed to recover session',
                sessionId 
            });
        }
        
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
                lastRefresh: new Date(session.lastRefresh).toLocaleString()
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
                    heartbeatCount: session.heartbeatCount || 0
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
            
            // Stop heartbeat
            persistentSessionManager.stopSessionHeartbeat(sessionId);
            
            if (sessionRefreshTracker.has(sessionId)) {
                clearTimeout(sessionRefreshTracker.get(sessionId));
                sessionRefreshTracker.delete(sessionId);
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
            persistentHeartbeats: persistentSessionManager.sessionKeepAliveTimers.size
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
            persistentHeartbeats: persistentSessionManager.sessionKeepAliveTimers.size
        });
    } catch (error) {
        res.json({ status: 'ERROR', error: error.message });
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
                heartbeatCount: session.heartbeatCount || 0
            });
        }
        
        res.json({
            success: true,
            system: status,
            sessions: sessionsStatus,
            wsConnections: wss.clients.size,
            permanentSessions: permanentSessions.size,
            serverUptime: Date.now() - serverStartTime,
            persistentHeartbeats: persistentSessionManager.sessionKeepAliveTimers.size
        });
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// Keep all sessions alive endpoint
app.post('/api/keep-all-sessions-alive', async (req, res) => {
    try {
        let updated = 0;
        
        for (const [sessionId, session] of activeSessions) {
            session.lastActivity = Date.now();
            
            // Ensure heartbeat is running
            if (!persistentSessionManager.sessionKeepAliveTimers.has(sessionId)) {
                persistentSessionManager.startSessionHeartbeat(sessionId);
            }
            
            updated++;
        }
        
        res.json({
            success: true,
            message: `Kept ${updated} sessions alive`,
            sessionsUpdated: updated
        });
        
    } catch (error) {
        antiCrash.recordCrash(error);
        res.json({ success: false, error: error.message });
    }
});

// HTML Interface (same as before, too long to include here)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔒 RAJ ADVANCED LOCK SYSTEM - 24/7 Persistent Sessions</title>
    <style>
        /* CSS remains the same as before */
    </style>
</head>
<body>
    <!-- HTML interface remains the same as before -->
</body>
</html>
    `);
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

// Start anti-crash monitoring
antiCrash.startMonitoring();

// Start persistent session manager
persistentSessionManager.initialize();

// Start auto-recovery system
startAutoRecovery();

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
    console.log('💾 Shutting down gracefully...');
    
    antiCrash.saveAllSessions();
    
    // Cleanup persistent session manager
    persistentSessionManager.cleanup();
    
    for (const [sessionId, timer] of sessionRefreshTracker) {
        clearTimeout(timer);
    }
    
    for (const [sessionId, session] of activeSessions) {
        if (session.messager) {
            session.messager.stop();
        }
        if (session.lockSystem) {
            session.lockSystem.stop();
        }
        persistentSessionManager.stopSessionHeartbeat(sessionId);
    }
    
    wss.close();
    server.close();
    process.exit(0);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`✅ Features: Anti-Crash System, Auto-Recovery, 24/7 Uptime`);
    console.log(`🛡️  Persistent Session Manager: Active with heartbeat monitoring`);
    console.log(`❤️  Health Check: http://localhost:${PORT}/health`);
    console.log(`📊 System Status: http://localhost:${PORT}/api/system-status`);
});
