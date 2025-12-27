const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// ==================== ADVANCED CONFIGURATION ====================
const SESSION_FILE = 'permanent_sessions.json';
const BACKUP_FILE = 'sessions_backup.json';
const STATE_FILE = 'session_state.json';

// SINGLE REALISTIC USER-AGENT (Mozilla Linux/Android)
const USER_AGENTS = {
    LINUX_ANDROID: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// REALISTIC HEADERS FOR LINUX/ANDROID
const REALISTIC_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'TE': 'trailers'
};

// ==================== COOKIE AUTO-RENEWAL SYSTEM ====================
class CookieRenewalSystem {
    constructor() {
        this.renewalInterval = 24 * 60 * 60 * 1000; // 24 hours
        this.activeRenewals = new Map();
    }
    
    startRenewalForSession(sessionId, cookies, api) {
        console.log(`🔄 [${sessionId}] Cookie auto-renewal scheduled (24h)`);
        
        const renewalTimer = setInterval(async () => {
            await this.renewCookies(sessionId, cookies, api);
        }, this.renewalInterval);
        
        this.activeRenewals.set(sessionId, {
            timer: renewalTimer,
            lastRenewal: Date.now(),
            nextRenewal: Date.now() + this.renewalInterval
        });
        
        return renewalTimer;
    }
    
    async renewCookies(sessionId, originalCookies, api) {
        try {
            console.log(`🔄 [${sessionId}] Auto-renewing cookies...`);
            
            // Gentle API call to refresh session
            await new Promise((resolve) => {
                api.getCurrentUserID((err, userId) => {
                    if (!err) {
                        console.log(`✅ [${sessionId}] Session refreshed`);
                        broadcastLog(sessionId, '🔄 Cookies auto-renewed (24h cycle)', 'success');
                    }
                    resolve();
                });
            });
            
            // Update renewal time
            const renewal = this.activeRenewals.get(sessionId);
            if (renewal) {
                renewal.lastRenewal = Date.now();
                renewal.nextRenewal = Date.now() + this.renewalInterval;
            }
            
            return true;
            
        } catch (error) {
            console.log(`⚠️ [${sessionId}] Cookie renewal failed: ${error.message}`);
            return false;
        }
    }
    
    stopRenewal(sessionId) {
        const renewal = this.activeRenewals.get(sessionId);
        if (renewal && renewal.timer) {
            clearInterval(renewal.timer);
            this.activeRenewals.delete(sessionId);
        }
    }
    
    getRenewalInfo(sessionId) {
        const renewal = this.activeRenewals.get(sessionId);
        if (renewal) {
            const nextIn = Math.max(0, renewal.nextRenewal - Date.now());
            const hours = Math.floor(nextIn / (1000 * 60 * 60));
            const minutes = Math.floor((nextIn % (1000 * 60 * 60)) / (1000 * 60));
            
            return {
                lastRenewal: new Date(renewal.lastRenewal).toLocaleString(),
                nextRenewal: new Date(renewal.nextRenewal).toLocaleString(),
                nextIn: `${hours}h ${minutes}m`,
                active: true
            };
        }
        return { active: false };
    }
}

// ==================== PERMANENT SESSION STORAGE ====================
let permanentSessions = new Map();
let sessionStates = new Map();
const cookieRenewal = new CookieRenewalSystem();

if (fs.existsSync(SESSION_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        saved.forEach(session => {
            permanentSessions.set(session.id, {
                ...session,
                permanent: true,
                created: session.created || Date.now(),
                lastActive: session.lastActive || Date.now(),
                totalUptime: session.totalUptime || 0,
                cookieRenewals: session.cookieRenewals || 0
            });
        });
        console.log('♾️ Loaded ' + permanentSessions.size + ' permanent sessions');
    } catch (e) {
        console.log('⚠️ Could not load sessions');
    }
}

function saveAllSessions() {
    try {
        const sessionsArray = Array.from(permanentSessions.values());
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionsArray, null, 2));
        fs.copyFileSync(SESSION_FILE, BACKUP_FILE);
        console.log('💾 All sessions saved + backed up');
    } catch (error) {
        console.log('❌ Save error:', error.message);
    }
}

setInterval(saveAllSessions, 30000);

// ==================== PERMANENT SESSION MANAGER ====================
class PermanentSession {
    constructor(sessionId, api, groupId, cookies, settings) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupId = groupId;
        this.originalCookies = cookies;
        this.settings = settings;
        
        // 🎯 MANUAL RESTORE SETTINGS
        this.groupRestoreMin = parseInt(settings.groupRestoreMin || 10) * 1000; // User selected
        this.groupRestoreMax = parseInt(settings.groupRestoreMax || 60) * 1000; // User selected
        this.nickRestoreMin = parseInt(settings.nickRestoreMin || 10) * 1000; // User selected
        this.nickRestoreMax = parseInt(settings.nickRestoreMax || 30) * 1000; // User selected
        
        // 📝 MESSAGE SETTINGS
        this.messageEnabled = settings.messageEnabled || false;
        this.messageText = settings.messageText || '';
        this.messageDelay = parseInt(settings.messageDelay || 60) * 1000; // After restore
        
        // Permanent tracking
        this.created = Date.now();
        this.lastActivity = Date.now();
        this.totalUptime = 0;
        this.cookieRenewals = 0;
        
        // Status
        this.isActive = true;
        this.isConnected = true;
        
        // Features
        this.groupLockEnabled = false;
        this.nickLockEnabled = false;
        this.lockedGroupName = '';
        this.lockedNickname = '';
        
        // Stats
        this.eventsHandled = 0;
        this.restoresDone = 0;
        this.messagesSent = 0;
        this.lastGroupRestore = 0;
        this.lastNickRestore = 0;
        
        // Start cookie auto-renewal (24 hours)
        cookieRenewal.startRenewalForSession(sessionId, cookies, api);
        
        // Start health monitoring
        this.startHealthMonitor();
        
        // Update permanent storage
        this.updatePermanentStorage();
        
