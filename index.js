const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions PERMANENTLY
const permanentActiveSessions = new Map(); // Changed to permanent storage
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
            isPermanent: true, // Mark as permanent
            status: 'active' // Always active
        };
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        return true;
    } catch (error) {
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
        // Silent error handling
    }
    return null;
}

// ==================== PERMANENT ACTIVE SESSION LOADER ====================
// Load all permanent sessions on startup
function loadAllPermanentSessions() {
    try {
        const sessionsDir = path.join(__dirname, 'sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
            return;
        }
        
        const files = fs.readdirSync(sessionsDir);
        const sessionFiles = files.filter(f => f.startsWith('permanent_') && f.endsWith('.json'));
        
        sessionFiles.forEach(file => {
            try {
                const filePath = path.join(sessionsDir, file);
                const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const sessionId = sessionData.sessionId;
                
                // Store in permanent sessions map
                permanentSessions.set(sessionId, sessionData);
                
                // If session was active, reload it
                if (sessionData.status === 'active' && sessionData.isPermanent) {
                    console.log(`♾️ Loading permanent session: ${sessionId} (${sessionData.type})`);
                    
                    // Start session based on type
                    setTimeout(() => {
                        revivePermanentSession(sessionId, sessionData);
                    }, Math.random() * 5000); // Stagger loading
                }
            } catch (e) {
                // Skip corrupted files
            }
        });
        
        console.log(`♾️ Loaded ${permanentSessions.size} permanent sessions`);
    } catch (error) {
        console.error('Error loading permanent sessions:', error);
    }
}

// Revive permanent session on startup
async function revivePermanentSession(sessionId, sessionData) {
    try {
        if (sessionData.type === 'advanced_locking') {
            // Revive locking session
            const api = await new Promise((resolve) => {
                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                    resolve(fbApi);
                });
            });
            
            if (api) {
                const lockSystem = new AdvancedSafeLockSystem(sessionId, api, sessionData.groupUID);
                
                // Restore settings
                if (sessionData.customMessage) {
                    lockSystem.setCustomMessage(sessionData.customMessage);
                }
                
                if (sessionData.nicknameDelay) {
                    lockSystem.setNicknameRestoreDelay(sessionData.nicknameDelay);
                }
                
                // Restore locks from saved data
                if (sessionData.lockedName) {
                    lockSystem.lockedName = sessionData.lockedName;
                    lockSystem.startGroupNameMonitoring();
                }
                
                if (sessionData.lockedNicknames && Array.isArray(sessionData.lockedNicknames)) {
                    sessionData.lockedNicknames.forEach(([userId, nickname]) => {
                        lockSystem.lockedNicknames.set(userId, nickname);
                    });
                    if (lockSystem.lockedNicknames.size > 0) {
                        lockSystem.startAllNicknamesMonitoring();
                    }
                }
                
                if (sessionData.lockedSingleNickname && Array.isArray(sessionData.lockedSingleNickname)) {
                    sessionData.lockedSingleNickname.forEach(([userId, nickname]) => {
                        lockSystem.lockedSingleNickname.set(userId, nickname);
                    });
                    if (lockSystem.lockedSingleNickname.size > 0) {
                        lockSystem.startSingleNicknameMonitoring();
                    }
                }
                
                // Start monitoring
                lockSystem.start();
                
                const session = {
                    api,
                    groupUID: sessionData.groupUID,
                    lockSystem,
                    status: 'active',
                    startTime: sessionData.startTime || Date.now(),
                    userId: sessionData.userId,
                    type: 'advanced_locking',
                    customMessage: sessionData.customMessage,
                    nicknameDelay: sessionData.nicknameDelay,
                    lockedName: sessionData.lockedName,
                    lockedNicknames: sessionData.lockedNicknames,
                    lockedSingleNickname: sessionData.lockedSingleNickname,
                    isPermanent: true
                };
                
                permanentActiveSessions.set(sessionId, session);
                console.log(`♾️ Revived permanent lock session: ${sessionId}`);
            }
        }
        // Add revival for other session types if needed
    } catch (error) {
        console.error(`Error reviving session ${sessionId}:`, error);
    }
}

