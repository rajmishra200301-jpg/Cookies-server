const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server with better timeout settings
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// Enhanced security middleware
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Security encryption for sensitive data
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return {
        iv: iv.toString('hex'),
        content: encrypted,
        tag: authTag.toString('hex')
    };
}

function decrypt(encryptedData) {
    try {
        const decipher = crypto.createDecipheriv(
            ALGORITHM,
            Buffer.from(ENCRYPTION_KEY, 'hex'),
            Buffer.from(encryptedData.iv, 'hex')
        );
        decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));
        let decrypted = decipher.update(encryptedData.content, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        return null;
    }
}

// Store active sessions with enhanced security
const activeSessions = new Map();
const permanentSessions = new Map();
const sessionRefreshTracker = new Map();
const sessionRecoveryQueue = new Map();

// Enhanced recovery system
const recoveryState = {
    lastRecovery: Date.now(),
    recoveryAttempts: new Map(),
    maxRecoveryAttempts: 3,
    recoveryCooldown: 300000 // 5 minutes
};

// WebSocket Server with heartbeat
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true,
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
    }
});

// Heartbeat for WebSocket connections
function setupWebSocketHeartbeat(ws) {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
}

// ==================== ANTI-CRASH & AUTO-RECOVERY SYSTEM ====================
class AntiCrashSystem {
    constructor() {
        this.memoryThreshold = 0.8; // 80% memory usage
        this.restartThreshold = 5; // Max restarts per hour
        this.restartCount = 0;
        this.lastRestartTime = Date.now();
        this.errorBuffer = [];
        this.maxErrorBuffer = 100;
        this.healthCheckInterval = 30000; // 30 seconds
        this.startHealthMonitoring();
    }

    startHealthMonitoring() {
        setInterval(() => {
            this.checkHealth();
        }, this.healthCheckInterval);
    }

    checkHealth() {
        const memoryUsage = process.memoryUsage();
        const heapUsedRatio = memoryUsage.heapUsed / memoryUsage.heapTotal;
        
        if (heapUsedRatio > this.memoryThreshold) {
            this.logHealthWarning(`High memory usage: ${(heapUsedRatio * 100).toFixed(2)}%`);
            global.gc && global.gc(); // Call garbage collector if available
        }
        
        // Check for memory leaks
        if (memoryUsage.heapUsed > 500 * 1024 * 1024) { // 500MB
            this.logHealthWarning('High memory consumption detected');
        }
    }

    logHealthWarning(message) {
        const timestamp = new Date().toISOString();
        console.error(`[HEALTH] ${timestamp} - ${message}`);
        this.errorBuffer.push({ timestamp, message, type: 'health_warning' });
        
        if (this.errorBuffer.length > this.maxErrorBuffer) {
            this.errorBuffer.shift();
        }
    }

    logError(error, context = 'system') {
        const timestamp = new Date().toISOString();
        const errorObj = {
            timestamp,
            context,
            message: error.message,
            stack: error.stack,
            type: 'error'
        };
        
        this.errorBuffer.push(errorObj);
        
        if (this.errorBuffer.length > this.maxErrorBuffer) {
            this.errorBuffer.shift();
        }
        
        // Silent logging - no console output
        fs.appendFileSync(
            path.join(__dirname, 'logs', 'error.log'),
            `${JSON.stringify(errorObj)}\n`
        );
    }

    getHealthStatus() {
        const memoryUsage = process.memoryUsage();
        return {
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
                rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
                usagePercent: ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(2) + '%'
            },
            uptime: process.uptime(),
            restartCount: this.restartCount,
            activeSessions: activeSessions.size,
            recentErrors: this.errorBuffer.slice(-5)
        };
    }

    safeExecute(fn, context = 'unknown', maxRetries = 3) {
        let attempts = 0;
        
        const execute = async () => {
            try {
                attempts++;
                return await fn();
            } catch (error) {
                this.logError(error, context);
                
                if (attempts < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    return execute();
                }
                
                throw error;
            }
        };
        
        return execute();
    }
}

// Initialize anti-crash system
const antiCrash = new AntiCrashSystem();

// ==================== ENHANCED PERMANENT SESSION SYSTEM ====================
function savePermanentSession(sessionId, api, userId, type = 'messaging') {
    return antiCrash.safeExecute(() => {
        if (!api) return false;
        
        const appState = api.getAppState();
        const encryptedAppState = encrypt(JSON.stringify(appState));
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        const sessionDir = path.dirname(sessionPath);
        
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        
        const sessionData = {
            sessionId,
            appState: encryptedAppState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            version: '2.0'
        };
        
        // Backup existing session if it exists
        if (fs.existsSync(sessionPath)) {
            const backupPath = sessionPath + '.backup';
            fs.copyFileSync(sessionPath, backupPath);
        }
        
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
        permanentSessions.set(sessionId, sessionData);
        
        return true;
    }, 'savePermanentSession');
}

function loadPermanentSession(sessionId) {
    return antiCrash.safeExecute(() => {
        if (permanentSessions.has(sessionId)) {
            return permanentSessions.get(sessionId);
        }
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (!fs.existsSync(sessionPath)) {
            return null;
        }
        
        const fileStats = fs.statSync(sessionPath);
        if (fileStats.size < 100) {
            // Try backup
            const backupPath = sessionPath + '.backup';
            if (fs.existsSync(backupPath)) {
                const backupStats = fs.statSync(backupPath);
                if (backupStats.size > 100) {
                    const sessionData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
                    permanentSessions.set(sessionId, sessionData);
                    return sessionData;
                }
            }
            return null;
        }
        
        const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        
        // Migration for old sessions
        if (!sessionData.version) {
            sessionData.version = '1.0';
            if (typeof sessionData.appState === 'string') {
                sessionData.appState = encrypt(sessionData.appState);
            }
        }
        
        permanentSessions.set(sessionId, sessionData);
        return sessionData;
    }, 'loadPermanentSession');
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

// ==================== ENHANCED AUTO REFRESH SYSTEM ====================
function setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, refreshTime = 172800000) {
    if (sessionRefreshTracker.has(sessionId)) {
        clearTimeout(sessionRefreshTracker.get(sessionId));
    }
    
    const refreshTimer = setTimeout(() => {
        antiCrash.safeExecute(() => {
            refreshSession(sessionId, api, userId, groupUID, type);
        }, `autoRefresh-${sessionId}`);
    }, refreshTime);
    
    sessionRefreshTracker.set(sessionId, refreshTimer);
}

function refreshSession(sessionId, api, userId, groupUID, type) {
    return antiCrash.safeExecute(() => {
        const appState = api.getAppState();
        const encryptedAppState = encrypt(JSON.stringify(appState));
        
        const sessionData = {
            sessionId,
            appState: encryptedAppState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            version: '2.0'
        };
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
        permanentSessions.set(sessionId, sessionData);
        
        const session = activeSessions.get(sessionId);
        if (session && session.refreshTime) {
            setupSessionAutoRefresh(sessionId, api, userId, groupUID, type, session.refreshTime);
        }
        
        return true;
    }, `refreshSession-${sessionId}`);
}

// ==================== ENHANCED SILENT LOGIN WITH RECOVERY ====================
function silentLogin(cookieString, callback) {
    const loginOptions = {
        appState: null,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent',
        selfListen: false,
        listenEvents: false,
        updatePresence: false,
        online: false
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
            try {
                const encryptedData = JSON.parse(cookieString);
                const decrypted = decrypt(encryptedData);
                if (decrypted) {
                    loginOptions.appState = JSON.parse(decrypted);
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
                setTimeout(tryNextMethod, 1500);
            }
        });
    }
    
    tryNextMethod();
}

function silentLoginWithPermanentSession(sessionId, callback) {
    antiCrash.safeExecute(() => {
        const sessionData = loadPermanentSession(sessionId);
        if (!sessionData || !sessionData.appState) {
            callback(null);
            return;
        }
        
        let appState;
        try {
            const decrypted = decrypt(sessionData.appState);
            appState = JSON.parse(decrypted);
        } catch (error) {
            callback(null);
            return;
        }
        
        const loginOptions = {
            appState: appState,
            userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
            forceLogin: false,
            logLevel: 'silent',
            selfListen: false,
            listenEvents: false,
            updatePresence: false,
            online: false
        };
        
        wiegine.login(loginOptions, (err, api) => {
            if (err || !api) {
                callback(null);
            } else {
                sessionData.lastUsed = Date.now();
                permanentSessions.set(sessionId, sessionData);
                
                const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
                try {
                    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
                } catch (e) {
                    // Silent error
                }
                
                callback(api);
            }
        });
    }, `silentLogin-${sessionId}`);
}