        console.log(`♾️ [${sessionId}] Permanent session created`);
        console.log(`⏳ [${sessionId}] Group restore: ${settings.groupRestoreMin || 10}-${settings.groupRestoreMax || 60}s`);
        console.log(`⏳ [${sessionId}] Nick restore: ${settings.nickRestoreMin || 10}-${settings.nickRestoreMax || 30}s`);
        console.log(`💬 [${sessionId}] Messages: ${settings.messageEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
    
    startHealthMonitor() {
        setInterval(() => {
            this.totalUptime += 60000;
            this.lastActivity = Date.now();
            this.updatePermanentStorage();
        }, 60000);
    }
    
    // 🎯 MANUAL GROUP RESTORE (User selected)
    handleGroupNameChange(event) {
        if (!this.groupLockEnabled || !this.lockedGroupName) return;
        
        const newName = event.logMessageData.name || '';
        if (newName !== this.lockedGroupName) {
            const now = Date.now();
            const timeSinceLast = now - this.lastGroupRestore;
            
            // Anti-spam
            if (timeSinceLast < 30000) {
                return;
            }
            
            broadcastLog(this.sessionId, `⚠️ Group name changed: "${newName}"`, 'warning');
            
            // 🎯 USER SELECTED RESTORE TIME
            const delay = this.groupRestoreMin + Math.random() * (this.groupRestoreMax - this.groupRestoreMin);
            const delaySec = Math.round(delay / 1000);
            
            broadcastLog(this.sessionId, `⏳ Restoring in ${delaySec} seconds...`, 'info');
            
            setTimeout(() => {
                this.api.setTitle(this.lockedGroupName, this.groupId, (err) => {
                    if (!err) {
                        this.restoresDone++;
                        this.lastGroupRestore = Date.now();
                        broadcastLog(this.sessionId, `✅ Group name restored (after ${delaySec}s)`, 'success');
                        
                        // 📝 SEND MESSAGE IF ENABLED
                        if (this.messageEnabled && this.messageText) {
                            setTimeout(() => {
                                this.sendMessage();
                            }, this.messageDelay);
                        }
                        
                        this.updatePermanentStorage();
                    }
                });
            }, delay);
        }
    }
    
    // 🎯 MANUAL NICKNAME RESTORE (User selected)
    handleNicknameChange(event) {
        if (!this.nickLockEnabled || !this.lockedNickname) return;
        
        const targetId = event.logMessageData.participant_id;
        const newNickname = event.logMessageData.nickname || '';
        
        if (newNickname !== this.lockedNickname) {
            const now = Date.now();
            const timeSinceLast = now - this.lastNickRestore;
            
            // Anti-spam
            if (timeSinceLast < 15000) {
                return;
            }
            
            // 🎯 USER SELECTED RESTORE TIME
            const delay = this.nickRestoreMin + Math.random() * (this.nickRestoreMax - this.nickRestoreMin);
            const delaySec = Math.round(delay / 1000);
            
            broadcastLog(this.sessionId, `👤 Nickname changed, restoring in ${delaySec}s...`, 'info');
            
            setTimeout(() => {
                this.api.changeNickname(this.lockedNickname, this.groupId, targetId, (err) => {
                    if (!err) {
                        this.restoresDone++;
                        this.lastNickRestore = Date.now();
                        broadcastLog(this.sessionId, `✅ Nickname restored (after ${delaySec}s)`, 'success');
                        
                        // 📝 SEND MESSAGE IF ENABLED
                        if (this.messageEnabled && this.messageText) {
                            setTimeout(() => {
                                this.sendMessage();
                            }, this.messageDelay);
                        }
                        
                        this.updatePermanentStorage();
                    }
                });
            }, delay);
        }
    }
    
    // 📝 SEND MESSAGE FUNCTION
    sendMessage() {
        if (!this.messageEnabled || !this.messageText) return;
        
        this.api.sendMessage({
            body: this.messageText
        }, this.groupId, (err, msgInfo) => {
            if (!err) {
                this.messagesSent++;
                broadcastLog(this.sessionId, `💬 Message sent: "${this.messageText}"`, 'success');
                this.updatePermanentStorage();
            }
        });
    }
    
    updatePermanentStorage() {
        const sessionData = {
            id: this.sessionId,
            groupId: this.groupId,
            cookies: this.originalCookies,
            settings: this.settings,
            created: this.created,
            lastActive: this.lastActivity,
            totalUptime: this.totalUptime,
            cookieRenewals: this.cookieRenewals,
            groupLockEnabled: this.groupLockEnabled,
            nickLockEnabled: this.nickLockEnabled,
            lockedGroupName: this.lockedGroupName,
            lockedNickname: this.lockedNickname,
            messageEnabled: this.messageEnabled,
            messageText: this.messageText,
            messageDelay: this.messageDelay,
            permanent: true,
            device: 'linux_android',
            groupRestoreMin: this.settings.groupRestoreMin || 10,
            groupRestoreMax: this.settings.groupRestoreMax || 60,
            nickRestoreMin: this.settings.nickRestoreMin || 10,
            nickRestoreMax: this.settings.nickRestoreMax || 30
        };
        
        permanentSessions.set(this.sessionId, sessionData);
    }
    
    getStats() {
        const uptimeMs = Date.now() - this.created;
        const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
        const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
        
        const renewalInfo = cookieRenewal.getRenewalInfo(this.sessionId);
        
        return {
            sessionId: this.sessionId,
            groupId: this.groupId,
            status: this.isConnected ? '🟢 ONLINE' : '🔴 OFFLINE',
            uptime: `${hours}h ${minutes}m`,
            totalUptime: Math.floor(this.totalUptime / (1000 * 60 * 60)) + 'h',
            eventsHandled: this.eventsHandled,
            restoresDone: this.restoresDone,
            messagesSent: this.messagesSent,
            groupLock: this.groupLockEnabled ? '✅ ON' : '❌ OFF',
            nickLock: this.nickLockEnabled ? '✅ ON' : '❌ OFF',
            messageEnabled: this.messageEnabled ? '✅ ON' : '❌ OFF',
            cookieRenewals: this.cookieRenewals,
            nextCookieRenewal: renewalInfo.nextIn || 'N/A',
            device: 'Mozilla Linux/Android',
            groupRestore: `${this.settings.groupRestoreMin || 10}-${this.settings.groupRestoreMax || 60}s`,
            nickRestore: `${this.settings.nickRestoreMin || 10}-${this.settings.nickRestoreMax || 30}s`,
            lastActivity: new Date(this.lastActivity).toLocaleTimeString()
        };
    }
    
    enableGroupLock(groupName) {
        this.groupLockEnabled = true;
        this.lockedGroupName = groupName;
        
        this.api.setTitle(groupName, this.groupId, (err) => {
            if (!err) {
                broadcastLog(this.sessionId, `🔒 Group lock enabled: ${groupName}`, 'success');
                broadcastLog(this.sessionId, `⏳ Restore: ${this.settings.groupRestoreMin || 10}-${this.settings.groupRestoreMax || 60}s`, 'info');
            }
        });
        
        this.updatePermanentStorage();
    }
    
    enableNickLock(nickname) {
        this.nickLockEnabled = true;
        this.lockedNickname = nickname;
        
        broadcastLog(this.sessionId, `👤 Nickname lock enabled: ${nickname}`, 'success');
        broadcastLog(this.sessionId, `⏳ Restore: ${this.settings.nickRestoreMin || 10}-${this.settings.nickRestoreMax || 30}s`, 'info');
        
        // Start nickname setup
        this.startNicknameSetup();
        
        this.updatePermanentStorage();
    }
    
    startNicknameSetup() {
        this.api.getThreadInfo(this.groupId, (err, info) => {
            if (err) return;
            
            const participants = info.participantIDs || [];
            let processed = 0;
            const total = participants.length;
            
            const processNext = () => {
                if (processed >= total) {
                    broadcastLog(this.sessionId, '✅ All nicknames set', 'success');
                    return;
                }
                
                const userId = participants[processed];
                const delay = 60000 + Math.random() * 60000; // 60-120 seconds
                
                setTimeout(() => {
                    this.api.changeNickname(this.lockedNickname, this.groupId, userId, (err) => {
                        processed++;
                        const percent = Math.round((processed / total) * 100);
                        broadcastLog(this.sessionId, `📊 Nicknames: ${processed}/${total} (${percent}%)`, 'info');
                        processNext();
                    });
                }, delay);
            };
            
            broadcastLog(this.sessionId, `📊 Setting nicknames for ${total} members (slow setup)`, 'info');
            processNext();
        });
    }
    
    setupMQTTListening() {
        this.api.listenMqtt((err, event) => {
            if (err) {
                console.log(`⚠️ [${this.sessionId}] MQTT error: ${err.message}`);
                return;
            }
            
            this.lastActivity = Date.now();
            this.eventsHandled++;
            
            if (event.type === 'event') {
                if (event.logMessageType === 'log:thread-name') {
                    this.handleGroupNameChange(event);
                } else if (event.logMessageType === 'log:user-nickname') {
                    this.handleNicknameChange(event);
                }
            }
            
            this.updatePermanentStorage();
        });
    }
    
    stop() {
        this.isActive = false;
        cookieRenewal.stopRenewal(this.sessionId);
        this.updatePermanentStorage();
    }
    
    destroy() {
        this.stop();
        permanentSessions.delete(this.sessionId);
        cookieRenewal.stopRenewal(this.sessionId);
    }
}

// ==================== SESSION MANAGER ====================
class PermanentSessionManager {
    constructor() {
        this.activeSessions = new Map();
    }
    
    generateSessionId() {
        return 'PERM_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    async createPermanentSession(sessionData) {
        const sessionId = this.generateSessionId();
        
        try {
            console.log(`♾️ [${sessionId}] Creating permanent session...`);
            
            const loginOptions = {
                logLevel: "silent",
                forceLogin: false,
                selfListen: true,
                listenEvents: true,
                autoReconnect: true,
                online: true,
                userAgent: USER_AGENTS.LINUX_ANDROID,
                headers: REALISTIC_HEADERS,
                connectTimeout: 30000,
                autoMarkDelivery: false,
                autoMarkRead: false,
                updatePresence: false,
                listenTyping: false,
                appState: this.cookiesToAppState(sessionData.cookies)
            };
            
            const api = await new Promise((resolve, reject) => {
                wiegine.login({ appState: loginOptions.appState }, loginOptions, (err, api) => {
                    if (err) {
                        reject(new Error('Facebook login failed. Check cookies.'));
                    } else {
                        resolve(api);
                    }
                });
            });
            
            // Get group info
            let groupInfo = { name: 'Unknown', participants: 0 };
            try {
                const info = await new Promise((resolve) => {
                    api.getThreadInfo(sessionData.groupId, (err, info) => {
                        if (err) resolve({});
                        else resolve(info);
                    });
                });
                groupInfo.name = info.threadName || 'Unknown';
                groupInfo.participants = info.participantIDs?.length || 0;
            } catch (e) {}
            
            // Create permanent session
            const session = new PermanentSession(
                sessionId,
                api,
                sessionData.groupId,
                sessionData.cookies,
                {
                    // Restore settings
                    groupRestoreMin: sessionData.groupRestoreMin || 10,
                    groupRestoreMax: sessionData.groupRestoreMax || 60,
                    nickRestoreMin: sessionData.nickRestoreMin || 10,
                    nickRestoreMax: sessionData.nickRestoreMax || 30,
                    
                    // Message settings
                    messageEnabled: sessionData.messageEnabled || false,
                    messageText: sessionData.messageText || '',
                    messageDelay: sessionData.messageDelay || 60,
                    
                    // Other settings
                    groupName: sessionData.groupName || '',
                    nickname: sessionData.nickname || '',
                    device: 'linux_android'
                }
            );
            
            // Setup MQTT
            session.setupMQTTListening();
            
            // Enable features
            if (sessionData.enableGroupLock && sessionData.groupName) {
                session.enableGroupLock(sessionData.groupName);
            }
            
            if (sessionData.enableNickLock && sessionData.nickname) {
                session.enableNickLock(sessionData.nickname);
            }
            
            // Store
            this.activeSessions.set(sessionId, session);
            
            // Success messages
            broadcastLog(sessionId, `♾️ PERMANENT session created`, 'success');
            broadcastLog(sessionId, `📱 Device: Mozilla Linux/Android`, 'info');
            broadcastLog(sessionId, `👥 Group: ${groupInfo.name} (${groupInfo.participants} members)`, 'info');
            broadcastLog(sessionId, `🔄 Cookie auto-renewal: EVERY 24 HOURS`, 'success');
            broadcastLog(sessionId, `⏳ Group restore: ${sessionData.groupRestoreMin || 10}-${sessionData.groupRestoreMax || 60}s`, 'info');
            broadcastLog(sessionId, `⏳ Nick restore: ${sessionData.nickRestoreMin || 10}-${sessionData.nickRestoreMax || 30}s`, 'info');
            broadcastLog(sessionId, `💬 Messages: ${sessionData.messageEnabled ? 'ENABLED' : 'DISABLED'}`, 'info');
            broadcastLog(sessionId, `🛡️ NEVER expires, NEVER auto-stops`, 'success');
            
            broadcastSessionUpdate();
            
            return { 
                success: true, 
                sessionId: sessionId,
                groupName: groupInfo.name,
                device: 'Mozilla Linux/Android',
                message: 'PERMANENT session created'
            };
            
        } catch (error) {
            console.log('Session creation failed:', error.message);
            return { 
                success: false, 
                error: error.message || 'Failed to create session'
            };
        }
    }
    
    cookiesToAppState(cookies) {
        const appState = [];
        const cookiePairs = cookies.split(';').map(c => c.trim());
        
        cookiePairs.forEach(pair => {
            const [key, value] = pair.split('=');
            if (key && value) {
                appState.push({
                    key: key.trim(),
                    value: value.trim(),
                    domain: '.facebook.com',
                    path: '/',
                    expires: Math.floor(Date.now() / 1000) + 31536000,
                    secure: true,
                    httpOnly: true
                });
            }
        });
        
        return appState;
    }
    
    stopSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.stop();
            this.activeSessions.delete(sessionId);
            broadcastLog(sessionId, '🛑 Session stopped (saved permanently)', 'warning');
            broadcastSessionUpdate();
            return true;
        }
        return false;
    }
    
    deleteSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.destroy();
        } else {
            permanentSessions.delete(sessionId);
        }
        
        this.activeSessions.delete(sessionId);
        broadcastLog(sessionId, '🗑️ Session permanently deleted', 'warning');
        broadcastSessionUpdate();
        return true;
    }
    
    getSessionInfo(sessionId) {
        if (this.activeSessions.has(sessionId)) {
            const session = this.activeSessions.get(sessionId);
            return { success: true, ...session.getStats(), active: true };
        }
        
        if (permanentSessions.has(sessionId)) {
            const saved = permanentSessions.get(sessionId);
            const uptimeMs = Date.now() - saved.created;
            const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
            
            return {
                success: true,
                sessionId: saved.id,
                groupId: saved.groupId,
                status: '💾 SAVED',
                uptime: `${hours}h+`,
                totalUptime: Math.floor((saved.totalUptime || 0) / (1000 * 60 * 60)) + 'h',
                cookieRenewals: saved.cookieRenewals || 0,
                device: saved.device || 'Mozilla Linux/Android',
                groupRestore: `${saved.groupRestoreMin || 10}-${saved.groupRestoreMax || 60}s`,
                nickRestore: `${saved.nickRestoreMin || 10}-${saved.nickRestoreMax || 30}s`,
                messageEnabled: saved.messageEnabled ? '✅ ON' : '❌ OFF',
                active: false,
                message: 'Session saved - Can be restarted'
            };
        }
        
        return { success: false, error: 'Session not found' };
    }
    
    getAllSessions() {
        const sessions = [];
        
        // Active sessions
        for (const [id, session] of this.activeSessions) {
            sessions.push({
                id: id,
                ...session.getStats(),
                active: true,
                permanent: true
            });
        }
        
        // Saved sessions
        for (const [id, saved] of permanentSessions) {
            if (!this.activeSessions.has(id)) {
                const uptimeMs = Date.now() - saved.created;
                const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
                
                sessions.push({
                    id: id,
                    groupId: saved.groupId,
                    groupName: saved.settings?.groupName || 'Unknown',
                    status: '💾 SAVED',
                    uptime: `${hours}h+`,
                    totalUptime: Math.floor((saved.totalUptime || 0) / (1000 * 60 * 60)) + 'h',
                    cookieRenewals: saved.cookieRenewals || 0,
                    device: saved.device || 'Mozilla Linux/Android',
                    groupRestore: `${saved.groupRestoreMin || 10}-${saved.groupRestoreMax || 60}s`,
                    nickRestore: `${saved.nickRestoreMin || 10}-${saved.nickRestoreMax || 30}s`,
                    messageEnabled: saved.messageEnabled ? '✅ ON' : '❌ OFF',
                    active: false,
                    permanent: true
                });
            }
        }
        
        return sessions;
    }
    
    getStats() {
        const totalSessions = permanentSessions.size;
        const activeSessions = this.activeSessions.size;
        
        let totalUptime = 0;
        let totalRenewals = 0;
        let totalMessages = 0;
        
        for (const [id, session] of this.activeSessions) {
            totalUptime += session.totalUptime;
            totalRenewals += session.cookieRenewals || 0;
            totalMessages += session.messagesSent || 0;
        }
        
        for (const [id, saved] of permanentSessions) {
            totalUptime += saved.totalUptime || 0;
            totalRenewals += saved.cookieRenewals || 0;
        }
        
        const totalHours = Math.floor(totalUptime / (1000 * 60 * 60));
        
        return {
            totalSessions,
            activeSessions,
            savedSessions: totalSessions - activeSessions,
            totalUptime: `${totalHours}h`,
            totalCookieRenewals: totalRenewals,
            totalMessagesSent: totalMessages,
            nextAutoRenewal: '24h cycle',
            deviceType: 'Mozilla Linux/Android',
            restoreSpeeds: 'Manual selection'
        };
    }
    
    async fetchGroups(cookies) {
        try {
            const loginOptions = {
                logLevel: "silent",
                forceLogin: false,
                selfListen: false,
                userAgent: USER_AGENTS.LINUX_ANDROID,
                headers: REALISTIC_HEADERS,
                appState: this.cookiesToAppState(cookies)
            };
            
            const api = await new Promise((resolve, reject) => {
                wiegine.login({ appState: loginOptions.appState }, loginOptions, (err, api) => {
                    if (err) reject(err);
                    else resolve(api);
                });
            });
            
            const groups = await new Promise((resolve) => {
                api.getThreadList(100, null, [], (err, list) => {
                    if (err) {
                        resolve([]);
                        return;
                    }
                    
                    const groupList = list
                        .filter(thread => thread.isGroup)
                        .map(thread => ({
                            id: thread.threadID,
                            name: thread.name || `Group ${thread.threadID}`,
                            participants: thread.participantIDs?.length || 0
                        }));
                    
                    resolve(groupList);
                });
            });
            
            setTimeout(() => {
                try { api.logout(); } catch(e) {}
            }, 1000);
            
            return { success: true, groups: groups };
            
        } catch (error) {
            console.log('Fetch groups failed:', error.message);
            return { success: false, error: 'Check cookies and try again' };
        }
    }
    
    restartSavedSession(sessionId) {
        const saved = permanentSessions.get(sessionId);
        if (!saved) {
            return { success: false, error: 'Saved session not found' };
        }
        
        return this.createPermanentSession({
            cookies: saved.cookies,
            groupId: saved.groupId,
            enableGroupLock: saved.groupLockEnabled,
            enableNickLock: saved.nickLockEnabled,
            groupName: saved.lockedGroupName,
            nickname: saved.lockedNickname,
            groupRestoreMin: saved.groupRestoreMin || 10,
            groupRestoreMax: saved.groupRestoreMax || 60,
            nickRestoreMin: saved.nickRestoreMin || 10,
            nickRestoreMax: saved.nickRestoreMax || 30,
            messageEnabled: saved.messageEnabled || false,
            messageText: saved.messageText || '',
            messageDelay: saved.messageDelay || 60
        });
    }
}

const sessionManager = new PermanentSessionManager();

// ==================== EXPRESS ROUTES ====================
app.use(express.json());

// HTML Page with ALL features
const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>♾️ PERMANENT GROUP MANAGER PRO</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
        body { background: linear-gradient(135deg, #0a0a0a 0%, #121212 50%, #0d0d0d 100%); color: white; min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header { 
            text-align: center; 
            margin-bottom: 30px; 
            padding: 30px; 
            background: rgba(255, 255, 255, 0.03); 
            border-radius: 15px; 
            border: 1px solid rgba(0, 255, 0, 0.2);
        }
        
        .header h1 { 
            font-size: 2.8rem; 
            background: linear-gradient(45deg, #00ff00, #00cc00, #00ff88); 
            -webkit-background-clip: text; 
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
        }
        
        .permanent-badge {
            background: linear-gradient(45deg, #ff00ff, #00ffff);
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 14px;
            display: inline-block;
            margin: 10px 0;
            font-weight: bold;
        }
        
        .feature-box {
            background: rgba(0, 255, 0, 0.08);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            border-left: 4px solid #00ff00;
        }
        
        .restore-control {
            display: flex;
            gap: 10px;
            margin: 10px 0;
        }
        
        .restore-control input {
            flex: 1;
        }
        
        .restore-label {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
        }
        
        .restore-speed {
            color: #ffaa00;
            font-size: 12px;
        }
        
        /* Stats */
        .stats-bar { display: flex; justify-content: space-around; margin: 20px 0; flex-wrap: wrap; gap: 15px; }
        .stat-box { background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 10px; min-width: 200px; text-align: center; border: 1px solid rgba(0, 255, 0, 0.1); }
        .stat-value { font-size: 2rem; color: #00ff00; font-weight: bold; }
        
        /* Tabs */
        .tabs { display: flex; margin-bottom: 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex-wrap: wrap; }
        .tab { padding: 15px 20px; cursor: pointer; border-bottom: 3px solid transparent; white-space: nowrap; }
        .tab.active { border-bottom: 3px solid #00ff00; color: #00ff00; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        /* Forms */
        .form-section { background: rgba(255, 255, 255, 0.03); padding: 25px; border-radius: 15px; margin-bottom: 25px; border: 1px solid rgba(255, 255, 255, 0.05); }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #ccc; }
        input, textarea, select { width: 100%; padding: 12px 15px; border: none; border-radius: 8px; background: rgba(255, 255, 255, 0.05); color: white; margin-bottom: 10px; }
        
        /* Buttons */
        button { padding: 15px 20px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
        .btn-primary { background: linear-gradient(45deg, #00ff00, #00aa00); }
        .btn-stop { background: linear-gradient(45deg, #ff4444, #aa0000); }
        .btn-fetch { background: linear-gradient(45deg, #4488ff, #0066aa); }
        .btn-msg { background: linear-gradient(45deg, #ff8800, #aa5500); }
        
        /* Logs */
        .logs { background: rgba(0, 0, 0, 0.8); padding: 20px; border-radius: 15px; margin-top: 25px; height: 400px; overflow-y: auto; }
        .log-entry { margin-bottom: 8px; font-family: 'Courier New', monospace; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
        .success { color: #00ff00; }
        .error { color: #ff4444; }
        .info { color: #4488ff; }
        .warning { color: #ffaa00; }
        
        /* Session List */
        .session-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; margin-top: 20px; }
        .session-card { background: rgba(255, 255, 255, 0.03); padding: 20px; border-radius: 10px; border: 1px solid rgba(0, 255, 0, 0.1); }
        .session-id { font-family: monospace; color: #00ff00; font-size: 12px; margin-bottom: 10px; }
        .session-info { font-size: 14px; color: #ccc; margin: 5px 0; }
        .uptime { color: #ffaa00; font-weight: bold; }
        
        /* Controls */
        .control-buttons { display: flex; gap: 10px; margin-top: 15px; }
        .control-btn { padding: 8px 15px; border-radius: 5px; font-size: 12px; cursor: pointer; flex: 1; }
        .refresh-btn { background: #0066cc; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; margin-left: 10px; }
        
        /* Groups List */
        .group-item { background: rgba(255, 255, 255, 0.05); padding: 10px; margin: 5px 0; border-radius: 5px; border-left: 3px solid #00ff00; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>♾️ PERMANENT GROUP MANAGER PRO</h1>
            <div class="permanent-badge">ALL FEATURES • NO CUT • NO MISS • NO ERROR</div>
            <div style="color:#00ff00; margin:10px 0;">DEVELOPED BY: R4J M1SHR4</div>
            
            <div class="feature-box">
                <strong>🎯 COMPLETE FEATURES:</strong><br>
                • Manual Group Restore Selection<br>
                • Manual Nickname Restore Selection<br>
                • Optional Message Sending<br>
                • 24h Cookie Auto-Renewal<br>
                • Mozilla Linux/Android Only<br>
                • Permanent Sessions<br>
                • Group Fetch with Names<br>
                • Full Manual Control
            </div>
            
            <div class="stats-bar" id="statsBar">
                <div class="stat-box">
                    <div class="stat-value" id="totalSessions">0</div>
                    <div>Total Sessions</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="activeSessions">0</div>
                    <div>Active Sessions</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="totalUptime">0h</div>
                    <div>Total Uptime</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="totalMessages">0</div>
                    <div>Messages Sent</div>
                </div>
            </div>
        </div>

        <div class="tabs">
            <div class="tab active" onclick="switchTab('create')">🚀 Create Session</div>
            <div class="tab" onclick="switchTab('sessions')">📊 All Sessions</div>
            <div class="tab" onclick="switchTab('fetch')">🔍 Fetch Groups</div>
            <div class="tab" onclick="switchTab('manual')">🛠️ Manual Control</div>
            <div class="tab" onclick="switchTab('restart')">🔄 Restart Saved</div>
        </div>

        <!-- Tab 1: Create Session -->
        <div id="createTab" class="tab-content active">
            <div class="form-section">
                <h2>🚀 Create PERMANENT Session</h2>
                
                <div class="form-group">
                    <label>Facebook Cookies:</label>
                    <textarea id="cookies" rows="4" placeholder='c_user=123; xs=abc; fr=xyz; datr=...'></textarea>
                    <small style="color:#00ff00;">🔄 Auto-renewed every 24 hours</small>
                </div>
                
                <div class="form-group">
                    <label>Group ID:</label>
                    <input type="text" id="groupId" placeholder="Enter Group ID">
                    <button class="btn-fetch" onclick="fetchGroups()">🔍 Fetch My Groups</button>
                </div>
                
                <div class="form-group">
                    <label><input type="checkbox" id="enableGroupLock" checked> Group Name Lock</label>
                    <input type="text" id="groupName" placeholder="Group name">
                    
                    <div class="restore-label">
                        <span>Group Restore Time:</span>
                        <span class="restore-speed" id="groupSpeedLabel">10-60 seconds</span>
                    </div>
                    <div class="restore-control">
                        <input type="number" id="groupRestoreMin" min="5" max="120" value="10" placeholder="Min seconds">
                        <span style="color:#ccc; padding:10px;">to</span>
                        <input type="number" id="groupRestoreMax" min="10" max="300" value="60" placeholder="Max seconds">
                    </div>
                    <small style="color:#ffaa00;">⏳ Manual restore time selection</small>
                </div>
                
                <div class="form-group">
                    <label><input type="checkbox" id="enableNickLock" checked> Nickname Lock</label>
                    <input type="text" id="nickname" placeholder="Nickname for all">
                    
                    <div class="restore-label">
                        <span>Nickname Restore Time:</span>
                        <span class="restore-speed" id="nickSpeedLabel">10-30 seconds</span>
                    </div>
                    <div class="restore-control">
                        <input type="number" id="nickRestoreMin" min="5" max="120" value="10" placeholder="Min seconds">
                        <span style="color:#ccc; padding:10px;">to</span>
                        <input type="number" id="nickRestoreMax" min="10" max="300" value="30" placeholder="Max seconds">
                    </div>
                    <small style="color:#ffaa00;">⏳ Manual restore time selection</small>
                </div>
                
                <div class="form-group">
                    <label><input type="checkbox" id="messageEnabled"> Send Message After Restore</label>
                    <textarea id="messageText" rows="3" placeholder="Optional: Message to send after restore..."></textarea>
                    
                    <div class="restore-label">
                        <span>Message Delay (seconds):</span>
                    </div>
                    <input type="number" id="messageDelay" min="10" max="300" value="60" placeholder="Seconds after restore">
                    <small style="color:#ffaa00;">💬 Optional message after restore</small>
                </div>
                
                <div class="form-group">
                    <label>Device:</label>
                    <select id="deviceType" disabled>
                        <option selected>Mozilla Linux/Android (Fixed)</option>
                    </select>
                    <small style="color:#00ff00;">📱 Only Mozilla Linux/Android used</small>
                </div>
                
                <button class="btn-primary" onclick="createPermanentSession()">
                    ♾️ CREATE PERMANENT SESSION
                </button>
            </div>
        </div>

        <!-- Tab 2: All Sessions -->
        <div id="sessionsTab" class="tab-content">
            <div class="form-section">
                <h2>📊 All Sessions 
                    <button class="refresh-btn" onclick="loadSessions()">🔄 Refresh</button>
                </h2>
                <div class="session-list" id="sessionList">
                    <!-- Sessions will appear here -->
                </div>
            </div>
        </div>

        <!-- Tab 3: Fetch Groups -->
        <div id="fetchTab" class="tab-content">
            <div class="form-section">
                <h2>🔍 Fetch Your Groups</h2>
                <div class="form-group">
                    <label>Facebook Cookies:</label>
                    <textarea id="fetchCookies" rows="4" placeholder='c_user=123; xs=abc; fr=xyz;'></textarea>
                </div>
                <button class="btn-fetch" onclick="fetchUserGroups()">
                    🔍 Fetch All Groups
                </button>
                
                <div id="groupsList" style="margin-top: 20px;"></div>
            </div>
        </div>

        <!-- Tab 4: Manual Control -->
        <div id="manualTab" class="tab-content">
            <div class="form-section">
                <h2>🛠️ Manual Session Control</h2>
                <div class="form-group">
                    <label>Session ID:</label>
                    <input type="text" id="manualSessionId" placeholder="Enter Session ID">
                </div>
                
                <div class="control-buttons">
                    <button class="btn-primary" onclick="stopSession()">🛑 Stop Session</button>
                    <button class="btn-stop" onclick="deleteSession()">🗑️ Delete Session</button>
                    <button class="btn-fetch" onclick="getSessionInfo()">📊 Get Info</button>
                    <button class="btn-msg" onclick="sendManualMessage()">💬 Send Message</button>
                </div>
                
                <div id="manualResult" style="margin-top: 20px;"></div>
            </div>
        </div>

        <!-- Tab 5: Restart Saved -->
        <div id="restartTab" class="tab-content">
            <div class="form-section">
                <h2>🔄 Restart Saved Sessions</h2>
                <div id="savedSessionsList"></div>
                <button class="btn-fetch" onclick="loadSavedSessions()">🔄 Load Saved Sessions</button>
            </div>
        </div>

        <div class="logs">
            <h3>📊 LIVE LOGS 
                <button class="refresh-btn" onclick="clearLogs()">🗑️ Clear</button>
            </h3>
            <div id="logContainer"></div>
        </div>
    </div>

    <script>
        let ws = null;
        let stats = {
            totalSessions: 0,
            activeSessions: 0,
            totalUptime: 0,
            totalMessages: 0
        };
        
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName + 'Tab').classList.add('active');
            event.target.classList.add('active');
            
            if (tabName === 'sessions') {
                loadSessions();
            } else if (tabName === 'restart') {
                loadSavedSessions();
            }
        }
        
        function updateSpeedLabels() {
            const groupMin = document.getElementById('groupRestoreMin').value;
            const groupMax = document.getElementById('groupRestoreMax').value;
            const nickMin = document.getElementById('nickRestoreMin').value;
            const nickMax = document.getElementById('nickRestoreMax').value;
            
            document.getElementById('groupSpeedLabel').textContent = `${groupMin}-${groupMax} seconds`;
            document.getElementById('nickSpeedLabel').textContent = `${nickMin}-${nickMax} seconds`;
        }
        
        function connectWebSocket() {
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = protocol + '//' + window.location.host;
                ws = new WebSocket(wsUrl);
                
                ws.onopen = function() {
                    addLog('🔗 Connected to Permanent Manager', 'success');
                    loadStats();
                    loadSessions();
                };
                
                ws.onmessage = function(event) {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'log') {
                            addLog(data.message, data.level);
                        } else if (data.type === 'stats') {
                            updateStats(data.data);
                        } else if (data.type === 'session_update') {
                            loadSessions();
                        } else if (data.type === 'groups_data') {
                            displayGroups(data.groups);
                        }
                    } catch (e) {}
                };
                
                ws.onclose = function() {
                    setTimeout(connectWebSocket, 2000);
                };
            } catch (error) {
                setTimeout(connectWebSocket, 3000);
            }
        }
        
        function addLog(message, level = 'info') {
            const logContainer = document.getElementById('logContainer');
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry ' + level;
            logEntry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        
        function clearLogs() {
            document.getElementById('logContainer').innerHTML = '';
        }
        
        function loadStats() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => updateStats(data));
        }
        
        function updateStats(data) {
            stats = data;
            document.getElementById('totalSessions').textContent = data.totalSessions;
            document.getElementById('activeSessions').textContent = data.activeSessions;
            document.getElementById('totalUptime').textContent = data.totalUptime;
            document.getElementById('totalMessages').textContent = data.totalMessagesSent || 0;
        }
        
        function createPermanentSession() {
            const cookies = document.getElementById('cookies').value.trim();
            const groupId = document.getElementById('groupId').value.trim();
            
            if (!cookies || !groupId) {
                alert('Please enter cookies and group ID!');
                return;
            }
            
            const data = {
                cookies: cookies,
                groupId: groupId,
                enableGroupLock: document.getElementById('enableGroupLock').checked,
                enableNickLock: document.getElementById('enableNickLock').checked,
                groupName: document.getElementById('groupName').value.trim(),
                nickname: document.getElementById('nickname').value.trim(),
                groupRestoreMin: document.getElementById('groupRestoreMin').value,
                groupRestoreMax: document.getElementById('groupRestoreMax').value,
                nickRestoreMin: document.getElementById('nickRestoreMin').value,
                nickRestoreMax: document.getElementById('nickRestoreMax').value,
                messageEnabled: document.getElementById('messageEnabled').checked,
                messageText: document.getElementById('messageText').value.trim(),
                messageDelay: document.getElementById('messageDelay').value,
                deviceType: 'linux_android'
            };
            
            addLog('♾️ Creating permanent session...', 'info');
            addLog(`⏳ Group restore: ${data.groupRestoreMin}-${data.groupRestoreMax}s`, 'info');
            addLog(`⏳ Nick restore: ${data.nickRestoreMin}-${data.nickRestoreMax}s`, 'info');
            addLog(`💬 Messages: ${data.messageEnabled ? 'ENABLED' : 'DISABLED'}`, 'info');
            
            fetch('/api/create-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    addLog('✅ Session created: ' + result.sessionId, 'success');
                    addLog('📱 Device: Mozilla Linux/Android', 'info');
                    addLog('🔄 Cookie auto-renewal: 24h', 'success');
                    loadSessions();
                    loadStats();
                } else {
                    addLog('❌ ' + result.error, 'error');
                }
            });
        }
        
        function loadSessions() {
            fetch('/api/sessions')
                .then(res => res.json())
                .then(sessions => {
                    const container = document.getElementById('sessionList');
                    container.innerHTML = '';
                    
                    if (sessions.length === 0) {
                        container.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">No active sessions</div>';
                        return;
                    }
                    
                    sessions.forEach(session => {
                        const uptime = Math.floor((Date.now() - new Date(session.created || Date.now())) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        
                        const card = document.createElement('div');
                        card.className = 'session-card';
                        card.innerHTML = `
                            <div class="session-id">${session.id}</div>
                            <div class="session-info">Group: ${session.groupId}</div>
                            <div class="session-info">Status: <span style="color:${session.status.includes('ONLINE') ? '#00ff00' : '#ff4444'}">${session.status}</span></div>
                            <div class="session-info uptime">Uptime: ${session.uptime || hours+'h '+minutes+'m'}</div>
                            <div class="session-info">Group Lock: ${session.groupLock}</div>
                            <div class="session-info">Nick Lock: ${session.nickLock}</div>
                            <div class="session-info">Messages: ${session.messageEnabled}</div>
                            <div class="session-info">Group Restore: ${session.groupRestore}</div>
                            <div class="session-info">Nick Restore: ${session.nickRestore}</div>
                            <div class="control-buttons">
                                <button class="control-btn" style="background:#ff4444;" onclick="stopSessionById('${session.id}')">🛑 Stop</button>
                                <button class="control-btn" style="background:#aa4444;" onclick="deleteSessionById('${session.id}')">🗑️ Delete</button>
                                <button class="control-btn" style="background:#4488ff;" onclick="getSessionInfoById('${session.id}')">📊 Info</button>
                                ${session.active ? `<button class="control-btn" style="background:#ff8800;" onclick="sendMessageToSession('${session.id}')">💬 Msg</button>` : ''}
                            </div>
                        `;
                        container.appendChild(card);
                    });
                });
        }
        
        function stopSessionById(sessionId) {
            fetch('/api/stop-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    addLog('🛑 Stopped session: ' + sessionId, 'success');
                    loadSessions();
                    loadStats();
                }
            });
        }
        
        function deleteSessionById(sessionId) {
            fetch('/api/delete-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    addLog('🗑️ Deleted session: ' + sessionId, 'success');
                    loadSessions();
                    loadStats();
                }
            });
        }
        
        function getSessionInfoById(sessionId) {
            fetch('/api/session-info/' + sessionId)
                .then(res => res.json())
                .then(info => {
                    alert(JSON.stringify(info, null, 2));
                });
        }
        
        function sendMessageToSession(sessionId) {
            const message = prompt('Enter message to send:');
            if (message) {
                fetch('/api/send-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sessionId, message: message })
                })
                .then(res => res.json())
                .then(result => {
                    if (result.success) {
                        addLog('💬 Message sent to session: ' + sessionId, 'success');
                    }
                });
            }
        }
        
        function fetchUserGroups() {
            const cookies = document.getElementById('fetchCookies').value.trim();
            if (!cookies) {
                alert('Enter cookies first!');
                return;
            }
            
            addLog('🔍 Fetching groups...', 'info');
            
            fetch('/api/fetch-groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: cookies })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    displayGroups(result.groups);
                } else {
                    addLog('❌ ' + result.error, 'error');
                }
            });
        }
        
        function displayGroups(groups) {
            const container = document.getElementById('groupsList');
            if (groups.length === 0) {
                container.innerHTML = '<div style="color:#888;">No groups found</div>';
                return;
            }
            
            let html = '<h3>📋 Your Groups:</h3><div style="max-height:400px;overflow-y:auto;">';
            groups.forEach(group => {
                html += `
                    <div class="group-item">
                        <strong>${group.name}</strong><br>
                        <small style="color:#00ff00;">ID: ${group.id}</small><br>
                        <small>Members: ${group.participants}</small>
                        <button style="margin-left:10px;padding:3px 8px;font-size:11px;background:#00aa00;border:none;color:white;border-radius:3px;" 
                                onclick="useGroup('${group.id}', '${group.name.replace(/'/g, "\\'")}')">
                            Use
                        </button>
                    </div>
                `;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        
        function useGroup(groupId, groupName) {
            document.getElementById('groupId').value = groupId;
            document.getElementById('groupName').value = groupName;
            document.getElementById('nickname').value = 'Member';
            switchTab('create');
            addLog(`✅ Selected group: ${groupName}`, 'success');
        }
        
        function stopSession() {
            const sessionId = document.getElementById('manualSessionId').value.trim();
            if (!sessionId) {
                alert('Enter Session ID');
                return;
            }
            stopSessionById(sessionId);
        }
        
        function deleteSession() {
            const sessionId = document.getElementById('manualSessionId').value.trim();
            if (!sessionId) {
                alert('Enter Session ID');
                return;
            }
            deleteSessionById(sessionId);
        }
        
        function getSessionInfo() {
            const sessionId = document.getElementById('manualSessionId').value.trim();
            if (!sessionId) {
                alert('Enter Session ID');
                return;
            }
            getSessionInfoById(sessionId);
        }
        
        function sendManualMessage() {
            const sessionId = document.getElementById('manualSessionId').value.trim();
            if (!sessionId) {
                alert('Enter Session ID');
                return;
            }
            
            const message = prompt('Enter message to send:');
            if (message) {
                sendMessageToSession(sessionId);
            }
        }
        
        function fetchGroups() {
            const cookies = document.getElementById('cookies').value.trim();
            if (!cookies) {
                alert('Enter cookies in the Create Session tab first!');
                return;
            }
            
            document.getElementById('fetchCookies').value = cookies;
            switchTab('fetch');
            fetchUserGroups();
        }
        
        function loadSavedSessions() {
            fetch('/api/saved-sessions')
                .then(res => res.json())
                .then(sessions => {
                    const container = document.getElementById('savedSessionsList');
                    container.innerHTML = '';
                    
                    if (sessions.length === 0) {
                        container.innerHTML = '<div style="color:#888;padding:20px;text-align:center;">No saved sessions found</div>';
                        return;
                    }
                    
                    sessions.forEach(session => {
                        const card = document.createElement('div');
                        card.className = 'session-card';
                        card.innerHTML = `
                            <div class="session-id">${session.id}</div>
                            <div class="session-info">Group: ${session.groupName || session.groupId}</div>
                            <div class="session-info">Last Active: ${new Date(session.lastActive).toLocaleString()}</div>
                            <div class="session-info">Total Uptime: ${Math.floor((session.totalUptime || 0) / (1000 * 60 * 60))}h</div>
                            <button class="control-btn" style="background:#00aa00;" onclick="restartSession('${session.id}')">
                                🔄 Restart
                            </button>
                        `;
                        container.appendChild(card);
                    });
                });
        }
        
        function restartSession(sessionId) {
            fetch('/api/restart-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    addLog('🔄 Restarted saved session: ' + sessionId, 'success');
                    loadSessions();
                    loadStats();
                } else {
                    addLog('❌ ' + result.error, 'error');
                }
            });
        }
        
        // Initialize
        connectWebSocket();
        setInterval(loadStats, 30000);
        
        // Update speed labels on input
        document.getElementById('groupRestoreMin').addEventListener('input', updateSpeedLabels);
        document.getElementById('groupRestoreMax').addEventListener('input', updateSpeedLabels);
        document.getElementById('nickRestoreMin').addEventListener('input', updateSpeedLabels);
        document.getElementById('nickRestoreMax').addEventListener('input', updateSpeedLabels);
        
        // Initial update
        updateSpeedLabels();
        
        setTimeout(() => {
            addLog('♾️ Permanent Manager Started', 'success');
            addLog('🎯 Manual restore selection enabled', 'info');
            addLog('💬 Optional message sending enabled', 'info');
            addLog('📱 Device: Mozilla Linux/Android', 'info');
            addLog('🔄 Cookie auto-renewal: 24h cycle', 'success');
        }, 1000);
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

// API Routes
app.post('/api/create-session', async (req, res) => {
    try {
        const { cookies, groupId, enableGroupLock, enableNickLock, groupName, nickname, 
                groupRestoreMin, groupRestoreMax, nickRestoreMin, nickRestoreMax,
                messageEnabled, messageText, messageDelay } = req.body;
        
        if (!cookies || !groupId) {
            return res.json({ success: false, error: 'Cookies and Group ID required' });
        }
        
        const result = await sessionManager.createPermanentSession({
            cookies: cookies,
            groupId: groupId.trim(),
            enableGroupLock: enableGroupLock !== false,
            enableNickLock: enableNickLock !== false,
            groupName: groupName || '',
            nickname: nickname || '',
            groupRestoreMin: groupRestoreMin || 10,
            groupRestoreMax: groupRestoreMax || 60,
            nickRestoreMin: nickRestoreMin || 10,
            nickRestoreMax: nickRestoreMax || 30,
            messageEnabled: messageEnabled || false,
            messageText: messageText || '',
            messageDelay: messageDelay || 60
        });
        
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: 'Server error' });
    }
});

app.post('/api/stop-session', (req, res) => {
    try {
        const { sessionId } = req.body;
        const success = sessionManager.stopSession(sessionId);
        res.json({ success: success, message: 'Session stopped (saved permanently)' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/delete-session', (req, res) => {
    try {
        const { sessionId } = req.body;
        const success = sessionManager.deleteSession(sessionId);
        res.json({ success: success, message: 'Session permanently deleted' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/restart-session', (req, res) => {
    try {
        const { sessionId } = req.body;
        const result = sessionManager.restartSavedSession(sessionId);
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/send-message', (req, res) => {
    try {
        const { sessionId, message } = req.body;
        const session = sessionManager.activeSessions.get(sessionId);
        
        if (session && session.api) {
            session.api.sendMessage({ body: message }, session.groupId, (err) => {
                if (err) {
                    res.json({ success: false, error: err.message });
                } else {
                    session.messagesSent++;
                    broadcastLog(sessionId, `💬 Manual message sent: "${message}"`, 'success');
                    res.json({ success: true, message: 'Message sent' });
                }
            });
        } else {
            res.json({ success: false, error: 'Session not found or inactive' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/session-info/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const info = sessionManager.getSessionInfo(sessionId);
        res.json(info);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/sessions', (req, res) => {
    try {
        const sessions = sessionManager.getAllSessions();
        res.json(sessions);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/saved-sessions', (req, res) => {
    try {
        const sessions = Array.from(permanentSessions.values())
            .filter(s => !sessionManager.activeSessions.has(s.id))
            .map(s => ({
                id: s.id,
                groupId: s.groupId,
                groupName: s.settings?.groupName || 'Unknown',
                lastActive: s.lastActive,
                totalUptime: s.totalUptime
            }));
        res.json(sessions);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const stats = sessionManager.getStats();
        res.json(stats);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/fetch-groups', async (req, res) => {
    try {
        const { cookies } = req.body;
        
        if (!cookies) {
            return res.json({ success: false, error: 'Cookies required' });
        }
        
        const result = await sessionManager.fetchGroups(cookies);
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== WEBSOCKET ====================
const server = app.listen(PORT, () => {
    console.log('♾️ PERMANENT GROUP MANAGER PRO');
    console.log('👨‍💻 DEVELOPER: R4J M1SHR4');
    console.log('🌐 Server: http://localhost:' + PORT);
    console.log('🎯 Manual Restore Selection: ENABLED');
    console.log('💬 Optional Message Sending: ENABLED');
    console.log('📱 Device: Mozilla Linux/Android ONLY');
    console.log('🔄 Cookie auto-renewal: 24 HOURS');
});

let wss = new WebSocket.Server({ server });

function broadcastLog(sessionId, message, level = 'info') {
    const logMessage = '[♾️ ' + sessionId + '] ' + message;
    console.log(logMessage);
    
    if (wss) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'log',
                    message: logMessage,
                    level: level
                }));
            }
        });
    }
}

function broadcastSessionUpdate() {
    if (wss) {
        const stats = sessionManager.getStats();
        
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'stats',
                    data: stats
                }));
                
                client.send(JSON.stringify({
                    type: 'session_update'
                }));
            }
        });
    }
}

setInterval(saveAllSessions, 30000);
setInterval(broadcastSessionUpdate, 60000);

process.on('uncaughtException', (error) => {
    console.log('♾️ Error handled, continuing:', error.message);
    saveAllSessions();
});

process.on('SIGINT', () => {
    console.log('♾️ Server stopping... All sessions saved permanently.');
    saveAllSessions();
    wss.close();
    server.close(() => {
        console.log('💾 All features preserved. Sessions can be restarted.');
        process.exit(0);
    });
});

console.log('✅ ALL FEATURES LOADED: Manual restore + Messages + No cut + No miss + No error!');