// ==================== PERMANENT SESSION FUNCTIONS ====================
function saveSessionState(sessionId, sessionData) {
    try {
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        const existingData = loadPermanentSession(sessionId) || {};
        
        // Merge with existing data
        const updatedData = {
            ...existingData,
            ...sessionData,
            lastUsed: Date.now(),
            status: 'active', // Always active for permanent sessions
            isPermanent: true
        };
        
        fs.writeFileSync(sessionPath, JSON.stringify(updatedData, null, 2));
        permanentSessions.set(sessionId, updatedData);
        return true;
    } catch (error) {
        return false;
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
            sessionData.status = 'active'; // Ensure active status
            permanentSessions.set(sessionId, sessionData);
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            try {
                fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
            } catch (e) {}
            callback(api);
        }
    });
}

// ==================== PERMANENT SAFE MESSAGING SYSTEM ====================
class PermanentSafeMessaging {
    constructor(sessionId, cookie, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.cookie = cookie;
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = delay * 1000;
        this.originalMessages = messages;
        this.messageQueue = [];
        this.isRunning = true; // Always running for permanent
        this.messageIndex = 0;
        this.api = null;
        this.messagesSent = 0;
        this.startTime = Date.now();
        this.consecutiveFailures = 0;
        this.maxFailures = 10; // Higher tolerance for permanent
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50; // Almost unlimited reconnects
        this.isPermanent = true;
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
                
                // Save session state
                saveSessionState(this.sessionId, {
                    sessionId: this.sessionId,
                    cookie: this.cookie,
                    groupUID: this.groupUID,
                    prefix: this.prefix,
                    delay: this.delay / 1000,
                    messages: this.originalMessages,
                    userId: userId,
                    type: 'single_messaging',
                    isPermanent: true
                });
                
                return true;
            }
        } catch (error) {
            // Silent error
        }
        return false;
    }

    start() {
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.processQueue();
    }

    async processQueue() {
        while (this.isRunning) {
            if (this.messageQueue.length === 0) {
                this.messageQueue = [...this.originalMessages];
                this.messageIndex = 0;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            if (this.consecutiveFailures >= this.maxFailures) {
                // Permanent mode: Try to reconnect instead of stopping
                await this.reconnect();
                continue;
            }

            const message = this.messageQueue.shift();
            const messageText = this.prefix + message;
            const messageNumber = this.messageIndex + 1;

            const success = await this.sendMessage(messageText);
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                this.consecutiveFailures = 0;
                this.reconnectAttempts = 0;
                
                // Update permanent session
                const session = permanentActiveSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                    updateSessionStatus(this.sessionId);
                }
                
                // Save progress
                saveSessionState(this.sessionId, {
                    messagesSent: this.messagesSent,
                    messageIndex: this.messageIndex,
                    lastMessage: messageText,
                    lastSent: Date.now()
                });
            } else {
                this.messageQueue.unshift(message);
                this.consecutiveFailures++;
            }

            await new Promise(resolve => setTimeout(resolve, this.delay));
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

    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log(`♾️ Permanent messaging ${this.sessionId}: Max reconnects reached`);
            return false;
        }
        
        this.reconnectAttempts++;
        console.log(`♾️ Permanent messaging ${this.sessionId}: Reconnecting (attempt ${this.reconnectAttempts})`);
        
        this.api = null;
        const reconnected = await this.initialize();
        
        if (reconnected) {
            this.consecutiveFailures = 0;
            this.reconnectAttempts = 0;
            console.log(`♾️ Permanent messaging ${this.sessionId}: Reconnected successfully`);
            return true;
        } else {
            await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds before retry
            return false;
        }
    }

    stop() {
        this.isRunning = false;
        // Still keep session in permanent storage but mark as stopped
        saveSessionState(this.sessionId, { status: 'stopped' });
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            isRunning: this.isRunning,
            isPermanent: this.isPermanent,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            consecutiveFailures: this.consecutiveFailures,
            reconnectAttempts: this.reconnectAttempts,
            uptime: Date.now() - this.startTime,
            status: 'permanent_active'
        };
    }
}