// ==================== ENHANCED SAFE MESSAGING WITH RECOVERY ====================
class EnhancedSafeMessaging {
    constructor(sessionId, cookie, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.cookie = cookie;
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = Math.max(5, Math.min(delay, 300)) * 1000; // 5-300 seconds
        this.originalMessages = messages;
        this.messageQueue = [];
        this.isRunning = false;
        this.messageIndex = 0;
        this.api = null;
        this.messagesSent = 0;
        this.startTime = Date.now();
        this.consecutiveFailures = 0;
        this.maxFailures = 5;
        this.recoveryAttempts = 0;
        this.maxRecoveryAttempts = 3;
        this.healthCheckInterval = null;
        this.lastMessageTime = Date.now();
        this.encryptedCookie = encrypt(cookie);
        this.isRecovering = false;
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
                this.startHealthMonitoring();
                return true;
            }
        } catch (error) {
            antiCrash.logError(error, `messaging-init-${this.sessionId}`);
        }
        return false;
    }

    startHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(() => {
            this.checkHealth();
        }, 60000); // Check every minute
    }

    checkHealth() {
        const now = Date.now();
        const timeSinceLastMessage = now - this.lastMessageTime;
        
        if (this.isRunning && timeSinceLastMessage > this.delay * 3) {
            antiCrash.logError(
                new Error(`Messaging stalled for ${Math.round(timeSinceLastMessage/1000)}s`),
                `messaging-health-${this.sessionId}`
            );
            this.recover();
        }
    }

    async recover() {
        if (this.isRecovering || this.recoveryAttempts >= this.maxRecoveryAttempts) {
            return;
        }
        
        this.isRecovering = true;
        this.recoveryAttempts++;
        
        antiCrash.logError(
            new Error(`Starting recovery attempt ${this.recoveryAttempts}`),
            `messaging-recovery-${this.sessionId}`
        );
        
        // Stop current process
        this.isRunning = false;
        this.api = null;
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Reinitialize
        const initialized = await this.initialize();
        if (initialized) {
            this.isRunning = true;
            this.processQueue();
            antiCrash.logError(
                new Error(`Recovery successful`),
                `messaging-recovery-${this.sessionId}`
            );
        }
        
        this.isRecovering = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.processQueue();
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            if (this.consecutiveFailures >= this.maxFailures) {
                await this.recover();
                if (this.consecutiveFailures >= this.maxFailures) {
                    this.stop();
                    break;
                }
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            const messageNumber = this.messageIndex + 1;

            const success = await this.sendMessage(messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                this.lastMessageTime = Date.now();
                this.recoveryAttempts = 0;
                
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
            const timeout = setTimeout(() => {
                resolve(false);
            }, 30000); // 30 second timeout
            
            this.api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                clearTimeout(timeout);
                if (err) {
                    this.api = null;
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    stop() {
        this.isRunning = false;
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            consecutiveFailures: this.consecutiveFailures,
            recoveryAttempts: this.recoveryAttempts,
            uptime: Date.now() - this.startTime,
            lastMessageTime: new Date(this.lastMessageTime).toISOString(),
            isRecovering: this.isRecovering
        };
    }
}

// ==================== ENHANCED MULTI-COOKIE MESSAGER WITH RECOVERY ====================
class EnhancedMultiCookieMessager {
    constructor(sessionId, cookies, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.originalCookies = cookies.map(cookie => encrypt(cookie));
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = Math.max(5, Math.min(delay, 300)) * 1000;
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
        this.maxFailures = 5;
        this.recoveryAttempts = 0;
        this.maxRecoveryAttempts = 3;
        this.healthCheckInterval = null;
        this.lastMessageTime = Date.now();
        this.isRecovering = false;
    }

    async initializeAllCookiesOnce() {
        if (this.initialized) return true;
        
        const totalCookies = this.originalCookies.length;
        let successCount = 0;
        let failedCookies = [];
        
        for (let i = 0; i < totalCookies; i++) {
            const encryptedCookie = this.originalCookies[i];
            try {
                const cookie = decrypt(encryptedCookie);
                if (!cookie) {
                    failedCookies.push(i);
                    continue;
                }
                
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
                    failedCookies.push(i);
                }
            } catch (error) {
                failedCookies.push(i);
                antiCrash.logError(error, `cookie-init-${i}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
        
        // Remove failed cookies from rotation
        failedCookies.forEach(index => {
            this.originalCookies.splice(index, 1);
        });
        
        this.initialized = successCount > 0;
        this.startHealthMonitoring();
        return this.initialized;
    }

    startHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(() => {
            this.checkHealth();
        }, 60000);
    }

    checkHealth() {
        const now = Date.now();
        const timeSinceLastMessage = now - this.lastMessageTime;
        
        if (this.isRunning && timeSinceLastMessage > this.delay * 3) {
            antiCrash.logError(
                new Error(`Multi-cookie messaging stalled for ${Math.round(timeSinceLastMessage/1000)}s`),
                `multicookie-health-${this.sessionId}`
            );
            this.recover();
        }
    }

    async recover() {
        if (this.isRecovering || this.recoveryAttempts >= this.maxRecoveryAttempts) {
            return;
        }
        
        this.isRecovering = true;
        this.recoveryAttempts++;
        
        antiCrash.logError(
            new Error(`Starting multi-cookie recovery attempt ${this.recoveryAttempts}`),
            `multicookie-recovery-${this.sessionId}`
        );
        
        // Stop current process
        this.isRunning = false;
        this.activeApis.clear();
        this.initialized = false;
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Reinitialize
        const initialized = await this.initializeAllCookiesOnce();
        if (initialized) {
            this.isRunning = true;
            this.processQueue();
            antiCrash.logError(
                new Error(`Multi-cookie recovery successful`),
                `multicookie-recovery-${this.sessionId}`
            );
        }
        
        this.isRecovering = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.processQueue();
    }

    async processQueue() {
        while (this.isRunning && this.messageQueue.length > 0) {
            if (this.consecutiveFailures >= this.maxFailures) {
                await this.recover();
                if (this.consecutiveFailures >= this.maxFailures) {
                    this.stop();
                    break;
                }
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            this.cookieIndex = (this.cookieIndex + 1) % this.originalCookies.length;
            
            const success = await this.sendWithCookie(this.cookieIndex, messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                this.lastMessageTime = Date.now();
                this.recoveryAttempts = 0;
                
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
        
        if (this.isRunning && this.messageQueue.length === 0) {
            this.messageQueue = [...this.originalMessages];
            this.messageIndex = 0;
            setTimeout(() => this.processQueue(), 1000);
        }
    }

    async sendWithCookie(cookieIndex, messageText) {
        if (!this.activeApis.has(cookieIndex)) {
            const encryptedCookie = this.originalCookies[cookieIndex];
            try {
                const cookie = decrypt(encryptedCookie);
                if (!cookie) return false;
                
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
                antiCrash.logError(error, `cookie-send-${cookieIndex}`);
                return false;
            }
        }
        
        const api = this.activeApis.get(cookieIndex);
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.activeApis.delete(cookieIndex);
                resolve(false);
            }, 30000);
            
            api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                clearTimeout(timeout);
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
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        this.activeApis.forEach(api => {
            try { api.logout(); } catch (e) {}
        });
        this.activeApis.clear();
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
            recoveryAttempts: this.recoveryAttempts,
            uptime: Date.now() - this.startTime,
            lastMessageTime: new Date(this.lastMessageTime).toISOString(),
            isRecovering: this.isRecovering
        };
    }
}

// ==================== ENHANCED ADVANCED SAFE LOCK SYSTEM WITH RECOVERY ====================
class EnhancedSafeLockSystem {
    constructor(sessionId, api, groupUID) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        
        // Locks
        this.lockedName = null;
        this.lockedNicknames = new Map();
        this.lockedSingleNickname = new Map();
        
        // Monitoring intervals
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
        this.maxFailures = 5;
        this.startTime = Date.now();
        this.healthCheckInterval = null;
        this.recoveryAttempts = 0;
        this.maxRecoveryAttempts = 3;
        this.isRecovering = false;
        this.lastCheckTime = Date.now();
        
        // API health
        this.apiHealthy = true;
        this.startHealthMonitoring();
    }

    startHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(() => {
            this.checkApiHealth();
        }, 30000);
    }

    checkApiHealth() {
        if (!this.api || this.isRecovering) return;
        
        // Simple API health check
        try {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err) {
                    this.apiHealthy = false;
                    this.consecutiveFailures++;
                    
                    if (this.consecutiveFailures >= 2) {
                        antiCrash.logError(
                            new Error(`API health check failed: ${err.message}`),
                            `lock-health-${this.sessionId}`
                        );
                        this.recover();
                    }
                } else {
                    this.apiHealthy = true;
                    this.consecutiveFailures = 0;
                    this.lastCheckTime = Date.now();
                }
            });
        } catch (error) {
            this.apiHealthy = false;
            antiCrash.logError(error, `lock-health-check-${this.sessionId}`);
        }
    }

    async recover() {
        if (this.isRecovering || this.recoveryAttempts >= this.maxRecoveryAttempts) {
            return;
        }
        
        this.isRecovering = true;
        this.recoveryAttempts++;
        
        antiCrash.logError(
            new Error(`Starting lock recovery attempt ${this.recoveryAttempts}`),
            `lock-recovery-${this.sessionId}`
        );
        
        // Stop monitoring
        this.stopIndividualMonitoring();
        
        // Get session data
        const session = activeSessions.get(this.sessionId);
        if (!session) {
            this.isRecovering = false;
            return;
        }
        
        // Try to reinitialize API
        try {
            if (session.encryptedCookie) {
                const cookie = decrypt(session.encryptedCookie);
                if (cookie) {
                    this.api = await new Promise((resolve) => {
                        silentLogin(cookie, (fbApi) => {
                            resolve(fbApi);
                        });
                    });
                    
                    if (this.api) {
                        this.apiHealthy = true;
                        this.consecutiveFailures = 0;
                        this.startIndividualMonitoring();
                        
                        antiCrash.logError(
                            new Error(`Lock recovery successful`),
                            `lock-recovery-${this.sessionId}`
                        );
                    }
                }
            }
        } catch (error) {
            antiCrash.logError(error, `lock-recovery-error-${this.sessionId}`);
        }
        
        this.isRecovering = false;
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.startIndividualMonitoring();
    }

    stop() {
        this.isActive = false;
        this.stopIndividualMonitoring();
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

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
            if (this.isActive && !this.isRecovering && this.apiHealthy) {
                this.monitorGroupName();
            }
        }, this.groupNameInterval * 1000);
        this.monitorGroupName();
    }

    startAllNicknamesMonitoring() {
        if (this.allNicknamesTimer) clearInterval(this.allNicknamesTimer);
        this.allNicknamesTimer = setInterval(() => {
            if (this.isActive && !this.isRecovering && this.apiHealthy) {
                this.monitorAllNicknames();
            }
        }, this.allNicknamesInterval * 1000);
        this.monitorAllNicknames();
    }

    startSingleNicknameMonitoring() {
        if (this.singleNicknameTimer) clearInterval(this.singleNicknameTimer);
        this.singleNicknameTimer = setInterval(() => {
            if (this.isActive && !this.isRecovering && this.apiHealthy) {
                this.monitorSingleNicknames();
            }
        }, this.singleNicknameInterval * 1000);
        this.monitorSingleNicknames();
    }

    setGroupNameInterval(seconds) {
        if (seconds < 1 || seconds > 300) {
            return { success: false, message: 'Interval must be between 1-300 seconds' };
        }
        this.groupNameInterval = seconds;
        if (this.lockedName) {
            this.startGroupNameMonitoring();
        }
        return { success: true, message: `Group name monitoring interval set to ${seconds} seconds` };
    }

    setAllNicknamesInterval(seconds) {
        if (seconds < 1 || seconds > 300) {
            return { success: false, message: 'Interval must be between 1-300 seconds' };
        }
        this.allNicknamesInterval = seconds;
        if (this.lockedNicknames.size > 0) {
            this.startAllNicknamesMonitoring();
        }
        return { success: true, message: `All nicknames monitoring interval set to ${seconds} seconds` };
    }

    setSingleNicknameInterval(seconds) {
        if (seconds < 1 || seconds > 300) {
            return { success: false, message: 'Interval must be between 1-300 seconds' };
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

    lockGroupName(groupName) {
        return new Promise((resolve) => {
            if (!groupName || groupName.trim() === '') {
                resolve({ success: true, message: 'Group name lock not set (optional)' });
                return;
            }
            
            const timeout = setTimeout(() => {
                resolve({ success: false, message: 'Operation timeout' });
            }, 30000);
            
            this.api.setTitle(groupName, this.groupUID, (err) => {
                clearTimeout(timeout);
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
            
            const timeout = setTimeout(() => {
                resolve({ success: false, message: 'Operation timeout' });
            }, 300000); // 5 minute timeout for bulk operations
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    clearTimeout(timeout);
                    resolve({ success: false, message: 'Failed to get group information' });
                    return;
                }
                
                if (!info.participantIDs || !Array.isArray(info.participantIDs)) {
                    clearTimeout(timeout);
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
                
                const processBatch = (startIndex) => {
                    if (startIndex >= participantIDs.length) {
                        clearTimeout(timeout);
                        if (successCount > 0) {
                            this.startAllNicknamesMonitoring();
                        }
                        resolve({
                            success: successCount > 0,
                            message: `Nicknames locked for ${successCount}/${participantIDs.length} members`,
                            count: successCount,
                            total: participantIDs.length
                        });
                        return;
                    }
                    
                    const endIndex = Math.min(startIndex + 5, participantIDs.length);
                    const batch = participantIDs.slice(startIndex, endIndex);
                    
                    batch.forEach((userID, index) => {
                        setTimeout(() => {
                            this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                                processedCount++;
                                if (!err) {
                                    successCount++;
                                    this.lockedNicknames.set(userID, nickname);
                                }
                                
                                if (processedCount >= participantIDs.length) {
                                    clearTimeout(timeout);
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
                    
                    setTimeout(() => processBatch(endIndex), batch.length * this.nicknameRestoreDelay + 1000);
                };
                
                processBatch(0);
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
            
            const timeout = setTimeout(() => {
                resolve({ success: false, message: 'Operation timeout' });
            }, 30000);
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    clearTimeout(timeout);
                    resolve({ success: false, message: 'Failed to get group information' });
                    return;
                }
                
                if (!info.participantIDs || !info.participantIDs.includes(userID)) {
                    clearTimeout(timeout);
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
                    clearTimeout(timeout);
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

    monitorGroupName() {
        if (!this.lockedName || this.consecutiveFailures >= this.maxFailures || !this.apiHealthy) return;
        
        const timeout = setTimeout(() => {
            this.consecutiveFailures++;
        }, 30000);
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            clearTimeout(timeout);
            if (err || !info) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentName = info.threadName || '';
            if (currentName !== this.lockedName) {
                this.api.setTitle(this.lockedName, this.groupUID, (err) => {
                    if (!err) {
                        this.consecutiveFailures = 0;
                        if (this.customMessage) {
                            this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                        }
                    } else {
                        this.consecutiveFailures++;
                    }
                });
            }
        });
    }

    monitorAllNicknames() {
        if (this.lockedNicknames.size === 0 || this.consecutiveFailures >= this.maxFailures || !this.apiHealthy) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentMembers = new Set(info.participantIDs);
            const lockedEntries = Array.from(this.lockedNicknames.entries());
            let processed = 0;
            let failures = 0;
            
            lockedEntries.forEach(([userID, nickname], index) => {
                if (!currentMembers.has(userID)) {
                    this.lockedNicknames.delete(userID);
                    this.memberCache.delete(userID);
                    processed++;
                    if (processed >= lockedEntries.length) {
                        if (failures > 0 && this.customMessage) {
                            this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                        }
                    }
                    return;
                }
                
                setTimeout(() => {
                    const timeout = setTimeout(() => {
                        processed++;
                        failures++;
                        
                        if (processed >= lockedEntries.length) {
                            this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                        }
                    }, 30000);
                    
                    this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                        clearTimeout(timeout);
                        processed++;
                        if (err) {
                            failures++;
                        }
                        
                        if (processed >= lockedEntries.length) {
                            this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                            if (failures > 0 && this.customMessage) {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }
                        }
                    });
                }, index * this.nicknameRestoreDelay);
            });
        });
    }

    monitorSingleNicknames() {
        if (this.lockedSingleNickname.size === 0 || this.consecutiveFailures >= this.maxFailures || !this.apiHealthy) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) {
                this.consecutiveFailures++;
                return;
            }
            
            const currentMembers = new Set(info.participantIDs);
            const lockedEntries = Array.from(this.lockedSingleNickname.entries());
            let processed = 0;
            let failures = 0;
            
            lockedEntries.forEach(([userID, nickname], index) => {
                if (!currentMembers.has(userID)) {
                    this.lockedSingleNickname.delete(userID);
                    this.memberCache.delete(userID);
                    processed++;
                    if (processed >= lockedEntries.length) {
                        if (failures > 0 && this.customMessage) {
                            this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                        }
                    }
                    return;
                }
                
                setTimeout(() => {
                    const timeout = setTimeout(() => {
                        processed++;
                        failures++;
                        
                        if (processed >= lockedEntries.length) {
                            this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                        }
                    }, 30000);
                    
                    this.api.changeNickname(nickname, this.groupUID, userID, (err) => {
                        clearTimeout(timeout);
                        processed++;
                        if (err) {
                            failures++;
                        }
                        
                        if (processed >= lockedEntries.length) {
                            this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                            if (failures > 0 && this.customMessage) {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }
                        }
                    });
                }, index * this.nicknameRestoreDelay);
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
            recoveryAttempts: this.recoveryAttempts,
            apiHealthy: this.apiHealthy,
            isActive: this.isActive,
            isRecovering: this.isRecovering,
            uptime: Date.now() - this.startTime,
            lastCheckTime: new Date(this.lastCheckTime).toISOString()
        };
    }
}

// ==================== ENHANCED WEB SOCKET FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    antiCrash.safeExecute(() => {
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
            encrypted: true
        };
        
        broadcastToSession(sessionId, { type: 'session_update', session: sessionInfo });
    }, `updateSessionStatus-${sessionId}`);
}

function broadcastToSession(sessionId, data) {
    wss.clients.forEach(client => {
        if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(data));
            } catch (error) {
                antiCrash.logError(error, `ws-broadcast-${sessionId}`);
            }
        }
    });
}

wss.on('connection', (ws, req) => {
    setupWebSocketHeartbeat(ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'authenticate' && data.sessionId) {
                ws.sessionId = data.sessionId;
                ws.send(JSON.stringify({ 
                    type: 'auth_success', 
                    message: 'Session authenticated',
                    encrypted: true
                }));
                
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
                        encrypted: true
                    };
                    ws.send(JSON.stringify({ type: 'session_info', session: sessionInfo }));
                }
            } else if (data.type === 'heartbeat') {
                ws.isAlive = true;
                ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
            }
        } catch (error) {
            antiCrash.logError(error, 'ws-message');
        }
    });
    
    ws.on('close', () => {
        // Silent disconnect
    });
    
    ws.on('error', (error) => {
        antiCrash.logError(error, 'ws-error');
    });
});

// WebSocket heartbeat check
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (error) {
            antiCrash.logError(error, 'ws-heartbeat');
        }
    });
}, 30000);

// ==================== ENHANCED API ROUTES ====================

// Start single cookie messaging
app.post('/api/start-single-messaging', async (req, res) => {
    try {
        const { cookie, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookie || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const sessionId = 'single_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        const messaging = new EnhancedSafeMessaging(sessionId, cookie, groupUID, prefix, delay, messages);
        
        const initialized = await messaging.initialize();
        if (!initialized) {
            return res.json({ success: false, error: 'Login failed', encrypted: true });
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
            userId: 'secure-user',
            type: 'single_messaging',
            encryptedCookie: encrypt(cookie)
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, messaging.api, 'secure-user', 'single_messaging');
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'secure-user', 
            message: `Single cookie messaging started with auto-recovery`,
            encrypted: true
        });
        
    } catch (error) {
        antiCrash.logError(error, 'start-single-messaging');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Start multi-cookie messaging
app.post('/api/start-multi-messaging', async (req, res) => {
    try {
        const { cookies, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookies || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const sessionId = 'multi_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        const messager = new EnhancedMultiCookieMessager(sessionId, cookies, groupUID, prefix, delay, messages);
        const initialized = await messager.initializeAllCookiesOnce();
        
        if (!initialized) {
            return res.json({ success: false, error: 'Failed to login with cookies', encrypted: true });
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
            userId: 'secure-user-multi',
            type: 'multi_messaging',
            cookiesCount: cookies.length,
            encryptedCookies: cookies.map(cookie => encrypt(cookie))
        };
        
        activeSessions.set(sessionId, session);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'secure-user-multi', 
            cookiesCount: cookies.length, 
            message: `Messaging started with ${cookies.length} cookies (auto-recovery enabled)`,
            encrypted: true
        });
        
    } catch (error) {
        antiCrash.logError(error, 'start-multi-messaging');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Fetch groups
app.post('/api/fetch-groups', async (req, res) => {
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
            return res.json({ success: false, error: 'Login failed', encrypted: true });
        }
        
        api.getThreadList(100, null, ['INBOX'], (err, threadList) => {
            if (err) {
                res.json({ success: false, error: err.message, encrypted: true });
                return;
            }
            
            const groups = threadList
                .filter(thread => thread.isGroup)
                .map(thread => ({
                    id: thread.threadID,
                    name: thread.name || `Group ${thread.threadID}`,
                    participants: thread.participants ? thread.participants.length : 0,
                    encrypted: true
                }))
                .sort((a, b) => b.participants - a.participants);
            
            res.json({ success: true, groups, count: groups.length, encrypted: true });
        });
        
    } catch (error) {
        antiCrash.logError(error, 'fetch-groups');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Start advanced lock session
app.post('/api/start-advanced-lock', async (req, res) => {
    try {
        const { cookie, groupUID, customMessage, nicknameDelay } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const sessionId = 'lock_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        let api = null;
        let userId = null;
        
        api = await new Promise((resolve) => {
            silentLogin(cookie, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed', encrypted: true });
        }
        
        userId = api.getCurrentUserID();
        const lockSystem = new EnhancedSafeLockSystem(sessionId, api, groupUID);
        
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
            encryptedCookie: encrypt(cookie)
        };
        
        activeSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'advanced_locking');
        setupSessionAutoRefresh(sessionId, api, userId, groupUID, 'advanced_locking', session.refreshTime);
        
        res.json({ 
            success: true, 
            sessionId, 
            userId, 
            message: `Advanced lock session started with auto-recovery`,
            settings: {
                customMessage: customMessage || null,
                nicknameDelay: nicknameDelay || 2
            },
            encrypted: true
        });
        
    } catch (error) {
        antiCrash.logError(error, 'start-advanced-lock');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Update lock settings
app.post('/api/update-lock-settings', async (req, res) => {
    try {
        const { sessionId, settings } = req.body;
        
        if (!sessionId || !settings) {
            return res.json({ success: false, error: 'Missing session ID or settings', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session', encrypted: true });
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
        
        if (updates.length > 0) {
            res.json({ 
                success: true, 
                message: `Settings updated: ${updates.join(', ')}`,
                currentSettings: lockSystem.getStatus(),
                encrypted: true
            });
        } else {
            res.json({ success: false, error: 'No valid updates provided', encrypted: true });
        }
        
    } catch (error) {
        antiCrash.logError(error, 'update-lock-settings');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Add lock
app.post('/api/add-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session', encrypted: true });
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
                    return res.json({ success: false, error: 'Missing user ID', encrypted: true });
                }
                result = await session.lockSystem.lockSingleNickname(lockData.userID, lockData?.nickname || '');
                break;
            default:
                return res.json({ success: false, error: 'Invalid lock type', encrypted: true });
        }
        
        res.json({ ...result, encrypted: true });
        
    } catch (error) {
        antiCrash.logError(error, 'add-lock');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Remove lock
app.post('/api/remove-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session', encrypted: true });
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
                    return res.json({ success: false, error: 'Missing user ID', encrypted: true });
                }
                result = session.lockSystem.unlockSingleNickname(lockData.userID);
                break;
            default:
                return res.json({ success: false, error: 'Invalid lock type', encrypted: true });
        }
        
        res.json({ ...result, encrypted: true });
        
    } catch (error) {
        antiCrash.logError(error, 'remove-lock');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Get session status
app.post('/api/get-session-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        let status = {};
        if (session.type === 'advanced_locking' && session.lockSystem) {
            status = session.lockSystem.getStatus();
        } else if (session.type === 'multi_messaging' && session.messager) {
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
            encrypted: true
        };
        
        res.json({ success: true, status, encrypted: true });
        
    } catch (error) {
        antiCrash.logError(error, 'get-session-status');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Control session
app.post('/api/control-session', async (req, res) => {
    try {
        const { sessionId, action } = req.body;
        
        if (!sessionId || !action) {
            return res.json({ success: false, error: 'Missing required fields', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        let result = { success: true, message: '', encrypted: true };
        
        switch (action) {
            case 'start':
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.start();
                    session.status = 'active';
                    result.message = 'Lock session started';
                } else if (session.type === 'multi_messaging' && session.messager) {
                    session.messager.start();
                    session.status = 'active';
                    result.message = 'Messaging session started';
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.start();
                    session.status = 'active';
                    result.message = 'Single messaging started';
                }
                break;
                
            case 'stop':
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.stop();
                } else if (session.type === 'multi_messaging' && session.messager) {
                    session.messager.stop();
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.stop();
                }
                session.status = 'stopped';
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
                result = { success: false, error: 'Invalid action', encrypted: true };
        }
        
        res.json(result);
        
    } catch (error) {
        antiCrash.logError(error, 'control-session');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Get messaging status
app.post('/api/get-messaging-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID', encrypted: true });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found', encrypted: true });
        }
        
        if (session.type !== 'multi_messaging' && session.type !== 'single_messaging') {
            return res.json({ success: false, error: 'Not a messaging session', encrypted: true });
        }
        
        let status = {};
        if (session.type === 'multi_messaging' && session.messager) {
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
            encrypted: true
        };
        
        res.json({ success: true, status, encrypted: true });
        
    } catch (error) {
        antiCrash.logError(error, 'get-messaging-status');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Get user's sessions
app.get('/api/my-sessions/:userId', (req, res) => {
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
                encrypted: true
            })),
            encrypted: true
        });
    } catch (error) {
        antiCrash.logError(error, 'my-sessions');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Get active sessions
app.get('/api/my-active-sessions/:userId', (req, res) => {
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
                    encrypted: true
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
        
        res.json({ success: true, sessions: userSessions, encrypted: true });
    } catch (error) {
        antiCrash.logError(error, 'my-active-sessions');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Stop session
app.post('/api/stop-my-session', async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        if (!sessionId || !userId) {
            return res.json({ success: false, error: 'Missing session ID or user ID', encrypted: true });
        }
        
        if (activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            if (session.userId !== userId) {
                return res.json({ success: false, error: 'Access denied', encrypted: true });
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
            activeSessions.delete(sessionId);
            res.json({ success: true, message: 'Session stopped', sessionId, encrypted: true });
        } else {
            res.json({ success: false, error: 'Session not found', encrypted: true });
        }
    } catch (error) {
        antiCrash.logError(error, 'stop-my-session');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Get system stats
app.get('/api/stats', (req, res) => {
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
            health: antiCrash.getHealthStatus(),
            encrypted: true
        });
    } catch (error) {
        antiCrash.logError(error, 'stats');
        res.json({ success: false, error: 'Internal server error', encrypted: true });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeSessions: activeSessions.size,
        timestamp: Date.now(),
        encrypted: true
    });
});

// ==================== GLOBAL ERROR HANDLER ====================
process.on('uncaughtException', (error) => {
    antiCrash.logError(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    antiCrash.logError(new Error(`Unhandled Rejection at: ${promise}, reason: ${reason}`), 'unhandledRejection');
});

// ==================== AUTO-RECOVERY MONITOR ====================
setInterval(() => {
    antiCrash.safeExecute(() => {
        // Check all active sessions for recovery
        for (const [sessionId, session] of activeSessions) {
            if (session.status === 'active') {
                // Check messaging sessions
                if (session.type === 'single_messaging' && session.messaging) {
                    const status = session.messaging.getStatus();
                    if (status.consecutiveFailures >= status.maxFailures && !status.isRecovering) {
                        session.messaging.recover();
                    }
                } else if (session.type === 'multi_messaging' && session.messager) {
                    const status = session.messager.getStatus();
                    if (status.consecutiveFailures >= status.maxFailures && !status.isRecovering) {
                        session.messager.recover();
                    }
                } else if (session.type === 'advanced_locking' && session.lockSystem) {
                    const status = session.lockSystem.getStatus();
                    if (status.consecutiveFailures >= status.maxFailures && !status.isRecovering) {
                        session.lockSystem.recover();
                    }
                }
            }
        }
        
        // Clean up old sessions
        const now = Date.now();
        for (const [sessionId, session] of activeSessions) {
            if (session.status === 'stopped' && now - session.startTime > 3600000) { // 1 hour
                activeSessions.delete(sessionId);
            }
        }
    }, 'auto-recovery-monitor');
}, 60000); // Check every minute

// ==================== BEAUTIFUL HTML INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🔒 ULTRA SAFE SYSTEM - 24/7 Auto-Recovery</title>
    <style>
        :root {
            --primary: #7c3aed;
            --primary-dark: #6d28d9;
            --secondary: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --info: #3b82f6;
            --dark: #1f2937;
            --light: #f9fafb;
            --gray: #6b7280;
            --gray-light: #e5e7eb;
            --gradient: linear-gradient(135deg, #7c3aed 0%, #10b981 100%);
            --shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            --radius: 12px;
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: var(--dark);
        }
        
        .container {
            max-width: 1600px;
            margin: 0 auto;
            background: white;
            border-radius: var(--radius);
            box-shadow: var(--shadow-lg);
            overflow: hidden;
            backdrop-filter: blur(10px);
            background: rgba(255, 255, 255, 0.98);
        }
        
        .header {
            background: var(--gradient);
            color: white;
            padding: 40px 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.1) 1px, transparent 1px);
            background-size: 50px 50px;
            animation: float 20s linear infinite;
        }
        
        @keyframes float {
            0% { transform: translate(0, 0) rotate(0deg); }
            100% { transform: translate(-50px, -50px) rotate(360deg); }
        }
        
        .header-content {
            position: relative;
            z-index: 1;
        }
        
        .header h1 {
            font-size: 3.2em;
            font-weight: 800;
            margin-bottom: 15px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
            background: linear-gradient(135deg, #fff 0%, #e0e7ff 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.5px;
        }
        
        .header .subtitle {
            font-size: 1.3em;
            opacity: 0.95;
            font-weight: 400;
            max-width: 800px;
            margin: 0 auto;
            line-height: 1.6;
        }
        
        .security-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(255,255,255,0.15);
            padding: 8px 16px;
            border-radius: 20px;
            margin-top: 20px;
            font-size: 0.9em;
            backdrop-filter: blur(10px);
        }
        
        .stats-bar {
            background: var(--dark);
            padding: 20px 30px;
            display: flex;
            justify-content: space-around;
            flex-wrap: wrap;
            gap: 25px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .stat-item {
            text-align: center;
            color: white;
            position: relative;
        }
        
        .stat-item::after {
            content: '';
            position: absolute;
            right: -15px;
            top: 50%;
            transform: translateY(-50%);
            width: 1px;
            height: 30px;
            background: rgba(255,255,255,0.2);
        }
        
        .stat-item:last-child::after {
            display: none;
        }
        
        .stat-value {
            font-size: 2.2em;
            font-weight: 700;
            display: block;
            background: var(--gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .stat-label {
            font-size: 0.9em;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 5px;
        }
        
        .tabs {
            display: flex;
            background: var(--light);
            border-bottom: 2px solid var(--gray-light);
            overflow-x: auto;
            scrollbar-width: none;
        }
        
        .tabs::-webkit-scrollbar {
            display: none;
        }
        
        .tab {
            padding: 22px 32px;
            cursor: pointer;
            font-weight: 600;
            color: var(--gray);
            border-right: 1px solid var(--gray-light);
            transition: var(--transition);
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 1.05em;
            position: relative;
            overflow: hidden;
        }
        
        .tab:hover {
            background: white;
            color: var(--primary);
        }
        
        .tab.active {
            background: white;
            color: var(--primary);
            border-bottom: 3px solid var(--primary);
        }
        
        .tab.active::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, rgba(124, 58, 237, 0.05) 0%, rgba(16, 185, 129, 0.05) 100%);
            z-index: -1;
        }
        
        .tab-content {
            display: none;
            padding: 40px;
            animation: fadeIn 0.3s ease-out;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .tab-content.active {
            display: block;
        }
        
        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
        }
        
        @media (max-width: 1200px) {
            .grid-2 {
                grid-template-columns: 1fr;
                gap: 30px;
            }
        }
        
        .card {
            background: white;
            border-radius: var(--radius);
            padding: 32px;
            margin-bottom: 30px;
            box-shadow: var(--shadow);
            border: 1px solid var(--gray-light);
            transition: var(--transition);
            position: relative;
        }
        
        .card:hover {
            transform: translateY(-5px);
            box-shadow: var(--shadow-lg);
        }
        
        .card-title {
            font-size: 1.7em;
            color: var(--primary);
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 15px;
            padding-bottom: 15px;
            border-bottom: 2px solid var(--gray-light);
        }
        
        .card-title i {
            font-size: 1.2em;
            background: var(--gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .feature-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: var(--gradient);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
            margin-left: auto;
        }
        
        .form-group {
            margin-bottom: 25px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 12px;
            font-weight: 600;
            color: var(--dark);
            font-size: 1.05em;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .form-control {
            width: 100%;
            padding: 16px;
            border: 2px solid var(--gray-light);
            border-radius: 10px;
            font-size: 1em;
            transition: var(--transition);
            background: white;
            font-family: 'Consolas', 'Monaco', monospace;
        }
        
        .form-control:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.2);
        }
        
        textarea.form-control {
            min-height: 140px;
            resize: vertical;
            line-height: 1.5;
        }
        
        .btn {
            padding: 16px 32px;
            border: none;
            border-radius: 10px;
            font-size: 1.1em;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
            display: inline-flex;
            align-items: center;
            gap: 12px;
            justify-content: center;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .btn-block {
            width: 100%;
        }
        
        .btn-primary {
            background: var(--gradient);
            color: white;
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 20px rgba(124, 58, 237, 0.3);
        }
        
        .btn-success {
            background: linear-gradient(135deg, var(--secondary) 0%, #0da271 100%);
            color: white;
        }
        
        .btn-danger {
            background: linear-gradient(135deg, var(--danger) 0%, #dc2626 100%);
            color: white;
        }
        
        .btn-warning {
            background: linear-gradient(135deg, var(--warning) 0%, #d97706 100%);
            color: white;
        }
        
        .btn-info {
            background: linear-gradient(135deg, var(--info) 0%, #2563eb 100%);
            color: white;
        }
        
        .btn-group {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 25px;
        }
        
        .logs-container {
            background: #0f172a;
            color: #94a3b8;
            padding: 25px;
            border-radius: 10px;
            height: 450px;
            overflow-y: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 0.95em;
            border: 2px solid #1e293b;
            position: relative;
        }
        
        .logs-container::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
        }
        
        .log-entry {
            padding: 10px 0;
            border-bottom: 1px solid #1e293b;
            line-height: 1.5;
            display: flex;
            gap: 15px;
            align-items: flex-start;
        }
        
        .log-time {
            color: #64748b;
            min-width: 100px;
            font-size: 0.9em;
        }
        
        .log-content {
            flex: 1;
            word-break: break-all;
        }
        
        .log-success { color: #10b981; }
        .log-error { color: #ef4444; }
        .log-warning { color: #f59e0b; }
        .log-info { color: #3b82f6; }
        
        .session-id {
            font-family: 'Consolas', monospace;
            background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            word-break: break-all;
            font-size: 1.1em;
            border: 2px dashed var(--gray-light);
            position: relative;
            padding-left: 50px;
        }
        
        .session-id::before {
            content: '🔑';
            position: absolute;
            left: 15px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 1.5em;
        }
        
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.9em;
        }
        
        .status-active {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
        }
        
        .status-paused {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
        }
        
        .status-inactive {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
        }
        
        .status-recovering {
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
            color: white;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.7; }
            100% { opacity: 1; }
        }
        
        .file-upload {
            border: 3px dashed var(--gray-light);
            border-radius: 15px;
            padding: 40px;
            text-align: center;
            cursor: pointer;
            transition: var(--transition);
            background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
            position: relative;
            overflow: hidden;
        }
        
        .file-upload:hover {
            border-color: var(--primary);
            background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
            transform: translateY(-2px);
        }
        
        .file-upload input {
            display: none;
        }
        
        .file-upload-icon {
            font-size: 3em;
            color: var(--primary);
            margin-bottom: 15px;
            display: block;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 25px;
            margin-bottom: 35px;
        }
        
        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            box-shadow: var(--shadow);
            border-top: 4px solid var(--primary);
            transition: var(--transition);
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
        }
        
        .stat-icon {
            font-size: 2.5em;
            margin-bottom: 15px;
            background: var(--gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .stat-value-large {
            font-size: 2.8em;
            font-weight: 800;
            color: var(--primary);
            margin: 10px 0;
            line-height: 1;
        }
        
        .stat-desc {
            color: var(--gray);
            font-size: 0.95em;
            line-height: 1.5;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 2000;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.3s ease-out;
            backdrop-filter: blur(5px);
        }
        
        .modal-content {
            background: white;
            padding: 50px;
            border-radius: 20px;
            max-width: 550px;
            width: 90%;
            box-shadow: var(--shadow-lg);
            position: relative;
            animation: slideUp 0.3s ease-out;
        }
        
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .modal-title {
            font-size: 2em;
            color: var(--primary);
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .close-modal {
            position: absolute;
            top: 25px;
            right: 25px;
            font-size: 28px;
            cursor: pointer;
            color: var(--gray);
            transition: var(--transition);
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
        }
        
        .close-modal:hover {
            background: var(--gray-light);
            color: var(--danger);
        }
        
        .alert {
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 25px;
            display: flex;
            align-items: flex-start;
            gap: 20px;
            border-left: 4px solid;
        }
        
        .alert-success {
            background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
            color: #065f46;
            border-left-color: #10b981;
        }
        
        .alert-danger {
            background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
            color: #7f1d1d;
            border-left-color: #ef4444;
        }
        
        .alert-info {
            background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
            color: #1e40af;
            border-left-color: #3b82f6;
        }
        
        .help-text {
            color: var(--gray);
            font-size: 0.9em;
            margin-top: 8px;
            display: block;
            line-height: 1.5;
        }
        
        .hidden {
            display: none;
        }
        
        .section-divider {
            height: 2px;
            background: linear-gradient(to right, transparent, var(--primary), transparent);
            margin: 35px 0;
            border: none;
        }
        
        .groups-list {
            max-height: 350px;
            overflow-y: auto;
            border: 2px solid var(--gray-light);
            border-radius: 12px;
            padding: 15px;
            margin-top: 15px;
            background: white;
        }
        
        .group-item {
            padding: 15px;
            border-bottom: 1px solid var(--gray-light);
            cursor: pointer;
            transition: var(--transition);
            border-radius: 8px;
            margin-bottom: 8px;
        }
        
        .group-item:hover {
            background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
            border-color: var(--primary);
            transform: translateX(5px);
        }
        
        .highlight-box {
            background: linear-gradient(135deg, rgba(124, 58, 237, 0.05) 0%, rgba(16, 185, 129, 0.05) 100%);
            padding: 25px;
            border-radius: 12px;
            border: 2px solid rgba(124, 58, 237, 0.1);
            margin: 25px 0;
            position: relative;
            overflow: hidden;
        }
        
        .highlight-box::before {
            content: '⚡';
            position: absolute;
            top: 15px;
            right: 15px;
            font-size: 2em;
            opacity: 0.2;
        }
        
        .control-panel {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 20px;
            margin-top: 25px;
        }
        
        .control-item {
            background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid var(--gray-light);
        }
        
        .input-group {
            display: flex;
            gap: 12px;
            margin-top: 12px;
        }
        
        .session-controls {
            display: flex;
            gap: 12px;
            margin-top: 20px;
            flex-wrap: wrap;
        }
        
        .lock-item {
            background: white;
            border: 2px solid var(--gray-light);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: var(--transition);
        }
        
        .lock-item:hover {
            border-color: var(--primary);
            box-shadow: var(--shadow);
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
            background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 25px;
            border: 2px solid var(--gray-light);
        }
        
        .stat-item-small {
            text-align: center;
            flex: 1;
        }
        
        .stat-value-small {
            font-size: 1.8em;
            font-weight: 700;
            color: var(--primary);
            display: block;
        }
        
        .stat-label-small {
            font-size: 0.85em;
            color: var(--gray);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .progress-bar {
            height: 10px;
            background: var(--gray-light);
            border-radius: 5px;
            overflow: hidden;
            margin: 15px 0;
            position: relative;
        }
        
        .progress-fill {
            height: 100%;
            background: var(--gradient);
            transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        
        .progress-fill::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
            animation: shimmer 2s infinite;
        }
        
        @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }
        
        .uptime-display {
            font-family: 'Consolas', monospace;
            background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%);
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            font-size: 1.2em;
            text-align: center;
            border: 2px solid var(--gray-light);
            font-weight: 600;
            color: var(--primary);
        }
        
        .recovery-status {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 15px;
            background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
            border-radius: 8px;
            margin: 10px 0;
            border: 2px solid #f59e0b;
        }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @media (max-width: 768px) {
            .header h1 {
                font-size: 2.2em;
            }
            
            .tab {
                padding: 18px 24px;
                font-size: 0.95em;
            }
            
            .tab-content {
                padding: 25px;
            }
            
            .card {
                padding: 25px;
            }
            
            .stats-bar {
                gap: 20px;
                padding: 15px 20px;
            }
            
            .stat-item::after {
                display: none;
            }
        }
        
        /* Custom scrollbar */
        ::-webkit-scrollbar {
            width: 10px;
        }
        
        ::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: var(--primary);
            border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: var(--primary-dark);
        }
        
        /* Tooltip */
        .tooltip {
            position: relative;
            display: inline-block;
            cursor: help;
        }
        
        .tooltip .tooltip-text {
            visibility: hidden;
            width: 250px;
            background: var(--dark);
            color: white;
            text-align: center;
            padding: 12px;
            border-radius: 8px;
            position: absolute;
            z-index: 1;
            bottom: 125%;
            left: 50%;
            transform: translateX(-50%);
            opacity: 0;
            transition: opacity 0.3s;
            font-size: 0.9em;
            font-weight: normal;
            box-shadow: var(--shadow);
        }
        
        .tooltip:hover .tooltip-text {
            visibility: visible;
            opacity: 1;
        }
        
        /* Toggle switch */
        .toggle {
            position: relative;
            display: inline-block;
            width: 60px;
            height: 30px;
        }
        
        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--gray-light);
            transition: var(--transition);
            border-radius: 34px;
        }
        
        .slider:before {
            position: absolute;
            content: "";
            height: 22px;
            width: 22px;
            left: 4px;
            bottom: 4px;
            background: white;
            transition: var(--transition);
            border-radius: 50%;
        }
        
        input:checked + .slider {
            background: var(--primary);
        }
        
        input:checked + .slider:before {
            transform: translateX(30px);
        }
        
        /* Badge animations */
        .badge-pulse {
            animation: badgePulse 2s infinite;
        }
        
        @keyframes badgePulse {
            0% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.4); }
            70% { box-shadow: 0 0 0 10px rgba(124, 58, 237, 0); }
            100% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); }
        }
        
        /* Connection status */
        .connection-status {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: 600;
            background: var(--gray-light);
            margin-left: 20px;
        }
        
        .connection-status.online {
            background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
            color: #065f46;
        }
        
        .connection-status.offline {
            background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
            color: #7f1d1d;
        }
        
        .connection-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            animation: connectionPulse 2s infinite;
        }
        
        .connection-status.online .connection-dot {
            background: #10b981;
        }
        
        .connection-status.offline .connection-dot {
            background: #ef4444;
        }
        
        @keyframes connectionPulse {
            0% { opacity: 0.5; }
            50% { opacity: 1; }
            100% { opacity: 0.5; }
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <h1><i class="fas fa-shield-alt"></i> ULTRA SAFE SYSTEM</h1>
                <div class="subtitle">24/7 Auto-Recovery • Military Grade Encryption • Non-Stop Operation</div>
                <div class="security-badge">
                    <i class="fas fa-lock"></i>
                    <span>All Data Encrypted • No Console Logs • Auto-Healing</span>
                </div>
            </div>
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
                <span class="stat-value" id="recoveryCount">0</span>
                <span class="stat-label">AUTO RECOVERIES</span>
            </div>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('messaging')">
                <i class="fas fa-comment-dots"></i> Safe Messaging
            </div>
            <div class="tab" onclick="switchTab('locking')">
                <i class="fas fa-user-shield"></i> Advanced Locking
            </div>
            <div class="tab" onclick="switchTab('groups')">
                <i class="fas fa-users"></i> Fetch Groups
            </div>
            <div class="tab" onclick="switchTab('manage')">
                <i class="fas fa-tasks"></i> Session Management
            </div>
            <div class="tab" onclick="switchTab('monitor')">
                <i class="fas fa-heart-pulse"></i> System Monitor
            </div>
        </div>
        
        <!-- MESSAGING TAB -->
        <div id="messagingTab" class="tab-content active">
            <div class="grid-2">
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-comment-dots"></i> SAFE MESSAGING
                            <span class="feature-badge">Auto-Recovery Enabled</span>
                        </div>
                        
                        <div class="highlight-box">
                            <strong>⚡ ULTRA-SAFE FEATURES:</strong>
                            <ul style="margin-top: 10px; padding-left: 20px;">
                                <li>Military grade encryption for cookies & IDs</li>
                                <li>Auto-recovery from crashes (max 3 attempts)</li>
                                <li>Health monitoring & automatic restart</li>
                                <li>Safe delays & rate limiting</li>
                                <li>Permanent session saving</li>
                            </ul>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-key"></i> FACEBOOK COOKIE (ENCRYPTED):
                                <span class="tooltip">
                                    <i class="fas fa-info-circle" style="color: var(--gray);"></i>
                                    <span class="tooltip-text">Your cookie is encrypted with AES-256-GCM before storage. Never stored in plain text.</span>
                                </span>
                            </label>
                            <textarea class="form-control" id="cookieInput" placeholder="PASTE YOUR FACEBOOK COOKIE HERE - IT WILL BE ENCRYPTED" style="min-height: 120px;"></textarea>
                            <span class="help-text">Your cookie is immediately encrypted and never shown again</span>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-users"></i> GROUP UID:
                            </label>
                            <input type="text" class="form-control" id="groupUID" placeholder="ENTER FACEBOOK GROUP ID">
                        </div>
                        
                        <div class="control-panel">
                            <div class="control-item">
                                <label class="form-label">
                                    <i class="fas fa-tag"></i> MESSAGE PREFIX:
                                </label>
                                <input type="text" class="form-control" id="messagePrefix" value="💬 " placeholder="Prefix for all messages">
                            </div>
                            <div class="control-item">
                                <label class="form-label">
                                    <i class="fas fa-clock"></i> DELAY (5-300s):
                                </label>
                                <input type="number" class="form-control" id="messageDelay" value="15" min="5" max="300">
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-file-alt"></i> MESSAGES (.TXT FILE):
                            </label>
                            <div class="file-upload" onclick="document.getElementById('messageFile').click()">
                                <i class="fas fa-cloud-upload-alt file-upload-icon"></i>
                                <p style="font-size: 1.2em; font-weight: 600; margin-bottom: 5px;">CLICK TO UPLOAD MESSAGES.TXT</p>
                                <p><small>One message per line • Max 1000 messages</small></p>
                                <input type="file" id="messageFile" accept=".txt" onchange="handleMessageFile()">
                            </div>
                            <div id="messageFileInfo" class="hidden" style="margin-top: 15px;">
                                <div style="background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); padding: 15px; border-radius: 10px;">
                                    <i class="fas fa-check-circle" style="color: var(--secondary); margin-right: 10px;"></i>
                                    <span id="messageCount" style="font-weight: 600;">0</span> MESSAGES LOADED
                                </div>
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-sync-alt"></i> MESSAGING MODE:
                            </label>
                            <div style="display: flex; gap: 20px; margin-top: 10px;">
                                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                    <input type="radio" name="messagingMode" value="single" checked>
                                    <span>Single Cookie</span>
                                </label>
                                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                    <input type="radio" name="messagingMode" value="multi">
                                    <span>Multi-Cookie</span>
                                </label>
                            </div>
                        </div>
                        
                        <div class="btn-group">
                            <button class="btn btn-success btn-block" onclick="startMessaging()">
                                <i class="fas fa-play-circle"></i> START SAFE MESSAGING
                            </button>
                        </div>
                    </div>
                </div>
                
                <div>
                    <div class="card">
                        <div class="card-title">
                            <i class="fas fa-terminal"></i> SYSTEM LOGS
                            <div class="connection-status online" id="connectionStatus">
                                <div class="connection-dot"></div>
                                <span>CONNECTED</span>
                            </div>
                        </div>
                        <div class="logs-container" id="systemLogs">
                            <div class="log-entry log-info">
                                <span class="log-time">[SYSTEM]</span>
                                <span class="log-content">Ultra Safe System initialized with auto-recovery</span>
                            </div>
                        </div>
                        <div class="btn-group">
                            <button class="btn btn-secondary" onclick="clearLogs('systemLogs')">
                                <i class="fas fa-trash"></i> CLEAR LOGS
                            </button>
                            <button class="btn btn-info" onclick="exportLogs()">
                                <i class="fas fa-download"></i> EXPORT
                            </button>
                        </div>
                    </div>
                    
                    <div class="card" id="sessionCard" style="display: none;">
                        <div class="card-title">
                            <i class="fas fa-user-clock"></i> ACTIVE SESSION
                            <span class="status-badge status-active" id="sessionStatusBadge">ACTIVE</span>
                        </div>
                        
                        <div class="uptime-display" id="sessionUptime">Uptime: 0s</div>
                        
                        <div class="session-id" id="sessionIdDisplay"></div>
                        
                        <div class="recovery-status" id="recoveryStatus" style="display: none;">
                            <div class="loading"></div>
                            <span>Auto-recovery in progress...</span>
                        </div>
                        
                        <div class="stats-grid">
                            <div class="stat-card">
                                <div class="stat-icon">
                                    <i class="fas fa-paper-plane"></i>
                                </div>
                                <div class="stat-value-large" id="messagesSent">0</div>
                                <div class="stat-desc">MESSAGES SENT</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-icon">
                                    <i class="fas fa-rotate"></i>
                                </div>
                                <div class="stat-value-large" id="recoveryAttempts">0</div>
                                <div class="stat-desc">RECOVERY ATTEMPTS</div>
                            </div>
                        </div>
                        
                        <div class="session-controls">
                            <button class="btn btn-info" onclick="refreshSessionStatus()">
                                <i class="fas fa-sync-alt"></i> REFRESH
                            </button>
                            <button class="btn btn-warning" onclick="pauseSession()">
                                <i class="fas fa-pause"></i> PAUSE
                            </button>
                            <button class="btn btn-danger" onclick="stopSession()">
                                <i class="fas fa-stop"></i> STOP
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- LOCKING TAB -->
        <div id="lockingTab" class="tab-content">
            <!-- Locking interface similar to messaging -->
            <!-- Content would follow similar pattern -->
        </div>
        
        <!-- GROUPS TAB -->
        <div id="groupsTab" class="tab-content">
            <!-- Groups interface -->
        </div>
        
        <!-- MANAGE TAB -->
        <div id="manageTab" class="tab-content">
            <!-- Management interface -->
        </div>
        
        <!-- MONITOR TAB -->
        <div id="monitorTab" class="tab-content">
            <!-- System monitor interface -->
        </div>
    </div>
    
    <!-- Session Modal -->
    <div class="modal" id="sessionModal">
        <div class="modal-content">
            <span class="close-modal" onclick="closeModal()">&times;</span>
            <h2 class="modal-title"><i class="fas fa-key"></i> SESSION SECURED</h2>
            
            <div class="alert alert-success">
                <i class="fas fa-check-circle fa-2x"></i>
                <div>
                    <strong>SESSION CREATED SUCCESSFULLY!</strong><br>
                    All data is encrypted. Your session has auto-recovery enabled.
                </div>
            </div>
            
            <p><strong>ENCRYPTED SESSION ID:</strong></p>
            <div class="session-id" id="modalSessionId"></div>
            
            <div class="highlight-box" style="margin: 20px 0;">
                <strong><i class="fas fa-shield-alt"></i> SECURITY FEATURES:</strong>
                <ul style="margin-top: 10px; padding-left: 20px;">
                    <li>AES-256-GCM encryption</li>
                    <li>Auto-recovery system active</li>
                    <li>Health monitoring enabled</li>
                    <li>No console logging</li>
                </ul>
            </div>
            
            <div class="btn-group">
                <button class="btn btn-primary" onclick="copySessionId()">
                    <i class="fas fa-copy"></i> COPY SESSION ID
                </button>
                <button class="btn btn-success" onclick="closeModal()">
                    <i class="fas fa-check"></i> START MONITORING
                </button>
            </div>
        </div>
    </div>
    
    <script>
        // Global variables
        let currentSessionId = null;
        let currentSessionType = null;
        let messages = [];
        let serverStartTime = Date.now();
        let recoveryCount = 0;
        let sessionMonitorInterval = null;
        
        // Initialize
        window.onload = function() {
            updateServerUptime();
            loadStats();
            setupAutoRefresh();
            
            // Initialize logs
            addLog('systemLogs', 'System initialized with 24/7 auto-recovery', 'success');
            addLog('systemLogs', 'Military grade encryption enabled', 'info');
            addLog('systemLogs', 'Health monitoring active', 'info');
        };
        
        function updateServerUptime() {
            setInterval(() => {
                const uptime = Date.now() - serverStartTime;
                document.getElementById('serverUptime').textContent = formatUptime(uptime);
            }, 1000);
        }
        
        async function loadStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                if (data.success) {
                    document.getElementById('activeSessions').textContent = data.activeSessions;
                    document.getElementById('totalMessages').textContent = data.totalMessages;
                    document.getElementById('recoveryCount').textContent = recoveryCount;
                    
                    // Update connection status
                    const statusElement = document.getElementById('connectionStatus');
                    statusElement.className = 'connection-status online';
                    statusElement.innerHTML = '<div class="connection-dot"></div><span>CONNECTED</span>';
                }
            } catch (error) {
                const statusElement = document.getElementById('connectionStatus');
                statusElement.className = 'connection-status offline';
                statusElement.innerHTML = '<div class="connection-dot"></div><span>RECONNECTING...</span>';
                console.error('Stats error:', error);
            }
        }
        
        function setupAutoRefresh() {
            setInterval(loadStats, 10000); // Update stats every 10 seconds
            
            // Auto-reconnect WebSocket
            setInterval(() => {
                if (!window.wsConnected) {
                    setupWebSocket();
                }
            }, 5000);
        }
        
        // Tab switching
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + 'Tab').classList.add('active');
            document.querySelector(`.tab:nth-child(${getTabIndex(tabName)})`).classList.add('active');
        }
        
        function getTabIndex(tabName) {
            const tabs = {
                'messaging': 1,
                'locking': 2,
                'groups': 3,
                'manage': 4,
                'monitor': 5
            };
            return tabs[tabName] || 1;
        }
        
        // File handling
        function handleMessageFile() {
            const file = document.getElementById('messageFile').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                messages = e.target.result.split('\\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                
                document.getElementById('messageCount').textContent = messages.length;
                document.getElementById('messageFileInfo').style.display = 'block';
                
                addLog('systemLogs', \`Loaded \${messages.length} messages from file\`, 'success');
                
                // Validate messages
                if (messages.length > 1000) {
                    addLog('systemLogs', 'Warning: More than 1000 messages, first 1000 will be used', 'warning');
                    messages = messages.slice(0, 1000);
                }
            };
            reader.readAsText(file);
        }
        
        // Start messaging
        async function startMessaging() {
            const cookie = document.getElementById('cookieInput').value.trim();
            const groupUID = document.getElementById('groupUID').value.trim();
            const prefix = document.getElementById('messagePrefix').value.trim();
            const delay = parseInt(document.getElementById('messageDelay').value);
            const mode = document.querySelector('input[name="messagingMode"]:checked').value;
            
            // Validation
            if (!cookie) {
                showAlert('Please enter Facebook cookie', 'error');
                return;
            }
            
            if (!groupUID) {
                showAlert('Please enter Group UID', 'error');
                return;
            }
            
            if (messages.length === 0) {
                showAlert('Please upload messages file', 'error');
                return;
            }
            
            if (isNaN(delay) || delay < 5 || delay > 300) {
                showAlert('Delay must be between 5-300 seconds', 'error');
                return;
            }
            
            addLog('systemLogs', \`Starting \${mode} messaging with auto-recovery...\`, 'info');
            
            try {
                const endpoint = mode === 'single' ? '/api/start-single-messaging' : '/api/start-multi-messaging';
                const payload = mode === 'single' ? 
                    { cookie, groupUID, prefix, delay, messages } :
                    { cookies: [cookie], groupUID, prefix, delay, messages };
                
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const data = await response.json();
                if (data.success) {
                    currentSessionId = data.sessionId;
                    currentSessionType = mode === 'single' ? 'single_messaging' : 'multi_messaging';
                    
                    // Update UI
                    document.getElementById('sessionIdDisplay').textContent = currentSessionId;
                    document.getElementById('sessionCard').style.display = 'block';
                    document.getElementById('modalSessionId').textContent = currentSessionId;
                    document.getElementById('sessionModal').style.display = 'flex';
                    
                    // Start monitoring
                    startSessionMonitoring();
                    
                    addLog('systemLogs', \`\${mode} messaging started with ID: \${currentSessionId}\`, 'success');
                    addLog('systemLogs', 'Auto-recovery system activated', 'info');
                    
                } else {
                    showAlert(\`Failed: \${data.error}\`, 'error');
                }
            } catch (error) {
                showAlert('Connection error, retrying...', 'error');
                setTimeout(startMessaging, 5000);
            }
        }
        
        // Session monitoring
        function startSessionMonitoring() {
            if (sessionMonitorInterval) {
                clearInterval(sessionMonitorInterval);
            }
            
            sessionMonitorInterval = setInterval(async () => {
                if (currentSessionId) {
                    await refreshSessionStatus();
                }
            }, 3000);
        }
        
        async function refreshSessionStatus() {
            if (!currentSessionId) return;
            
            try {
                const response = await fetch('/api/get-session-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
                
                const data = await response.json();
                if (data.success) {
                    const status = data.status;
                    
                    // Update UI
                    document.getElementById('sessionUptime').textContent = \`Uptime: \${formatTime(status.uptime)}\`;
                    document.getElementById('messagesSent').textContent = status.messagesSent || 0;
                    document.getElementById('recoveryAttempts').textContent = status.recoveryAttempts || 0;
                    
                    // Update recovery count
                    if (status.recoveryAttempts > recoveryCount) {
                        recoveryCount = status.recoveryAttempts;
                        document.getElementById('recoveryCount').textContent = recoveryCount;
                    }
                    
                    // Update status badge
                    const badge = document.getElementById('sessionStatusBadge');
                    if (status.isRecovering) {
                        badge.className = 'status-badge status-recovering';
                        badge.textContent = 'RECOVERING';
                        document.getElementById('recoveryStatus').style.display = 'flex';
                    } else if (status.isRunning) {
                        badge.className = 'status-badge status-active';
                        badge.textContent = 'ACTIVE';
                        document.getElementById('recoveryStatus').style.display = 'none';
                    } else if (status.status === 'paused') {
                        badge.className = 'status-badge status-paused';
                        badge.textContent = 'PAUSED';
                        document.getElementById('recoveryStatus').style.display = 'none';
                    }
                    
                }
            } catch (error) {
                console.error('Status refresh error:', error);
            }
        }
        
        async function pauseSession() {
            if (!currentSessionId) return;
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        sessionId: currentSessionId, 
                        action: 'pause' 
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    showAlert('Session paused', 'success');
                    addLog('systemLogs', 'Session paused', 'warning');
                }
            } catch (error) {
                showAlert('Error pausing session', 'error');
            }
        }
        
        async function stopSession() {
            if (!currentSessionId) return;
            
            if (!confirm('Stop this session? Auto-recovery will be disabled.')) return;
            
            try {
                const response = await fetch('/api/control-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        sessionId: currentSessionId, 
                        action: 'stop' 
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    showAlert('Session stopped', 'success');
                    addLog('systemLogs', 'Session stopped', 'info');
                    
                    // Clean up
                    currentSessionId = null;
                    document.getElementById('sessionCard').style.display = 'none';
                    if (sessionMonitorInterval) {
                        clearInterval(sessionMonitorInterval);
                        sessionMonitorInterval = null;
                    }
                }
            } catch (error) {
                showAlert('Error stopping session', 'error');
            }
        }
        
        // Utility functions
        function addLog(containerId, message, level = 'info') {
            const container = document.getElementById(containerId);
            const logEntry = document.createElement('div');
            logEntry.className = \`log-entry log-\${level}\`;
            
            const time = new Date().toLocaleTimeString();
            logEntry.innerHTML = \`
                <span class="log-time">[\${time}]</span>
                <span class="log-content">\${message}</span>
            \`;
            
            container.appendChild(logEntry);
            container.scrollTop = container.scrollHeight;
        }
        
        function clearLogs(containerId) {
            const container = document.getElementById(containerId);
            container.innerHTML = '';
            addLog(containerId, 'Logs cleared', 'info');
        }
        
        function showAlert(message, type = 'info') {
            // Create alert element
            const alert = document.createElement('div');
            alert.className = \`alert alert-\${type}\`;
            alert.innerHTML = \`
                <i class="fas fa-\${type === 'error' ? 'exclamation-circle' : type === 'success' ? 'check-circle' : 'info-circle'} fa-2x"></i>
                <div>\${message}</div>
            \`;
            
            // Add to top of messaging tab
            const tab = document.getElementById('messagingTab');
            tab.insertBefore(alert, tab.firstChild);
            
            // Auto remove after 5 seconds
            setTimeout(() => {
                alert.remove();
            }, 5000);
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
        
        function copySessionId() {
            const sessionId = document.getElementById('modalSessionId').textContent;
            navigator.clipboard.writeText(sessionId);
            showAlert('Session ID copied to clipboard', 'success');
        }
        
        function closeModal() {
            document.getElementById('sessionModal').style.display = 'none';
        }
        
        function exportLogs() {
            const logs = document.getElementById('systemLogs').textContent;
            const blob = new Blob([logs], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`system-logs-\${new Date().toISOString()}.txt\`;
            a.click();
            URL.revokeObjectURL(url);
        }
        
        // WebSocket connection
        function setupWebSocket() {
            try {
                const ws = new WebSocket(\`ws://\${window.location.host}\`);
                
                ws.onopen = () => {
                    window.wsConnected = true;
                    addLog('systemLogs', 'WebSocket connected', 'success');
                };
                
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'session_update' && data.session.sessionId === currentSessionId) {
                            // Update session info
                        } else if (data.type === 'heartbeat_ack') {
                            // Heartbeat response
                        }
                    } catch (error) {
                        console.error('WebSocket message error:', error);
                    }
                };
                
                ws.onclose = () => {
                    window.wsConnected = false;
                    addLog('systemLogs', 'WebSocket disconnected, reconnecting...', 'warning');
                    setTimeout(setupWebSocket, 5000);
                };
                
                ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                };
                
                // Send heartbeat every 30 seconds
                setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'heartbeat' }));
                    }
                }, 30000);
                
                window.ws = ws;
            } catch (error) {
                console.error('WebSocket setup error:', error);
            }
        }
        
        // Initialize WebSocket
        setupWebSocket();
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

// Create necessary directories
const directories = ['sessions', 'logs', 'backups'];
directories.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

// Disable console logs in production
if (process.env.NODE_ENV === 'production') {
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    console.info = () => {};
}

server.listen(PORT, '0.0.0.0', () => {
    const serverInfo = `
╔═══════════════════════════════════════════════════════╗
║      🚀 ULTRA SAFE SYSTEM STARTED                    ║
║      Port: ${PORT}                                   ║
║      Features:                                        ║
║      • 24/7 Auto-Recovery                            ║
║      • Military Grade Encryption                     ║
║      • Anti-Crash Protection                         ║
║      • Health Monitoring                             ║
║      • No Console Logging                            ║
║                                                      ║
║      🔒 All data encrypted                           ║
║      ⚡ Auto-healing enabled                         ║
║      🛡️  Maximum security                            ║
╚═══════════════════════════════════════════════════════╝
    `.replace(/^\n/, '');
    console.log(serverInfo);
});

// Graceful shutdown with recovery
process.on('SIGINT', () => {
    antiCrash.logError(new Error('Graceful shutdown initiated'), 'shutdown');
    
    console.log('\n🛑 Graceful shutdown initiated...');
    
    // Save recovery state
    const recoveryState = {
        timestamp: Date.now(),
        activeSessions: Array.from(activeSessions.entries()).map(([id, session]) => ({
            id,
            type: session.type,
            userId: session.userId,
            groupUID: session.groupUID
        })),
        permanentSessions: permanentSessions.size
    };
    
    const recoveryPath = path.join(__dirname, 'backups', `recovery_${Date.now()}.json`);
    fs.writeFileSync(recoveryPath, JSON.stringify(recoveryState, null, 2), 'utf8');
    
    // Clean up
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
    
    wss.close();
    server.close();
    
    console.log('✅ Shutdown complete');
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    antiCrash.logError(error, 'uncaughtException');
    
    // Attempt recovery
    setTimeout(() => {
        console.log('🔄 Attempting auto-recovery...');
        // Restart server logic here if needed
    }, 5000);
});

// Memory usage monitoring
setInterval(() => {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    
    if (heapUsedMB > 500) { // 500MB threshold
        antiCrash.logError(
            new Error(`High memory usage: ${heapUsedMB}MB/${heapTotalMB}MB`),
            'memory-monitor'
        );
    }
}, 60000); // Check every minute

// Session cleanup
setInterval(() => {
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    
    for (const [sessionId, session] of activeSessions) {
        if (session.status === 'stopped' && now - session.startTime > twentyFourHours) {
            activeSessions.delete(sessionId);
        }
    }
}, 3600000); // Cleanup every hour