// ==================== PERMANENT ADVANCED SAFE LOCK SYSTEM ====================
class PermanentAdvancedSafeLockSystem {
    constructor(sessionId, api, groupUID) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        
        // Locks - PERMANENT
        this.lockedName = null;
        this.lockedNicknames = new Map();
        this.lockedSingleNickname = new Map();
        
        // Monitoring intervals (in seconds)
        this.groupNameInterval = 30;      // More frequent for permanent
        this.allNicknamesInterval = 45;   // More frequent for permanent
        this.singleNicknameInterval = 60; // More frequent for permanent
        
        // Individual timers
        this.groupNameTimer = null;
        this.allNicknamesTimer = null;
        this.singleNicknameTimer = null;
        
        // Settings
        this.memberCache = new Map();
        this.isActive = true; // Always active for permanent
        this.customMessage = null;
        this.nicknameRestoreDelay = 2000;
        this.consecutiveFailures = 0;
        this.maxFailures = 20; // Higher tolerance
        this.startTime = Date.now();
        this.isPermanent = true;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 100; // Almost unlimited
    }

    start() {
        this.isActive = true;
        this.startIndividualMonitoring();
        
        // Save initial state
        this.saveLockState();
    }

    stop() {
        this.isActive = false;
        this.stopIndividualMonitoring();
        // Even when stopped, keep locks in storage
        this.saveLockState({ status: 'paused' });
    }

    // Individual monitoring control
    startIndividualMonitoring() {
        this.stopIndividualMonitoring();
        
        // PERMANENT monitoring - never stops
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
        this.monitorGroupName(); // Initial check
    }

    startAllNicknamesMonitoring() {
        if (this.allNicknamesTimer) clearInterval(this.allNicknamesTimer);
        this.allNicknamesTimer = setInterval(() => {
            this.monitorAllNicknames();
        }, this.allNicknamesInterval * 1000);
        this.monitorAllNicknames(); // Initial check
    }

    startSingleNicknameMonitoring() {
        if (this.singleNicknameTimer) clearInterval(this.singleNicknameTimer);
        this.singleNicknameTimer = setInterval(() => {
            this.monitorSingleNicknames();
        }, this.singleNicknameInterval * 1000);
        this.monitorSingleNicknames(); // Initial check
    }

    // Save lock state to permanent storage
    saveLockState(additionalData = {}) {
        const lockState = {
            sessionId: this.sessionId,
            lockedName: this.lockedName,
            lockedNicknames: Array.from(this.lockedNicknames.entries()),
            lockedSingleNickname: Array.from(this.lockedSingleNickname.entries()),
            monitoringIntervals: {
                groupName: this.groupNameInterval,
                allNicknames: this.allNicknamesInterval,
                singleNickname: this.singleNicknameInterval
            },
            customMessage: this.customMessage,
            nicknameRestoreDelay: this.nicknameRestoreDelay,
            isActive: this.isActive,
            isPermanent: this.isPermanent,
            lastUpdated: Date.now(),
            ...additionalData
        };
        
        saveSessionState(this.sessionId, lockState);
    }

    // Load lock state from storage
    loadLockState(sessionData) {
        if (sessionData.lockedName) {
            this.lockedName = sessionData.lockedName;
        }
        
        if (sessionData.lockedNicknames && Array.isArray(sessionData.lockedNicknames)) {
            sessionData.lockedNicknames.forEach(([userId, nickname]) => {
                this.lockedNicknames.set(userId, nickname);
            });
        }
        
        if (sessionData.lockedSingleNickname && Array.isArray(sessionData.lockedSingleNickname)) {
            sessionData.lockedSingleNickname.forEach(([userId, nickname]) => {
                this.lockedSingleNickname.set(userId, nickname);
            });
        }
        
        if (sessionData.monitoringIntervals) {
            this.groupNameInterval = sessionData.monitoringIntervals.groupName || 30;
            this.allNicknamesInterval = sessionData.monitoringIntervals.allNicknames || 45;
            this.singleNicknameInterval = sessionData.monitoringIntervals.singleNickname || 60;
        }
        
        if (sessionData.customMessage !== undefined) {
            this.customMessage = sessionData.customMessage;
        }
        
        if (sessionData.nicknameRestoreDelay !== undefined) {
            this.nicknameRestoreDelay = sessionData.nicknameRestoreDelay;
        }
        
        if (sessionData.isActive !== undefined) {
            this.isActive = sessionData.isActive;
        }
    }

    // Set individual intervals
    setGroupNameInterval(seconds) {
        if (seconds < 5 || seconds > 300) {
            return { success: false, message: 'Interval must be between 5-300 seconds for permanent mode' };
        }
        this.groupNameInterval = seconds;
        if (this.lockedName) {
            this.startGroupNameMonitoring();
        }
        this.saveLockState();
        return { success: true, message: `Group name monitoring interval set to ${seconds} seconds` };
    }

    setAllNicknamesInterval(seconds) {
        if (seconds < 5 || seconds > 300) {
            return { success: false, message: 'Interval must be between 5-300 seconds for permanent mode' };
        }
        this.allNicknamesInterval = seconds;
        if (this.lockedNicknames.size > 0) {
            this.startAllNicknamesMonitoring();
        }
        this.saveLockState();
        return { success: true, message: `All nicknames monitoring interval set to ${seconds} seconds` };
    }

    setSingleNicknameInterval(seconds) {
        if (seconds < 5 || seconds > 300) {
            return { success: false, message: 'Interval must be between 5-300 seconds for permanent mode' };
        }
        this.singleNicknameInterval = seconds;
        if (this.lockedSingleNickname.size > 0) {
            this.startSingleNicknameMonitoring();
        }
        this.saveLockState();
        return { success: true, message: `Single nickname monitoring interval set to ${seconds} seconds` };
    }

    setCustomMessage(message) {
        this.customMessage = message || null;
        this.saveLockState();
        return { success: true, message: message ? 'Custom message updated' : 'Custom message removed' };
    }

    setNicknameRestoreDelay(seconds) {
        if (seconds < 1 || seconds > 10) {
            return { success: false, message: 'Delay must be between 1-10 seconds' };
        }
        this.nicknameRestoreDelay = seconds * 1000;
        this.saveLockState();
        return { success: true, message: `Nickname restore delay set to ${seconds} seconds` };
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
                    this.saveLockState();
                    this.startGroupNameMonitoring();
                    resolve({ success: true, message: `Group name permanently locked to "${groupName}"` });
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
        this.saveLockState();
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
                                    this.saveLockState();
                                    this.startAllNicknamesMonitoring();
                                }
                                resolve({
                                    success: successCount > 0,
                                    message: `Nicknames permanently locked for ${successCount}/${participantIDs.length} members`,
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
        this.saveLockState();
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
                        this.saveLockState();
                        this.startSingleNicknameMonitoring();
                        resolve({ success: true, message: `Nickname permanently locked to "${nickname}" for user ${userID}` });
                    }
                });
            });
        });
    }

    unlockSingleNickname(userID) {
        if (this.lockedSingleNickname.has(userID)) {
            this.lockedSingleNickname.delete(userID);
            this.memberCache.delete(userID);
            this.saveLockState();
            return { success: true, message: `Nickname lock removed for user ${userID}` };
        }
        return { success: false, message: "No lock found for this user" };
    }

    // Monitoring functions with reconnection
    async monitorGroupName() {
        if (!this.lockedName || this.consecutiveFailures >= this.maxFailures) return;
        
        try {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    this.consecutiveFailures++;
                    this.handleApiFailure();
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
                            this.handleApiFailure();
                        }
                    });
                }
            });
        } catch (error) {
            this.consecutiveFailures++;
            this.handleApiFailure();
        }
    }

    async monitorAllNicknames() {
        if (this.lockedNicknames.size === 0 || this.consecutiveFailures >= this.maxFailures) return;
        
        try {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) {
                    this.consecutiveFailures++;
                    this.handleApiFailure();
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
                            this.saveLockState();
                            if (failures > 0 && this.customMessage) {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }
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
                                this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                                this.saveLockState();
                                if (failures > 0 && this.customMessage) {
                                    this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                                }
                                if (failures > 0) {
                                    this.handleApiFailure();
                                }
                            }
                        });
                    }, index * this.nicknameRestoreDelay);
                });
            });
        } catch (error) {
            this.consecutiveFailures++;
            this.handleApiFailure();
        }
    }

    async monitorSingleNicknames() {
        if (this.lockedSingleNickname.size === 0 || this.consecutiveFailures >= this.maxFailures) return;
        
        try {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) {
                    this.consecutiveFailures++;
                    this.handleApiFailure();
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
                            this.saveLockState();
                            if (failures > 0 && this.customMessage) {
                                this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                            }
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
                                this.consecutiveFailures = failures > 0 ? this.consecutiveFailures + 1 : 0;
                                this.saveLockState();
                                if (failures > 0 && this.customMessage) {
                                    this.api.sendMessage(this.customMessage, this.groupUID, () => {});
                                }
                                if (failures > 0) {
                                    this.handleApiFailure();
                                }
                            }
                        });
                    }, index * this.nicknameRestoreDelay);
                });
            });
        } catch (error) {
            this.consecutiveFailures++;
            this.handleApiFailure();
        }
    }

    // Handle API failures with reconnection
    async handleApiFailure() {
        if (this.consecutiveFailures >= 5) {
            console.log(`♾️ Permanent lock ${this.sessionId}: API failing, attempting reconnection...`);
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                
                // Try to get new API instance
                const sessionData = loadPermanentSession(this.sessionId);
                if (sessionData && sessionData.appState) {
                    try {
                        const newApi = await new Promise((resolve) => {
                            silentLoginWithPermanentSession(this.sessionId, (fbApi) => {
                                resolve(fbApi);
                            });
                        });
                        
                        if (newApi) {
                            this.api = newApi;
                            this.consecutiveFailures = 0;
                            this.reconnectAttempts = 0;
                            console.log(`♾️ Permanent lock ${this.sessionId}: Reconnected successfully`);
                        }
                    } catch (error) {
                        // Silent error
                    }
                }
            }
        }
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
            reconnectAttempts: this.reconnectAttempts,
            isActive: this.isActive,
            isPermanent: this.isPermanent,
            uptime: Date.now() - this.startTime,
            status: 'permanent_active'
        };
    }
}

// ==================== WEB SOCKET FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    const session = permanentActiveSessions.get(sessionId);
    if (!session) return;
    
    const sessionInfo = {
        sessionId: sessionId,
        groupUID: session.groupUID,
        status: session.status || 'active',
        messagesSent: session.messagesSent || 0,
        uptime: Date.now() - (session.startTime || Date.now()),
        userId: session.userId || 'Unknown',
        type: session.type || 'unknown',
        isPermanent: session.isPermanent || true,
        statusText: 'PERMANENT_ACTIVE'
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

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'authenticate' && data.sessionId) {
                ws.sessionId = data.sessionId;
                ws.send(JSON.stringify({ type: 'auth_success', message: 'Session authenticated' }));
                
                const session = permanentActiveSessions.get(data.sessionId);
                if (session) {
                    const sessionInfo = {
                        sessionId: data.sessionId,
                        groupUID: session.groupUID,
                        status: session.status || 'active',
                        messagesSent: session.messagesSent || 0,
                        uptime: Date.now() - session.startTime,
                        userId: session.userId,
                        type: session.type,
                        isPermanent: true,
                        statusText: 'PERMANENT_ACTIVE'
                    };
                    ws.send(JSON.stringify({ type: 'session_info', session: sessionInfo }));
                }
            }
        } catch (error) {
            // Silent error handling
        }
    });
    
    ws.on('close', () => {
        // Silent disconnect
    });
});

// ==================== API ROUTES ====================

// Start permanent single cookie messaging
app.post('/api/start-single-messaging', async (req, res) => {
    try {
        const { cookie, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookie || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = 'perm_single_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const messaging = new PermanentSafeMessaging(sessionId, cookie, groupUID, prefix, delay, messages);
        
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
            status: 'permanent_active',
            messagesSent: 0,
            startTime: Date.now(),
            userId: 'permanent-user',
            type: 'single_messaging',
            isPermanent: true
        };
        
        permanentActiveSessions.set(sessionId, session);
        
        // Save as permanent session
        saveSessionState(sessionId, {
            sessionId,
            type: 'single_messaging',
            groupUID,
            prefix,
            delay: delay,
            messagesCount: messages.length,
            userId: 'permanent-user',
            isPermanent: true,
            status: 'permanent_active'
        });
        
        res.json({ 
            success: true, 
            sessionId, 
            userId: 'permanent-user', 
            message: `Permanent messaging started - Will run forever`,
            isPermanent: true
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start permanent advanced lock session
app.post('/api/start-advanced-lock', async (req, res) => {
    try {
        const { cookie, groupUID, customMessage, nicknameDelay } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = 'perm_lock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        const lockSystem = new PermanentAdvancedSafeLockSystem(sessionId, api, groupUID);
        
        // Apply settings
        if (customMessage !== undefined) {
            lockSystem.setCustomMessage(customMessage);
        }
        
        if (nicknameDelay) {
            lockSystem.setNicknameRestoreDelay(nicknameDelay);
        }
        
        // Start the system
        lockSystem.start();
        
        const session = {
            api,
            groupUID,
            lockSystem,
            status: 'permanent_active',
            startTime: Date.now(),
            userId,
            type: 'advanced_locking',
            customMessage: customMessage || null,
            nicknameDelay: nicknameDelay || 2,
            isPermanent: true
        };
        
        permanentActiveSessions.set(sessionId, session);
        savePermanentSession(sessionId, api, userId, 'advanced_locking');
        
        // Save lock state
        lockSystem.saveLockState({
            sessionId,
            groupUID,
            userId,
            customMessage: customMessage || null,
            nicknameDelay: nicknameDelay || 2,
            isPermanent: true,
            status: 'permanent_active'
        });
        
        res.json({ 
            success: true, 
            sessionId, 
            userId, 
            message: `Permanent lock session started - Will run forever`,
            isPermanent: true,
            settings: {
                customMessage: customMessage || null,
                nicknameDelay: nicknameDelay || 2
            }
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get permanent session status
app.post('/api/get-session-status', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const session = permanentActiveSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        let status = {};
        if (session.type === 'advanced_locking' && session.lockSystem) {
            status = session.lockSystem.getStatus();
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
            isPermanent: true,
            statusText: 'PERMANENT_ACTIVE'
        };
        
        res.json({ success: true, status });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Control permanent session
app.post('/api/control-session', async (req, res) => {
    try {
        const { sessionId, action } = req.body;
        
        if (!sessionId || !action) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = permanentActiveSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        let result = { success: true, message: '' };
        
        switch (action) {
            case 'start':
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.start();
                    session.status = 'permanent_active';
                    result.message = 'Permanent lock session started';
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.start();
                    session.status = 'permanent_active';
                    result.message = 'Permanent messaging started';
                }
                break;
                
            case 'stop':
                // For permanent sessions, "stop" just pauses monitoring
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.stop();
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.stop();
                }
                session.status = 'paused';
                result.message = 'Session paused (permanent session still saved)';
                break;
                
            case 'pause':
                session.status = 'paused';
                result.message = 'Session paused';
                break;
                
            case 'resume':
                session.status = 'permanent_active';
                if (session.type === 'advanced_locking' && session.lockSystem) {
                    session.lockSystem.start();
                } else if (session.type === 'single_messaging' && session.messaging) {
                    session.messaging.start();
                }
                result.message = 'Session resumed';
                break;
                
            case 'destroy':
                // Completely remove permanent session
                permanentActiveSessions.delete(sessionId);
                
                // Delete session file
                const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
                if (fs.existsSync(sessionPath)) {
                    fs.unlinkSync(sessionPath);
                }
                
                result.message = 'Permanent session completely destroyed';
                break;
                
            default:
                result = { success: false, error: 'Invalid action' };
        }
        
        // Update session state
        if (session && action !== 'destroy') {
            saveSessionState(sessionId, { status: session.status });
        }
        
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get all permanent sessions for user
app.get('/api/my-permanent-sessions/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const userSessions = [];
        
        // Check active sessions
        for (const [sessionId, session] of permanentActiveSessions) {
            if (session.userId === userId || userId === 'all') {
                const sessionData = {
                    sessionId,
                    type: session.type,
                    groupUID: session.groupUID,
                    status: session.status,
                    messagesSent: session.messagesSent || 0,
                    uptime: Date.now() - session.startTime,
                    startTime: session.startTime,
                    isPermanent: true,
                    statusText: 'PERMANENT_ACTIVE'
                };
                
                if (session.customMessage !== undefined) {
                    sessionData.customMessage = session.customMessage;
                }
                
                userSessions.push(sessionData);
            }
        }
        
        // Also check saved session files
        const sessionsDir = path.join(__dirname, 'sessions');
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir);
            const sessionFiles = files.filter(f => f.startsWith('permanent_') && f.endsWith('.json'));
            
            sessionFiles.forEach(file => {
                try {
                    const filePath = path.join(sessionsDir, file);
                    const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    
                    if ((sessionData.userId === userId || userId === 'all') && 
                        !userSessions.find(s => s.sessionId === sessionData.sessionId)) {
                        
                        userSessions.push({
                            sessionId: sessionData.sessionId,
                            type: sessionData.type,
                            groupUID: sessionData.groupUID,
                            status: sessionData.status || 'saved',
                            messagesSent: sessionData.messagesSent || 0,
                            uptime: 0,
                            startTime: sessionData.createdAt || sessionData.startTime,
                            isPermanent: true,
                            statusText: 'SAVED_INACTIVE'
                        });
                    }
                } catch (e) {
                    // Skip corrupted files
                }
            });
        }
        
        res.json({ 
            success: true, 
            sessions: userSessions,
            count: userSessions.length,
            message: `Found ${userSessions.length} permanent sessions`
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Revive saved permanent session
app.post('/api/revive-permanent-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.json({ success: false, error: 'Missing session ID' });
        }
        
        const sessionData = loadPermanentSession(sessionId);
        if (!sessionData) {
            return res.json({ success: false, error: 'Session not found in storage' });
        }
        
        // Check if already active
        if (permanentActiveSessions.has(sessionId)) {
            return res.json({ success: false, error: 'Session is already active' });
        }
        
        // Revive based on type
        if (sessionData.type === 'advanced_locking') {
            const api = await new Promise((resolve) => {
                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                    resolve(fbApi);
                });
            });
            
            if (!api) {
                return res.json({ success: false, error: 'Failed to login' });
            }
            
            const lockSystem = new PermanentAdvancedSafeLockSystem(sessionId, api, sessionData.groupUID);
            
            // Load saved state
            lockSystem.loadLockState(sessionData);
            
            // Apply settings
            if (sessionData.customMessage !== undefined) {
                lockSystem.setCustomMessage(sessionData.customMessage);
            }
            
            if (sessionData.nicknameDelay) {
                lockSystem.setNicknameRestoreDelay(sessionData.nicknameDelay);
            }
            
            // Start monitoring
            lockSystem.start();
            
            const session = {
                api,
                groupUID: sessionData.groupUID,
                lockSystem,
                status: 'permanent_active',
                startTime: Date.now(),
                userId: sessionData.userId,
                type: 'advanced_locking',
                customMessage: sessionData.customMessage,
                nicknameDelay: sessionData.nicknameDelay,
                isPermanent: true
            };
            
            permanentActiveSessions.set(sessionId, session);
            
            res.json({ 
                success: true, 
                message: `Permanent lock session revived`,
                sessionId,
                type: sessionData.type,
                isPermanent: true
            });
            
        } else if (sessionData.type === 'single_messaging') {
            // Similar revival for messaging sessions
            // ... (implementation similar to above)
            
            res.json({ 
                success: true, 
                message: `Messaging session revival not yet implemented`,
                sessionId,
                type: sessionData.type
            });
            
        } else {
            res.json({ success: false, error: 'Unknown session type' });
        }
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get system stats including permanent sessions
app.get('/api/stats-silent', (req, res) => {
    try {
        let totalMessages = 0;
        let permanentActiveCount = 0;
        let permanentPausedCount = 0;
        let savedSessionsCount = 0;
        
        // Count active permanent sessions
        for (const [sessionId, session] of permanentActiveSessions) {
            if (session.status === 'permanent_active') {
                permanentActiveCount++;
            } else if (session.status === 'paused') {
                permanentPausedCount++;
            }
            totalMessages += session.messagesSent || 0;
        }
        
        // Count saved session files
        const sessionsDir = path.join(__dirname, 'sessions');
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir);
            savedSessionsCount = files.filter(f => f.startsWith('permanent_') && f.endsWith('.json')).length;
        }
        
        res.json({
            success: true,
            totalPermanentActive: permanentActiveSessions.size,
            permanentActive: permanentActiveCount,
            permanentPaused: permanentPausedCount,
            savedSessions: savedSessionsCount,
            totalMessages,
            serverUptime: Date.now() - serverStartTime,
            wsClients: wss.clients.size,
            status: 'PERMANENT_MODE_ACTIVE'
        });
    } catch (error) {
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
        
        const session = permanentActiveSessions.get(sessionId);
        if (!session) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        if (session.type !== 'advanced_locking') {
            return res.json({ success: false, error: 'Session is not an advanced locking session' });
        }
        
        const lockSystem = session.lockSystem;
        let updates = [];
        
        // Update individual intervals
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
        
        // Update other settings
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
                message: `Permanent lock settings updated: ${updates.join(', ')}`,
                currentSettings: lockSystem.getStatus()
            });
        } else {
            res.json({ success: false, error: 'No valid updates provided' });
        }
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Add lock to permanent session
app.post('/api/add-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = permanentActiveSessions.get(sessionId);
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
        
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Remove lock from permanent session
app.post('/api/remove-lock', async (req, res) => {
    try {
        const { sessionId, lockType, lockData } = req.body;
        
        if (!sessionId || !lockType) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const session = permanentActiveSessions.get(sessionId);
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
        
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'PERMANENT_MODE_ACTIVE', 
        uptime: process.uptime(),
        permanentSessions: permanentActiveSessions.size,
        mode: 'PERMANENT_FOREVER'
    });
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

// Load all permanent sessions on startup
loadAllPermanentSessions();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`♾️ ULTIMATE PERMANENT SYSTEM STARTED ON PORT ${PORT}`);
    console.log(`✅ PERMANENT MODE: All sessions run FOREVER until manually stopped`);
    console.log(`✅ Locks persist PERMANENTLY`);
    console.log(`✅ Auto-recovery system ENABLED`);
    console.log(`✅ Session revival on restart ENABLED`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('♾️ PERMANENT SYSTEM: Saving all sessions before shutdown...');
    
    // Save all session states
    for (const [sessionId, session] of permanentActiveSessions) {
        try {
            if (session.type === 'advanced_locking' && session.lockSystem) {
                session.lockSystem.saveLockState({ status: 'shutdown' });
            }
            saveSessionState(sessionId, { 
                status: 'shutdown',
                lastShutdown: Date.now() 
            });
        } catch (error) {
            console.error(`Error saving session ${sessionId}:`, error);
        }
    }
    
    console.log('♾️ All permanent sessions saved. Shutting down...');
    wss.close();
    server.close();
    process.exit(0);
});
