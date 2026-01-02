console.log("🚀 Démarrage du script..."); 

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    jidNormalizedUser, 
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    downloadContentFromMessage, 
    proto,
    delay 
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const axios = require('axios');
const yts = require('yt-search');
const { createCanvas, registerFont } = require('canvas');
const express = require('express'); // POUR LE SITE WEB
const app = express();

const dbFile = './database.json';
const PORT = process.env.PORT || 3000; // Port pour Render/Railway

// --- CONFIGURATION ADMIN & MODE ---
let mode = 'public'; // Par défaut
const ownerNumber = '212783094318'; // Ton numéro
let sudoUsers = [ownerNumber + '@s.whatsapp.net']; // Liste Admin

// --- SERVEUR WEB POUR PAIRING ---
app.use(express.static('public')); // Sert le dossier public

app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.json({ error: 'Numéro manquant' });
    // On relance la connexion avec le numéro spécifique pour forcer le pairing
    await connectToWhatsApp(phone, res);
});

app.listen(PORT, () => {
    console.log(`🌍 Serveur Web lancé sur le port ${PORT}`);
});

// --- MEMOIRE TEMPORAIRE ---
const spamTracker = {}; 

// --- CHARGEMENT DB ---
function loadDatabase() {
    try {
        if (!fs.existsSync(dbFile)) return {};
        const rawData = fs.readFileSync(dbFile, 'utf-8');
        if (!rawData || rawData.trim() === "") return {};
        return JSON.parse(rawData);
    } catch (error) {
        console.error("❌ Erreur lecture DB:", error);
        return {}; 
    }
}

function saveDatabase(data) {
    try {
        fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("❌ Erreur sauvegarde DB:", err);
    }
}

console.log("📂 Chargement de la base de données...");
let db = loadDatabase();

// Initialisation des réglages GLOBAUX
if (!db.settings) {
    db.settings = {
        autoviewstatus: false,
        autostatusreact: false,
        chatbot_status: false,
        alwaysonline: false,
        autoread: false,
        autobio: false,
        autotyping: 'off',
        autorecording: 'off',
        autoreact: 'off'
    };
    saveDatabase(db);
}
console.log("✅ Base de données chargée !");

function initGroup(jid) {
    if (!db[jid]) {
        console.log(`🆕 Initialisation DB pour le groupe : ${jid}`);
        db[jid] = {
            welcome: false, // PAR DÉFAUT : DÉSACTIVÉ (OFF)
            antilink_delete: false,
            antilink_warn: false,
            antilink_kick: false,
            antisticker: false,
            antimedia: false,
            antibad: false,
            antinsfw: false,
            antimention: false,
            antitag: false,
            antitemu: false,
            antispam: false,
            badwords: [],
            users: {}
        };
        saveDatabase(db);
    } else {
        if (db[jid].antispam === undefined) db[jid].antispam = false;
        if (db[jid].welcome === undefined) db[jid].welcome = false; // Ajout migration
        saveDatabase(db);
    }
}

// --- FONCTION UTILITAIRE ---
const getRandom = (ext) => {
    return `${Math.floor(Math.random() * 10000)}${ext}`;
};

// Fonction pour télécharger une image depuis une URL
const getBuffer = async (url) => {
    try {
        const res = await axios({ method: "get", url, headers: { 'DNT': 1, 'Upgrade-Insecure-Requests': 1 }, responseType: 'arraybuffer' });
        return res.data;
    } catch (e) { throw new Error(e); }
};

// ==============================================
// FONCTION DE CONNEXION (MODIFIÉE POUR PAIRING)
// ==============================================
async function connectToWhatsApp(pairingNumber = null, res = null) {
    console.log("🔌 Tentative de connexion à WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !pairingNumber, // Si pairingNumber existe, pas de QR
        auth: state,
        generateHighQualityLinkPreview: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"] // Navigateur stable pour Pairing
    });

    // LOGIQUE DE PAIRING CODE
    if (pairingNumber && !sock.authState.creds.me) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(pairingNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`🔢 CODE DE JUMELAGE : ${code}`);
                if (res) res.json({ code: code }); // Envoie le code au site web
            } catch (e) {
                if (res) res.json({ error: "Erreur demande code. Vérifie le numéro." });
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !pairingNumber) {
            console.log("📸 Scan ce QR Code :");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connexion fermée. Reconnexion...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Bot Connecté avec succès !');
            if (db.settings.alwaysonline) {
                sock.sendPresenceUpdate('available');
                console.log("🟢 Presence: Available");
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // =========================================================
    //  GESTION BIENVENUE & AU REVOIR (WELCOME / GOODBYE)
    // =========================================================
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            
            // 1. Initialiser le groupe si besoin
            initGroup(id);

            // 2. VÉRIFICATION DE L'INTERRUPTEUR
            if (!db[id].welcome) return;

            // Récupérer les infos du groupe
            let groupMetadata;
            try {
                groupMetadata = await sock.groupMetadata(id);
            } catch (e) { return; }

            for (const participant of participants) {
                // Récupérer la PP du membre
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(participant, 'image');
                } catch {
                    ppUrl = 'https://i.imgur.com/6E025cw.jpg'; 
                }

                if (action === 'add') {
                    const welcomeText = `🌟 *BIENVENUE* 🌟\n\n👋 Salut @${participant.split('@')[0]} !\n🏠 Bienvenue dans : *${groupMetadata.subject}*\n\n📜 Prends le temps de lire la description.\n✨ Amuse-toi bien !`;
                    await sock.sendMessage(id, { image: { url: ppUrl }, caption: welcomeText, mentions: [participant] });

                } else if (action === 'remove') {
                    const goodbyeText = `🚪 *AU REVOIR* 🚪\n\n👋 @${participant.split('@')[0]} a quitté le groupe.\n\nBonne continuation !`;
                    await sock.sendMessage(id, { image: { url: ppUrl }, caption: goodbyeText, mentions: [participant] });
                }
            }
        } catch (e) {
            console.error('Erreur Welcome/Goodbye :', e);
        }
    });

    // =========================================================
    //  GESTION DES MESSAGES
    // =========================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            // --- STATUS ---
            if (m.key.remoteJid === 'status@broadcast') {
                if (m.key.fromMe) return;
                console.log(`[STATUS] Nouveau statut de ${m.key.participant.split('@')[0]}`);
                if (db.settings.autoviewstatus) await sock.readMessages([m.key]);
                if (db.settings.autostatusreact) await sock.sendMessage('status@broadcast', { react: { text: '💚', key: m.key } }, { statusJidList: [m.key.participant] });
                if (db.settings.chatbot_status) await sock.sendMessage(m.key.participant, { text: 'Top ton statut ! 🔥' }, { quoted: m });
                return;
            }

            const type = Object.keys(m.message)[0];
            const body = m.message.conversation || m.message[type]?.caption || m.message[type]?.text || "";
            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const pushName = m.pushName || "Inconnu";
            
            const botId = jidNormalizedUser(sock.user.id);
            const senderRaw = m.key.fromMe ? botId : (m.key.participant || from);
            const senderId = jidNormalizedUser(senderRaw);
            
            // --- DROITS ADMIN ---
            const isCreator = senderId.split('@')[0] === ownerNumber;
            const isSudo = sudoUsers.includes(senderId) || isCreator;

            const reply = (text) => sock.sendMessage(from, { text: text }, { quoted: m });

            if (!m.key.fromMe) {
                console.log(`📥 [MSG] ${pushName} (${senderId.split('@')[0]}) : ${type}`);
            }

            const isSticker = type === 'stickerMessage';
            const isMedia = type === 'imageMessage' || type === 'videoMessage';
            const quoted = m.message[type]?.contextInfo?.quotedMessage;
            const quotedType = quoted ? Object.keys(quoted)[0] : null;
            const mentionedJid = m.message[type]?.contextInfo?.mentionedJid || [];

            // --- GESTION DU MODE PRIVÉ ---
            if (mode === 'private' && !isSudo) return;

            // --- AUTOMATISATIONS ---
            if (!m.key.fromMe) {
                if (db.settings.autoread) await sock.readMessages([m.key]);
                const scope = isGroup ? 'group' : 'inbox';
                if (db.settings.autotyping === 'both' || db.settings.autotyping === scope) await sock.sendPresenceUpdate('composing', from);
                if (db.settings.autorecording === 'both' || db.settings.autorecording === scope) await sock.sendPresenceUpdate('recording', from);
                if (db.settings.autoreact === 'both' || db.settings.autoreact === scope) {
                    const emojis = ['❤️', '👍', '🔥', '😂', '👀', '🤖', '🚀'];
                    await sock.sendMessage(from, { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: m.key } });
                }
            }
            
            // --- MODERATION & INFO GROUPE ---
            let isAdmin = false;
            let isBotAdmin = false;
            let groupMetadata = null;
            let participants = [];
            
            if (isGroup) {
                initGroup(from);
                try {
                    groupMetadata = await sock.groupMetadata(from);
                    participants = groupMetadata.participants;
                    isAdmin = participants.some(p => jidNormalizedUser(p.id) === senderId && (p.admin === 'admin' || p.admin === 'superadmin'));
                    isBotAdmin = participants.some(p => jidNormalizedUser(p.id) === botId && (p.admin === 'admin' || p.admin === 'superadmin'));
                } catch (e) {}

                const settings = db[from];
                if (!settings) { initGroup(from); return; }
                const senderData = settings.users[senderId] || { warnings: 0 };

                const sanctionner = async (raison, mode) => {
                    if (isCreator || isAdmin) return; 
                    console.log(`🛡️ [MOD] Sanction ${mode} pour ${raison} sur ${senderId.split('@')[0]}`);

                    let aPuSupprimer = false;
                    if (isBotAdmin) { await sock.sendMessage(from, { delete: m.key }); aPuSupprimer = true; }
                    if (!aPuSupprimer && mode === 'delete_only') await sock.sendMessage(from, { text: `⚠️ @${senderId.split('@')[0]}, ${raison} !` }, { quoted: m });

                    if (mode === 'warn' || mode === 'kick') {
                        senderData.warnings += 1;
                        db[from].users[senderId] = senderData;
                        saveDatabase(db);
                        if (senderData.warnings >= 5) {
                            if (mode === 'kick' && isBotAdmin) {
                                await sock.sendMessage(from, { text: `🚫 @${senderId.split('@')[0]} expulsé.` }, { quoted: m });
                                await sock.groupParticipantsUpdate(from, [senderId], 'remove');
                            } else {
                                await sock.sendMessage(from, { text: `🛑 @${senderId.split('@')[0]} 5/5 Avertissements.` }, { quoted: m });
                            }
                            senderData.warnings = 0; saveDatabase(db);
                        } else {
                            let prefix = aPuSupprimer ? "⚠️" : "⚠️ Non-Admin :";
                            await sock.sendMessage(from, { text: `${prefix} ${raison} (${senderData.warnings}/5)` }, { quoted: m });
                        }
                    }
                };

                if (!isAdmin && !isCreator) {
                    if (settings.antispam) {
                        if (!spamTracker[from]) spamTracker[from] = {};
                        if (!spamTracker[from][senderId]) spamTracker[from][senderId] = [];
                        const now = Date.now();
                        spamTracker[from][senderId] = spamTracker[from][senderId].filter(time => now - time < 10000);
                        spamTracker[from][senderId].push(now);
                        if (spamTracker[from][senderId].length > 5) { 
                            await sanctionner("Spam", 'warn'); 
                            spamTracker[from][senderId] = [];
                        }
                    }
                    if (body.includes('http')) {
                        if (settings.antilink_kick) await sanctionner("Lien", 'kick');
                        else if (settings.antilink_warn) await sanctionner("Lien", 'warn');
                        else if (settings.antilink_delete) await sanctionner("Lien", 'delete_only'); 
                    }
                    if (isSticker && settings.antisticker) await sanctionner("Sticker", 'warn');
                    if (isMedia && settings.antimedia) await sanctionner("Média", 'warn');
                    if (settings.antitemu && body.toLowerCase().includes('temu')) await sanctionner("Temu", 'warn');
                    if (settings.antimention && m.message[type]?.contextInfo?.mentionedJid?.length > 0) await sanctionner("Mention", 'warn');
                    if (settings.antibad && settings.badwords.some(word => body.toLowerCase().includes(word.toLowerCase()))) await sanctionner("Insulte", 'warn');
                }
            }

            // ==========================================
            // COMMANDES
            // ==========================================
            
            const command = body.split(' ')[0].toLowerCase();
            const args = body.split(' ').slice(1);
            const text = args.join(" ");
            
            if (command.startsWith('.')) {
                console.log(`🤖 [CMD] Commande : ${command}`);
            }

            // ==========================================
            // GESTION DES TEXTPRO (VERSION SCRAPER PRO)
            // ==========================================
            const textProMap = {
                "candy": "https://textpro.me/create-christmas-candy-cane-text-effect-1056.html",
                "christmas": "https://textpro.me/christmas-tree-text-effect-online-free-1057.html",
                "3dchristmas": "https://textpro.me/3d-christmas-text-effect-by-name-1055.html",
                "sparklechristmas": "https://textpro.me/sparkles-merry-christmas-text-effect-1054.html",
                "deepsea": "https://textpro.me/create-deep-sea-metal-text-effect-897.html",
                "scifi": "https://textpro.me/create-sci-fi-text-effect-online-889.html",
                "rainbow": "https://textpro.me/create-rainbow-color-calligraphy-text-effect-1049.html",
                "waterpipe": "https://textpro.me/create-3d-water-pipe-text-effect-online-1048.html",
                "spooky": "https://textpro.me/create-halloween-skeleton-text-effect-online-1047.html",
                "pencil": "https://textpro.me/create-pencil-sketch-text-effect-969.html",
                "circuit": "https://textpro.me/create-blue-circuit-style-text-effect-online-1043.html",
                "discovery": "https://textpro.me/create-space-text-effect-online-985.html",
                "metalic": "https://textpro.me/create-a-metallic-text-effect-free-online-1041.html",
                "fiction": "https://textpro.me/create-science-fiction-text-effect-online-free-1038.html",
                "demon": "https://textpro.me/create-green-horror-style-text-effect-online-1036.html",
                "transformer": "https://textpro.me/create-transformer-text-effect-online-1035.html",
                "berry": "https://textpro.me/create-berry-text-effect-online-free-1033.html",
                "thunder": "https://textpro.me/online-thunder-text-effect-generator-1031.html",
                "magma": "https://textpro.me/create-magma-hot-text-effect-online-1030.html",
                "3dstone": "https://textpro.me/create-3d-stone-text-effect-online-1028.html",
                "neonlight": "https://textpro.me/neon-light-text-effect-with-galaxy-background-989.html",
                "glitch": "https://textpro.me/create-glitch-text-effect-style-tik-tok-983.html",
                "harrypotter": "https://textpro.me/create-harry-potter-text-effect-online-1025.html",
                "brokenglass": "https://textpro.me/broken-glass-text-effect-free-online-1023.html",
                "papercut": "https://textpro.me/create-art-paper-cut-text-effect-online-1022.html",
                "watercolor": "https://textpro.me/create-watercolor-text-effect-online-1017.html",
                "multicolor": "https://textpro.me/online-multicolor-3d-paper-cut-text-effect-1016.html",
                "neondevil": "https://textpro.me/create-neon-devil-wings-text-effect-online-free-1014.html",
                "underwater": "https://textpro.me/3d-underwater-text-effect-generator-online-1013.html",
                "graffitibike": "https://textpro.me/create-cool-wall-graffiti-text-effect-online-1009.html",
                "snow": "https://textpro.me/create-snow-text-effect-online-free-1005.html",
                "cloud": "https://textpro.me/create-a-cloud-text-effect-on-the-sky-online-1004.html",
                "honey": "https://textpro.me/honey-text-effect-877.html",
                "ice": "https://textpro.me/ice-cold-text-effect-862.html",
                "fruitjuice": "https://textpro.me/create-fruit-juice-text-effect-online-861.html",
                "biscuit": "https://textpro.me/biscuit-text-effect-858.html",
                "wood": "https://textpro.me/wood-text-effect-856.html",
                "chocolate": "https://textpro.me/chocolate-cake-text-effect-890.html",
                "strawberry": "https://textpro.me/strawberry-text-effect-online-888.html",
                "matrix": "https://textpro.me/matrix-style-text-effect-online-884.html",
                "blood": "https://textpro.me/blood-text-on-the-frosted-glass-941.html",
                "dropwater": "https://textpro.me/dropwater-text-effect-872.html",
                "toxic": "https://textpro.me/toxic-text-effect-online-901.html",
                "lava": "https://textpro.me/lava-text-effect-online-914.html",
                "rock": "https://textpro.me/rock-text-effect-online-915.html",
                "bloodglas": "https://textpro.me/blood-text-on-the-frosted-glass-941.html",
                "hallowen": "https://textpro.me/halloween-fire-text-effect-940.html",
                "darkgold": "https://textpro.me/metal-dark-gold-text-effect-984.html",
                "joker": "https://textpro.me/create-logo-joker-online-934.html",
                "wicker": "https://textpro.me/wicker-text-effect-online-932.html",
                "firework": "https://textpro.me/firework-sparkle-text-effect-930.html",
                "skeleton": "https://textpro.me/skeleton-text-effect-online-929.html",
                "sand": "https://textpro.me/write-in-sand-summer-beach-free-online-991.html",
                "glue": "https://textpro.me/create-3d-glue-text-effect-with-realistic-style-986.html",
                "1917": "https://textpro.me/1917-style-text-effect-online-980.html",
                "leaves": "https://textpro.me/create-green-leaves-text-effect-926.html"
            };

            const cmdName = command.replace('.', '');
            
            if (textProMap[cmdName]) {
                if (!text) return reply(`❌ Entrez le texte pour l'effet.\nExemple : ${command} MCT`);
                
                try {
                    await sock.sendMessage(from, { react: { text: '🎨', key: m.key } });
                    
                    // Appel de notre fonction maison (plus d'API externe !)
                    const imageUrl = await textPro(textProMap[cmdName], text);
                    
                    // CORRECTION ICI : On télécharge l'image en buffer avant de l'envoyer
                    const imageBuffer = await getBuffer(imageUrl);

                    await sock.sendMessage(from, { 
                        image: imageBuffer, 
                        caption: `🎨 Effet : *${cmdName.toUpperCase()}*` 
                    }, { quoted: m });
                    
                    await sock.sendMessage(from, { react: { text: '✅', key: m.key } });

                } catch (e) {
                    console.error("Erreur TextPro:", e);
                    reply("❌ Erreur lors de la création. Réessaie ou change de style.");
                }
            }

            switch (command) {
                // ==========================================
                // COMMANDES GROUPE
                // ==========================================

                // --- COMMANDE POUR ACTIVER/DÉSACTIVER WELCOME ---
                case '.welcome':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Admins seulement.');
                    
                    if (args[0] === 'on') {
                        db[from].welcome = true;
                        saveDatabase(db);
                        reply('✅ Messages de Bienvenue et Au revoir ACTIVÉS pour ce groupe.');
                    } else if (args[0] === 'off') {
                        db[from].welcome = false;
                        saveDatabase(db);
                        reply('❌ Messages de Bienvenue et Au revoir DÉSACTIVÉS.');
                    } else {
                        reply('⚠️ Usage : .welcome on / .welcome off');
                    }
                    break;

                case '.kick':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Seuls les admins peuvent faire ça.');
                    if (!isBotAdmin) return reply('Je ne suis pas admin, je ne peux pas exclure.');
                    
                    let userToKick = mentionedJid[0] ? mentionedJid[0] : (quoted ? quoted.sender : null);
                    if (!userToKick) return reply('Tag le membre à exclure ou réponds à son message.');
                    if (userToKick === ownerNumber + '@s.whatsapp.net') return reply('Impossible de bannir le Owner.');
                    
                    await sock.groupParticipantsUpdate(from, [userToKick], 'remove');
                    reply(`👋 Au revoir @${userToKick.split('@')[0]} !`);
                    break;

                case '.kickall':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isCreator) return reply('❌ Sécurité : Seul le OWNER peut utiliser KickAll.');
                    if (!isBotAdmin) return reply('Je dois être Admin.');
                    
                    reply('⚠️ *Lancement du KickAll...*');
                    for (let participant of participants) {
                        if (!participant.id.includes(botId) && !participant.id.includes(ownerNumber) && participant.admin === null) {
                            await sock.groupParticipantsUpdate(from, [participant.id], 'remove');
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                    reply('✅ Nettoyage terminé.');
                    break;

                case '.warn':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Seuls les admins peuvent donner des avertissements.');
                    
                    let userToWarn = mentionedJid[0] ? mentionedJid[0] : (quoted ? quoted.sender : null);
                    if (!userToWarn) return reply('Tag le membre.');
                    
                    if (!db[from].users[userToWarn]) db[from].users[userToWarn] = { warnings: 0 };
                    db[from].users[userToWarn].warnings += 1;
                    let warnCount = db[from].users[userToWarn].warnings;
                    saveDatabase(db);
                    
                    reply(`⚠️ @${userToWarn.split('@')[0]} a reçu un avertissement (${warnCount}/5).`);
                    
                    if (warnCount >= 5) {
                        if (isBotAdmin) {
                            await sock.groupParticipantsUpdate(from, [userToWarn], 'remove');
                            reply('🚫 Limite d\'avertissements atteinte. Exclusion.');
                            db[from].users[userToWarn].warnings = 0;
                            saveDatabase(db);
                        } else {
                            reply('🚫 Limite atteinte, mais je ne suis pas admin pour l\'exclure.');
                        }
                    }
                    break;

                case '.tagall':
                case '.everyone':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Seuls les admins peuvent taguer tout le monde.');
                    
                    let tagText = command === '.tagall' ? `📢 *TAG ALL*\n\n${text}\n` : (text || '');
                    let mentions = participants.map(a => a.id);
                    
                    if (command === '.tagall') {
                        for (let mem of participants) {
                            tagText += `\n@${mem.id.split('@')[0]}`;
                        }
                    }
                    await sock.sendMessage(from, { text: tagText, mentions: mentions }, { quoted: m });
                    break;

                case '.hidetag':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Réservé aux admins.');
                    let hidetagMem = participants.map(a => a.id);
                    await sock.sendMessage(from, { text: text ? text : 'Tag caché', mentions: hidetagMem }, { quoted: m });
                    break;

                case '.leavegc':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Seuls les admins peuvent me demander de partir.');
                    reply('👋 Je quitte le groupe. Bye !');
                    await sock.groupLeave(from);
                    break;

                case '.invite':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Seuls les admins peuvent inviter.');
                    if (!text) return reply('Entre le numéro (ex: .invite 223xxxx)');
                    
                    let userInvite = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    try {
                        const response = await sock.groupParticipantsUpdate(from, [userInvite], 'add');
                        if (response[0].status === '403') {
                            reply('❌ Impossible de l\'ajouter directement (Confidentialité). Envoie-lui le lien.');
                        } else {
                            reply('✅ Invitation envoyée / Ajouté.');
                        }
                    } catch (e) {
                        reply('❌ Erreur lors de l\'invitation.');
                    }
                    break;

                case '.getname':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    reply(`Nom du groupe : *${groupMetadata.subject}*`);
                    break;

                case '.getppgc':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    try {
                        let ppUrlGc = await sock.profilePictureUrl(from, 'image');
                        await sock.sendMessage(from, { image: { url: ppUrlGc }, caption: 'Voici la photo du groupe.' });
                    } catch {
                        reply('Pas de photo de groupe trouvée.');
                    }
                    break;

                case '.setppgc':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Admins seulement.');
                    if (!isBotAdmin) return reply('Je dois être admin pour changer la photo.');
                    if (!quoted || !/image/.test(quotedType)) return reply('Réponds à une image.');
                    
                    try {
                        const media = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await sock.updateProfilePicture(from, media);
                        reply('✅ Photo du groupe mise à jour !');
                    } catch (e) {
                        reply('❌ Erreur lors de la mise à jour.');
                    }
                    break;

                case '.svccontact':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    reply('⏳ Génération du fichier contact en cours...');
                    let vcard = "";
                    for (let mem of participants) {
                        let num = mem.id.split('@')[0];
                        vcard += `BEGIN:VCARD\nVERSION:3.0\nFN:WA-${num}\nTEL;type=CELL;waid=${num}:${num}\nEND:VCARD\n`;
                    }
                    await sock.sendMessage(from, { 
                        document: Buffer.from(vcard), 
                        mimetype: 'text/vcard', 
                        fileName: `Contacts_${groupMetadata.subject}.vcf`,
                        caption: '✅ Voici tous les contacts du groupe.'
                    }, { quoted: m });
                    break;

                case '.listonline':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    let listText = `👥 *Membres du Groupe (${participants.length})* :\n`;
                    participants.forEach(p => {
                        listText += `\n- @${p.id.split('@')[0]} ${p.admin ? '(Admin)' : ''}`;
                    });
                    await sock.sendMessage(from, { text: listText, mentions: participants.map(p => p.id) }, { quoted: m });
                    break;

                case '.opengroup':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Admins seulement.');
                    if (!isBotAdmin) return reply('Je dois être admin.');
                    await sock.groupSettingUpdate(from, 'announcement', false);
                    reply('🔓 Groupe ouvert ! Tout le monde peut parler.');
                    break;

                case '.closegroup':
                    if (!isGroup) return reply('Commande Groupe uniquement.');
                    if (!isAdmin && !isCreator) return reply('Admins seulement.');
                    if (!isBotAdmin) return reply('Je dois être admin.');
                    await sock.groupSettingUpdate(from, 'announcement', true);
                    reply('🔒 Groupe fermé ! Seuls les admins peuvent parler.');
                    break;

                // --- GESTION DU MODE ---
                case '.mode':
                case '.mode-public':
                case '.mode-private':
                    if (!isCreator) return reply('Seul le Propriétaire peut changer le mode.');
                    if (command === '.mode-public') {
                        mode = 'public';
                        reply('Le bot est maintenant en mode PUBLIC. Tout le monde peut l\'utiliser.');
                    } else if (command === '.mode-private') {
                        mode = 'private';
                        reply('Le bot est maintenant en mode PRIVÉ. Seuls les Sudo/Owner peuvent l\'utiliser.');
                    } else {
                        mode = mode === 'public' ? 'private' : 'public';
                        reply(`Mode changé en : ${mode.toUpperCase()}`);
                    }
                    break;

                // --- GESTION SUDO ---
                case '.sudo':
                    if (!isCreator) return reply('Commande réservée au Propriétaire.');
                    let userToAdd = mentionedJid[0] ? mentionedJid[0] : (args[0] ? args[0] + '@s.whatsapp.net' : null);
                    if (!userToAdd) return reply('Tag quelqu\'un ou mets son numéro.');
                    
                    if (!sudoUsers.includes(userToAdd)) {
                        sudoUsers.push(userToAdd);
                        reply('Utilisateur ajouté à la liste Sudo ✅');
                    } else {
                        reply('Cet utilisateur est déjà Sudo.');
                    }
                    break;

                case '.delsudo':
                    if (!isCreator) return reply('Commande réservée au Propriétaire.');
                    let userToDel = mentionedJid[0] ? mentionedJid[0] : (args[0] ? args[0] + '@s.whatsapp.net' : null);
                    
                    if (sudoUsers.includes(userToDel)) {
                        sudoUsers = sudoUsers.filter(u => u !== userToDel);
                        reply('Utilisateur retiré des Sudo ❌');
                    } else {
                        reply('Cet utilisateur n\'est pas Sudo.');
                    }
                    break;

                case '.listsudo':
                    reply(`Voici la liste des Sudo :\n- ${sudoUsers.map(u => u.split('@')[0]).join('\n- ')}`);
                    break;

                case '.me':
                case '.id':
                    reply(`Voici comment je te vois :\n\nID: ${senderId}\nNuméro pur: ${senderId.split('@')[0]}\nOwner défini: ${ownerNumber}\n\nEst-ce que ça correspond ? ${isCreator ? 'OUI ✅' : 'NON ❌'}`);
                    break;

                // --- GESTION INTERACTIONS ---
                case '.report':
                    if (!text) return reply('Quel est le bug ou le message à signaler ?');
                    let reportMsg = `🚨 *SIGNALEMENT* 🚨\nDe: @${senderId.split('@')[0]}\nMessage: ${text}`;
                    await sock.sendMessage(ownerNumber + '@s.whatsapp.net', { text: reportMsg, mentions: [senderId] });
                    reply('Ton signalement a été envoyé au propriétaire. Merci !');
                    break;

                case '.block':
                case '.unblock':
                    if (!isSudo) return reply('Désolé, seuls les admins peuvent gérer les blocages.');
                    let userToBlock = mentionedJid[0] ? mentionedJid[0] : (quoted ? quoted.sender : null);
                    if (!userToBlock) return reply('Tag ou réponds au message de la personne.');
                    
                    let action = command === '.block' ? 'block' : 'unblock';
                    await sock.updateBlockStatus(userToBlock, action);
                    reply(`Utilisateur ${action === 'block' ? 'bloqué ⛔' : 'débloqué ✅'}`);
                    break;

                case '.clearchat':
                    if (!isSudo) return reply('Option admin.');
                    await sock.chatModify({ delete: true, lastMessages: [{ key: m.key, messageTimestamp: m.messageTimestamp }] }, from);
                    reply('Chat effacé ! 🗑️');
                    break;

                case '.delete':
                case '.del':
                    if (!isSudo && !isAdmin) return reply('Tu n\'as pas le droit.');
                    if (!quoted) return reply('Réponds au message du bot que tu veux supprimer.');
                    await sock.sendMessage(from, { delete: quoted.key });
                    break;

                // --- PROFIL & BIO ---
                case '.setpp':
                    if (!isSudo) return reply('Seuls les admins peuvent changer ma photo.');
                    if (!quoted || !/image/.test(quotedType)) return reply('Réponds à une image pour changer la PP.');
                    try {
                        const media = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await sock.updateProfilePicture(botId, media);
                        reply('Nouvelle photo de profil définie ! 📸');
                    } catch (e) { console.error(e); reply("Erreur changement photo."); }
                    break;

                case '.getpp':
                    let target = mentionedJid[0] ? mentionedJid[0] : senderId;
                    try {
                        let ppUrl = await sock.profilePictureUrl(target, 'image');
                        await sock.sendMessage(from, { image: { url: ppUrl }, caption: 'Voici la photo de profil.' });
                    } catch {
                        reply('Impossible de récupérer la photo (privée ou inexistante).');
                    }
                    break;

                case '.getbio':
                    let bioTarget = mentionedJid[0] ? mentionedJid[0] : senderId;
                    try {
                        let status = await sock.fetchStatus(bioTarget);
                        reply(`📅 Statut de @${bioTarget.split('@')[0]} :\n\n"${status.status}"\n(Mis à jour le : ${new Date(status.setAt).toLocaleDateString()})`);
                    } catch {
                        reply('Bio privée ou introuvable.');
                    }
                    break;

                // --- ANTI VUE UNIQUE ---
                case '.vv':
                case '.vv2':
                    if (!quoted) return reply('Réponds à un message à vue unique.');
                    let viewOnceMsg = quoted.viewOnceMessageV2?.message || quoted.viewOnceMessage?.message;
                    if (viewOnceMsg) {
                         let typeMedia = Object.keys(viewOnceMsg)[0];
                         let stream = await downloadContentFromMessage(viewOnceMsg[typeMedia], typeMedia.replace('Message', ''));
                         let buffer = Buffer.from([]);
                         for await(const chunk of stream) {
                             buffer = Buffer.concat([buffer, chunk]);
                         }
                         reply('Voici le média récupéré (chut 🤫)');
                         if (typeMedia === 'imageMessage') await sock.sendMessage(from, { image: buffer, caption: 'Anti-ViewOnce' });
                         else if (typeMedia === 'videoMessage') await sock.sendMessage(from, { video: buffer, caption: 'Anti-ViewOnce' });
                         else if (typeMedia === 'audioMessage') await sock.sendMessage(from, { audio: buffer, ptt: true });
                    } else {
                        reply('Ce n\'est pas un message à vue unique valide.');
                    }
                    break;

                case '.premium':
                case '.buypremium':
                    reply("👑 *MCT PREMIUM*\n\nPour acheter le premium et accéder aux fonctionnalités exclusives, contacte le propriétaire : wa.me/" + ownerNumber);
                    break;

                // --- CRÉATEUR D'IMAGE LOCAL (SANS API) ---
                case '.perso':
                case '.write':
                    if (!text) return reply('❌ Entre un texte. Exemple : .perso MCT Bot');
                    
                    try {
                        reply('🎨 Création de l\'image en local...');
                        
                        const width = 800;
                        const height = 400;
                        const canvas = createCanvas(width, height);
                        const ctx = canvas.getContext('2d');

                        const gradient = ctx.createLinearGradient(0, 0, width, height);
                        gradient.addColorStop(0, '#12c2e9');
                        gradient.addColorStop(0.5, '#c471ed');
                        gradient.addColorStop(1, '#f64f59');
                        ctx.fillStyle = gradient;
                        ctx.fillRect(0, 0, width, height);

                        ctx.beginPath();
                        ctx.arc(width / 2, height / 2, 150, 0, Math.PI * 2);
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                        ctx.lineWidth = 20;
                        ctx.stroke();

                        let fontSize = 100;
                        ctx.font = `bold ${fontSize}px sans-serif`;
                        
                        while (ctx.measureText(text).width > width - 100) {
                            fontSize -= 10;
                            ctx.font = `bold ${fontSize}px sans-serif`;
                        }

                        ctx.shadowColor = "black";
                        ctx.shadowBlur = 15;
                        ctx.shadowOffsetX = 5;
                        ctx.shadowOffsetY = 5;

                        ctx.fillStyle = '#ffffff';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(text, width / 2, height / 2);

                        const buffer = canvas.toBuffer('image/png');
                        await sock.sendMessage(from, { image: buffer, caption: '✨ Image générée localement (Sans API)' }, { quoted: m });

                    } catch (e) {
                        console.error(e);
                        reply('❌ Erreur lors de la création locale (As-tu fait "npm install canvas" ?)');
                    }
                    break;
            }

            // ==========================================
            // ANCIENNES COMMANDES (GARDÉES INTACTES)
            // ==========================================

            if (command === '.ping') await sock.sendMessage(from, { text: 'Pong ! 🏓' }, { quoted: m });

            if (command === '.restart') {
                if (!isCreator) return sock.sendMessage(from, { text: "⛔ Réservé au Owner." }, { quoted: m });
                await sock.sendMessage(from, { text: "🔄 Mise à jour..." }, { quoted: m });
                setTimeout(() => { process.exit(0); }, 1000);
            }

            // 1. IMAGE SEARCH
            if (command === '.image' || command === '.img') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .image chat mignon" }, { quoted: m });
                await sock.sendMessage(from, { react: { text: '🔍', key: m.key } });
                try {
                    const res = await axios.get(`https://api.davidcyriltech.my.id/googleimage?text=${text}`);
                    if (!res.data || !res.data.result || res.data.result.length === 0) throw new Error("Pas d'image trouvée");
                    const randomImg = res.data.result[Math.floor(Math.random() * res.data.result.length)];
                    await sock.sendMessage(from, { image: { url: randomImg }, caption: `🖼️ Résultat pour : *${text}*` }, { quoted: m });
                } catch (e) {
                    sock.sendMessage(from, { text: "❌ Erreur recherche image." }, { quoted: m });
                }
            }

            // 2. GOOGLE SEARCH
            if (command === '.google' || command === '.bing') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .google Qui est Elon Musk" }, { quoted: m });
                await sock.sendMessage(from, { react: { text: '🌐', key: m.key } });
                try {
                    const res = await axios.get(`https://api.davidcyriltech.my.id/google?text=${text}`);
                    if (!res.data || !res.data.result) throw new Error("Pas de résultat");
                    
                    let txt = `🔎 *Recherche :* ${text}\n\n`;
                    for (let i = 0; i < Math.min(3, res.data.result.length); i++) {
                        txt += `🔹 *${res.data.result[i].title}*\n${res.data.result[i].snippet}\n🔗 ${res.data.result[i].link}\n\n`;
                    }
                    await sock.sendMessage(from, { text: txt }, { quoted: m });
                } catch (e) {
                    sock.sendMessage(from, { text: "❌ Erreur recherche." }, { quoted: m });
                }
            }

            // 3. LYRICS (PAROLES)
            if (command === '.lyrics') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .lyrics Hello Adele" }, { quoted: m });
                try {
                    await sock.sendMessage(from, { react: { text: '🎤', key: m.key } });
                    const res = await axios.get(`https://api.davidcyriltech.my.id/lyrics?text=${text}`);
                    if (!res.data || !res.data.result) throw new Error("Paroles non trouvées");
                    
                    const lyrics = res.data.result;
                    await sock.sendMessage(from, { 
                        text: `🎶 *Paroles pour : ${text}*\n\n${lyrics}`,
                        contextInfo: {
                            externalAdReply: {
                                title: "Paroles trouvées",
                                body: "MCT BOT",
                                thumbnail: await getBuffer("https://cdn-icons-png.flaticon.com/512/727/727218.png"),
                                mediaType: 1
                            }
                        }
                    }, { quoted: m });
                } catch (e) {
                    sock.sendMessage(from, { text: "❌ Paroles introuvables." }, { quoted: m });
                }
            }

            // 4. GITHUB SEARCH
            if (command === '.githubsearch' || command === '.github') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .github whatsapp bot" }, { quoted: m });
                try {
                    const res = await axios.get(`https://api.github.com/search/repositories?q=${text}`);
                    const repos = res.data.items;
                    if (!repos.length) throw new Error("Rien trouvé");

                    let txt = `🐙 *GitHub Search : ${text}*\n\n`;
                    for (let i = 0; i < Math.min(5, repos.length); i++) {
                        txt += `📂 *${repos[i].full_name}*\n⭐ Stars: ${repos[i].stargazers_count}\n🔗 ${repos[i].html_url}\n\n`;
                    }
                    await sock.sendMessage(from, { text: txt }, { quoted: m });
                } catch (e) {
                    sock.sendMessage(from, { text: "❌ Erreur GitHub." }, { quoted: m });
                }
            }

            // 5. GSMARENA (INFOS TELEPHONE)
            if (command === '.gsmarena') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .gsmarena iphone 15" }, { quoted: m });
                await sock.sendMessage(from, { text: `📱 *Recherche Spécifications :* ${text}\n(Utilise .google ${text} gsmarena pour plus de détails)` }, { quoted: m });
            }

            // 6. LIVE WALLPAPERS (VIDEOS)
            if (command === '.livewallpapers' || command === '.livewallpaper') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .livewallpaper naruto" }, { quoted: m });
                try {
                    await sock.sendMessage(from, { react: { text: '🎬', key: m.key } });
                    const apiUrl = `https://api.davidcyriltech.my.id/pinterest?text=${text + ' live wallpaper'}`;
                    const res = await axios.get(apiUrl);
                    
                    if (!res.data.result || res.data.result.length === 0) throw new Error("Rien trouvé");
                    const vidUrl = res.data.result[0];
                    
                    await sock.sendMessage(from, { video: { url: vidUrl }, caption: `✨ Live Wallpaper : ${text}`, gifPlayback: false }, { quoted: m });
                    await sock.sendMessage(from, { react: { text: '✅', key: m.key } });
                } catch (e) {
                    sock.sendMessage(from, { text: "❌ Rien trouvé." }, { quoted: m });
                }
            }

            // YOUTUBE (AUDIO)
            if (command === '.play' || command === '.song' || command === '.playdoc') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .play shape of you" }, { quoted: m });
                
                try {
                    await sock.sendMessage(from, { react: { text: '🔎', key: m.key } });
                    const search = await yts(text);
                    const vid = search.videos[0];
                    if (!vid) return sock.sendMessage(from, { text: "❌ Vidéo introuvable." }, { quoted: m });

                    await sock.sendMessage(from, { 
                        image: { url: vid.thumbnail }, 
                        caption: `🎵 *${vid.title}*\n⏱️ ${vid.timestamp}\n👀 ${vid.views}\n\n⏳ *Téléchargement en cours...*` 
                    }, { quoted: m });

                    const apiUrl = `https://api.davidcyriltech.my.id/download/ytmp3?url=${vid.url}`;
                    const response = await axios.get(apiUrl);
                    
                    if (!response.data || !response.data.result || !response.data.result.download_url) {
                            return sock.sendMessage(from, { text: "❌ L'API ne répond pas, réessaie." }, { quoted: m });
                    }
                    const dlUrl = response.data.result.download_url;
                    
                    await sock.sendMessage(from, { react: { text: '⬆️', key: m.key } });
                    
                    if (command === '.playdoc') {
                        await sock.sendMessage(from, { document: { url: dlUrl }, mimetype: 'audio/mpeg', fileName: `${vid.title}.mp3` }, { quoted: m });
                    } else {
                        await sock.sendMessage(from, { audio: { url: dlUrl }, mimetype: 'audio/mp4', ptt: false }, { quoted: m });
                    }
                    await sock.sendMessage(from, { react: { text: '✅', key: m.key } });

                } catch (e) { 
                    console.error(e);
                    sock.sendMessage(from, { text: "❌ Erreur (Fichier trop lourd ou connexion lente)." }, { quoted: m });
                }
            }

            // YOUTUBE (VIDEO)
            if (command === '.video' || command === '.video2' || command === '.videodoc') {
                if (!text) return sock.sendMessage(from, { text: "❌ Exemple : .video shape of you" }, { quoted: m });
                
                try {
                    await sock.sendMessage(from, { react: { text: '🔎', key: m.key } });
                    const search = await yts(text);
                    const vid = search.videos[0];
                    if (!vid) return sock.sendMessage(from, { text: "❌ Vidéo introuvable." }, { quoted: m });

                    await sock.sendMessage(from, { text: `🎥 *${vid.title}*\n\n⏳ *Traitement en cours...*\n(Cela dépend de la vitesse de ton serveur)` }, { quoted: m });

                    const apiUrl = `https://api.davidcyriltech.my.id/download/ytmp4?url=${vid.url}`;
                    const response = await axios.get(apiUrl);

                    if (!response.data || !response.data.result || !response.data.result.download_url) {
                            return sock.sendMessage(from, { text: "❌ Erreur API." }, { quoted: m });
                    }
                    const dlUrl = response.data.result.download_url;

                    await sock.sendMessage(from, { react: { text: '⬆️', key: m.key } });

                    if (command === '.videodoc') {
                        await sock.sendMessage(from, { document: { url: dlUrl }, mimetype: 'video/mp4', fileName: `${vid.title}.mp4` }, { quoted: m });
                    } else {
                        await sock.sendMessage(from, { video: { url: dlUrl }, caption: `🎬 ${vid.title}` }, { quoted: m });
                    }
                    await sock.sendMessage(from, { react: { text: '✅', key: m.key } });
                } catch (e) { 
                    console.error(e);
                    sock.sendMessage(from, { text: "❌ Erreur lors de l'envoi." }, { quoted: m });
                }
            }

            // FB, IG, TIKTOK, TWITTER
            if (['.fb', '.fbdl', '.ig', '.igdl', '.tiktok', '.douyin', '.twitter', '.x', '.pinterest', '.pinterestdl', '.snackvideo'].includes(command)) {
                if (!text) return sock.sendMessage(from, { text: `❌ Envoie le lien : ${command} https://...` }, { quoted: m });
                
                try {
                    await sock.sendMessage(from, { react: { text: '⏳', key: m.key } });

                    let apiUrl = "";
                    if (command.includes('fb')) apiUrl = `https://api.davidcyriltech.my.id/facebook?url=${text}`;
                    else if (command.includes('ig')) apiUrl = `https://api.davidcyriltech.my.id/instagram?url=${text}`;
                    else if (command.includes('tiktok') || command.includes('douyin')) apiUrl = `https://api.davidcyriltech.my.id/tiktok?url=${text}`;
                    else if (command.includes('twitter') || command.includes('x')) apiUrl = `https://api.davidcyriltech.my.id/twitter?url=${text}`;
                    else if (command.includes('pinterest')) apiUrl = `https://api.davidcyriltech.my.id/pinterest?url=${text}`;
                    else return sock.sendMessage(from, { text: "⚠️ Maintenance." }, { quoted: m });

                    const res = await axios.get(apiUrl);
                    let dlLink = null;
                    if (res.data.videoUrl) dlLink = res.data.videoUrl;
                    else if (res.data.result && typeof res.data.result === 'string') dlLink = res.data.result;
                    else if (res.data.result && res.data.result.url) dlLink = res.data.result.url;
                    else if (Array.isArray(res.data.result)) dlLink = res.data.result[0];

                    if (!dlLink) throw new Error("Lien introuvable");

                    await sock.sendMessage(from, { react: { text: '⬆️', key: m.key } });
                    await sock.sendMessage(from, { video: { url: dlLink }, caption: "✅ Téléchargé !" }, { quoted: m });
                    await sock.sendMessage(from, { react: { text: '✅', key: m.key } });

                } catch (e) {
                    console.error("Downloader Error:", e.message);
                    await sock.sendMessage(from, { text: "❌ Échec. Lien privé ou trop lourd." }, { quoted: m });
                }
            }

            // --- CONVERTISSEURS ---
            if (command === '.sticker' || command === '.s') {
                const mime = (quoted ? quoted[quotedType]?.mimetype : m.message[type]?.mimetype) || "";
                if (!mime.startsWith('image') && !mime.startsWith('video')) return sock.sendMessage(from, { text: "❌ Réponds à une image/vidéo." }, { quoted: m });
                try {
                    const messageToDownload = quoted ? { message: quoted } : m;
                    const buffer = await downloadMediaMessage(messageToDownload, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const tempFile = getRandom(mime.startsWith('image') ? '.jpg' : '.mp4');
                    const outputWebp = getRandom('.webp');
                    fs.writeFileSync(tempFile, buffer);
                    ffmpeg(tempFile)
                        .on('error', (err) => { fs.unlinkSync(tempFile); sock.sendMessage(from, { text: "❌ Erreur conversion." }, { quoted: m }); })
                        .on('end', async () => { await sock.sendMessage(from, { sticker: fs.readFileSync(outputWebp) }, { quoted: m }); fs.unlinkSync(tempFile); fs.unlinkSync(outputWebp); })
                        .addOutputOptions(["-vcodec", "libwebp", "-vf", "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"])
                        .toFormat('webp').save(outputWebp);
                } catch (e) { console.error(e); }
            }

            if (command === '.tomp3') {
                if (!quoted) return sock.sendMessage(from, { text: "❌ Réponds à un audio/vidéo." }, { quoted: m });
                const mime = quoted[quotedType]?.mimetype || "";
                if (!mime.includes('audio') && !mime.includes('video')) return;
                try {
                    await sock.sendMessage(from, { react: { text: '🎵', key: m.key } });
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const tempInput = getRandom(mime.includes('video') ? '.mp4' : '.ogg');
                    const tempOutput = getRandom('.mp3');
                    fs.writeFileSync(tempInput, buffer);
                    ffmpeg(tempInput).toFormat('mp3')
                        .on('end', async () => { await sock.sendMessage(from, { audio: fs.readFileSync(tempOutput), mimetype: 'audio/mp4', ptt: false }, { quoted: m }); fs.unlinkSync(tempInput); fs.unlinkSync(tempOutput); })
                        .on('error', () => { fs.unlinkSync(tempInput); })
                        .save(tempOutput);
                } catch (e) { console.error(e); }
            }

            if (command === '.toimage') {
                if (!quoted || quotedType !== 'stickerMessage') return sock.sendMessage(from, { text: "❌ Réponds à un sticker." }, { quoted: m });
                try {
                    await sock.sendMessage(from, { react: { text: '🖼️', key: m.key } });
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const tempInput = getRandom('.webp');
                    const tempOutput = getRandom('.png');
                    fs.writeFileSync(tempInput, buffer);
                    ffmpeg(tempInput).fromFormat('webp_pipe')
                        .on('end', async () => { await sock.sendMessage(from, { image: fs.readFileSync(tempOutput) }, { quoted: m }); fs.unlinkSync(tempInput); fs.unlinkSync(tempOutput); })
                        .on('error', (err) => { fs.unlinkSync(tempInput); sock.sendMessage(from, { text: "❌ Erreur (Sticker animé ?)." }, { quoted: m }); })
                        .save(tempOutput);
                } catch (e) { console.error(e); }
            }

            if (command === '.tovideo') {
                if (!quoted || quotedType !== 'stickerMessage') return sock.sendMessage(from, { text: "❌ Réponds à un sticker." }, { quoted: m });
                try {
                    await sock.sendMessage(from, { react: { text: '🎥', key: m.key } });
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const tempInput = getRandom('.webp');
                    const tempOutput = getRandom('.mp4');
                    fs.writeFileSync(tempInput, buffer);
                    ffmpeg(tempInput)
                        .on('end', async () => { await sock.sendMessage(from, { video: fs.readFileSync(tempOutput) }, { quoted: m }); fs.unlinkSync(tempInput); fs.unlinkSync(tempOutput); })
                        .on('error', (err) => { fs.unlinkSync(tempInput); sock.sendMessage(from, { text: "❌ Erreur." }, { quoted: m }); })
                        .inputFormat('webp').outputOptions(["-movflags faststart", "-pix_fmt yuv420p", "-vf scale=trunc(iw/2)*2:trunc(ih/2)*2"]).save(tempOutput);
                } catch (e) { console.error(e); }
            }

            if (command === '.tozip') {
                if (!quoted) return sock.sendMessage(from, { text: "❌ Réponds à un fichier." }, { quoted: m });
                try {
                    await sock.sendMessage(from, { react: { text: '📦', key: m.key } });
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    let ext = '.bin';
                    if (quoted[quotedType]?.mimetype) ext = '.' + quoted[quotedType].mimetype.split('/')[1].split(';')[0];
                    const zipName = getRandom('.zip');
                    const output = fs.createWriteStream(zipName);
                    const archive = archiver('zip', { zlib: { level: 9 } });
                    output.on('close', async function() { await sock.sendMessage(from, { document: fs.readFileSync(zipName), mimetype: 'application/zip', fileName: 'converted.zip' }, { quoted: m }); fs.unlinkSync(zipName); });
                    archive.pipe(output); archive.append(buffer, { name: `fichier${ext}` }); archive.finalize();
                } catch (e) { console.error(e); }
            }

            // --- MENU (QUEEN NEZUKO) ---
            if (command === '.menu') {
                const menu = `
╔════ஜ۩۞۩ஜ════╗
  ༈ 𝐐𝐔𝐄𝐄𝐍 𝐍𝐄𝐙𝐔𝐊𝐎 ༈ 💝
╚════ஜ۩۞۩ஜ════╝
══════ஜஜ══════
> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐎𝐖𝐍𝐄𝐑 ⌟
> ┃༆ .ᴍᴏᴅᴇ-ᴘᴜʙʟɪᴄ
> ┃༆ .ᴍᴏᴅᴇ-ᴘʀɪᴠᴀᴛᴇ
> ┃༆ .ʀᴇᴘᴏʀᴛ
> ┃༆ .ᴄʟᴇᴀʀᴄʜᴀᴛ
> ┃༆ .sᴇᴛᴘᴘ / .ʙᴀᴄᴋᴜᴘ
> ┃༆ .sᴜᴅᴏ / .ᴅᴇʟsᴜᴅᴏ
> ┃༆ .ʙʟᴏᴄᴋ / .ᴜɴʙʟᴏᴄᴋ
> ┃༆ .vv / .vv2
> ┗━━━━━━━━━━━━━━━─

> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐆𝐑𝐎𝐔𝐏 ⌟
> ┃༆ .ᴡᴇʟᴄᴏᴍᴇ ᴏɴ/ᴏғғ
> ┃༆ .ᴋɪᴄᴋ @ᴛᴀɢ
> ┃༆ .ᴋɪᴄᴋᴀʟʟ
> ┃༆ .ᴇᴠᴇʀʏᴏɴᴇ
> ┃༆ .ᴛᴀɢᴀʟʟ
> ┃༆ .ʜɪᴅᴇᴛᴀɢ
> ┃༆ .ʟᴇᴀᴠᴇɢᴄ
> ┃༆ .ɪɴᴠɪᴛᴇ
> ┃༆ .ɢᴇᴛɴᴀᴍᴇ
> ┃༆ .sᴇᴛᴘᴘɢᴄ
> ┃༆ .sᴠᴄᴏɴᴛᴀᴄᴛ
> ┃༆ .ʟɪsᴛᴏɴʟɪɴᴇ
> ┃༆ .ᴏᴘᴇɴɢʀᴏᴜᴘ
> ┃༆ .ᴄʟᴏsᴇɢʀᴏᴜᴘ
> ┃༆ .ᴡᴀʀɴ
> ┗━━━━━━━━━━━━━━━─

> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 ⌟
> ┃༆ .ᴘʟᴀʏ (Audio)
> ┃༆ .ᴘʟᴀʏᴅᴏᴄ
> ┃༆ .ᴠɪᴅᴇᴏ (Vidéo)
> ┃༆ .ᴠɪᴅᴇᴏᴅᴏᴄ
> ┃༆ .ᴛɪᴋᴛᴏᴋ
> ┃༆ .ғʙᴅʟ / .ɪɢᴅʟ
> ┃༆ .ᴛᴡɪᴛᴛᴇʀ
> ┗━━━━━━━━━━━━━━━─

> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐒𝐄𝐀𝐑𝐂𝐇 ⌟
> ┃༆ .ɪᴍᴀɢᴇ
> ┃༆ .ɢᴏᴏɢʟᴇ
> ┃༆ .ʟʏʀɪᴄs
> ┃༆ .ɢɪᴛʜᴜʙ
> ┃༆ .ɢsᴍᴀʀᴇɴᴀ
> ┃༆ .ʟɪᴠᴇᴡᴀʟʟᴘᴀᴘᴇʀ
> ┗━━━━━━━━━━━━━━━─

> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐓𝐎𝐎𝐋𝐒 ⌟
> ┃༆ .sᴛɪᴄᴋᴇʀ
> ┃༆ .ᴛᴏɪᴍᴀɢᴇ
> ┃༆ .ᴛᴏᴍᴘ3 / .ᴛᴏᴠɪᴅᴇᴏ
> ┃༆ .ᴛᴏᴢɪᴘ
> ┃༆ .ᴘᴇʀsᴏ (Logo)
> ┃༆ .ᴀᴜᴛᴏʀᴇᴀᴅ
> ┃༆ .ᴀᴜᴛᴏʙɪᴏ
> ┃༆ .ᴀɴᴛɪʟɪɴᴋ
> ┗━━━━━━━━━━━━━━━─

> ┏━━━━━━━━━━━━━━
> ┃༆ ⌜ 𝐓𝐄𝐗𝐓-𝐏𝐑𝐎 ⌟
> ┃༆ .ᴄᴀɴᴅʏ / .ᴄʜʀɪsᴛᴍᴀs
> ┃༆ .3ᴅᴄʜʀɪsᴛᴍᴀs
> ┃༆ .sᴘᴀʀᴋʟᴇᴄʜʀɪsᴛᴍᴀs
> ┃༆ .ᴅᴇᴇᴘsᴇᴀ / .sᴄɪғɪ
> ┃༆ .ʀᴀɪɴʙᴏᴡ / .ᴡᴀᴛᴇʀᴘɪᴘᴇ
> ┃༆ .sᴘᴏᴏᴋʏ / .ᴘᴇɴᴄɪʟ
> ┃༆ .ᴄɪʀᴄᴜɪᴛ / .ᴅɪsᴄᴏᴠᴇʀʏ
> ┃༆ .ᴍᴇᴛᴀʟɪᴄ / .ғɪᴄᴛɪᴏɴ
> ┃༆ .ᴅᴇᴍᴏɴ / .ᴛʀᴀɴsғᴏʀᴍᴇʀ
> ┃༆ .ʙᴇʀʀʏ / .ᴛʜᴜɴᴅᴇʀ
> ┃༆ .ᴍᴀɢᴍᴀ / .3ᴅsᴛᴏɴᴇ
> ┃༆ .ɴᴇᴏɴʟɪɢʜᴛ / .ɢʟɪᴛᴄʜ
> ┃༆ .ʜᴀʀʀʏᴘᴏᴛᴛᴇʀ
> ┃༆ .ʙʀᴏᴋᴇɴɢʟᴀss
> ┃༆ .ᴘᴀᴘᴇʀᴄᴜᴛ / .ᴡᴀᴛᴇʀᴄᴏʟᴏʀ
> ┃༆ .ᴍᴜʟᴛɪᴄᴏʟᴏʀ
> ┃༆ .ɴᴇᴏɴᴅᴇᴠɪʟ / .ᴜɴᴅᴇʀᴡᴀᴛᴇʀ
> ┃༆ .ɢʀᴀғғɪᴛɪʙɪᴋᴇ / .sɴᴏᴡ
> ┃༆ .ᴄʟᴏᴜᴅ / .ʜᴏɴᴇʏ
> ┃༆ .ɪᴄᴇ / .ғʀᴜɪᴛᴊᴜɪᴄᴇ
> ┃༆ .ʙɪsᴄᴜɪᴛ / .ᴡᴏᴏᴅ
> ┃༆ .ᴄʜᴏᴄᴏʟᴀᴛᴇ
> ┃༆ .sᴛʀᴀᴡʙᴇʀʀʏ
> ┃༆ .ᴍᴀᴛʀɪx / .ʙʟᴏᴏᴅ
> ┃༆ .ᴅʀᴏᴘᴡᴀᴛᴇʀ / .ᴛᴏxɪᴄ
> ┃༆ .ʟᴀᴠᴀ / .ʀᴏᴄᴋ
> ┃༆ .ʙʟᴏᴏᴅɢʟᴀs / .ʜᴀʟʟᴏᴡᴇɴ
> ┃༆ .ᴅᴀʀᴋɢᴏʟᴅ / .ᴊᴏᴋᴇʀ
> ┃༆ .ᴡɪᴄᴋᴇʀ / .ғɪʀᴇᴡᴏʀᴋ
> ┃༆ .sᴋᴇʟᴇᴛᴏɴ / .sᴀɴᴅ
> ┃༆ .ɢʟᴜᴇ / .1917 / .ʟᴇᴀᴠᴇs
> ┗━━━━━━━━━━━━━━━─`;

                // --- LISTE DES IMAGES ALÉATOIRES ---
                const menuImagesList = [
                    'https://i.imgur.com/PfkrQoC.jpeg',
                    'https://i.imgur.com/9ICWeNp.jpeg',
                    'https://i.imgur.com/eyvvn8q.jpeg',
                    'https://i.imgur.com/enMrVhF.jpeg',
                    'https://i.imgur.com/eIypn1L.jpeg'
                ];
                const randomImage = menuImagesList[Math.floor(Math.random() * menuImagesList.length)];

                // Envoi du message Menu + Image
                await sock.sendMessage(from, { 
                    image: { url: randomImage }, 
                    caption: menu 
                }, { quoted: m });

                // --- GESTION AUDIO ALÉATOIRE (Mode Musique) ---
                const menuAudioList = [
                    'emotion.mp3', 
                    'menu_song.mp3', 
                    'bgm_bot.mp3'
                ];
                const randomAudio = menuAudioList[Math.floor(Math.random() * menuAudioList.length)];
                const audioPath = './media/' + randomAudio;

                if (fs.existsSync(audioPath)) {
                    try {
                        const audioBuffer = fs.readFileSync(audioPath);
                        await sock.sendMessage(from, { 
                            audio: audioBuffer, 
                            mimetype: 'audio/mp4',
                            ptt: false 
                        }, { quoted: m });
                    } catch (err) {
                        console.error("Erreur envoi audio : ", err);
                    }
                }
            }

            // --- COMMANDES ADMIN & CONFIGURATION (ANTI) ---
            if (command === '.backup' && isCreator) {
                const output = fs.createWriteStream('backup.zip');
                const archive = archiver('zip', { zlib: { level: 9 } });
                output.on('close', async function() { await sock.sendMessage(from, { document: fs.readFileSync('backup.zip'), mimetype: 'application/zip', fileName: 'database_backup.zip' }, { quoted: m }); fs.unlinkSync('backup.zip'); });
                archive.pipe(output); archive.file('database.json', { name: 'database.json' }); archive.finalize();
            }

            // CONFIGURATION GLOBALE
            const globalSettings = ['.autotyping', '.autorecording', '.autoreact', '.autoviewstatus', '.autostatusreact', '.chatbot', '.autoread', '.alwaysonline', '.autobio'];
            if (globalSettings.includes(command)) {
                if (!isCreator) return sock.sendMessage(from, { text: "⛔ Propriétaire seulement." }, { quoted: m });
                
                if (['.autotyping', '.autorecording', '.autoreact'].includes(command)) {
                    const mode = args[0]?.toLowerCase();
                    const validModes = ['off', 'on', 'group', 'inbox', 'both'];
                    if (!validModes.includes(mode)) return sock.sendMessage(from, { text: `⚠️ Usage: ${command} <group/inbox/both/off>` }, { quoted: m });
                    db.settings[command.replace('.', '')] = mode === 'on' ? 'both' : mode;
                    saveDatabase(db);
                    await sock.sendMessage(from, { text: `✅ ${command} réglé sur : ${db.settings[command.replace('.', '')]}` }, { quoted: m });
                } else {
                    const settingKey = command.replace('.', '') + (command === '.chatbot' ? '_status' : '');
                    if (args[0] === 'on') {
                        db.settings[settingKey] = true;
                        if (command === '.alwaysonline') sock.sendPresenceUpdate('available');
                        if (command === '.autobio') await sock.updateProfileStatus("Bot Actif");
                        saveDatabase(db);
                        await sock.sendMessage(from, { text: `✅ ${command} activé !` }, { quoted: m });
                    } else if (args[0] === 'off') {
                        db.settings[settingKey] = false;
                        if (command === '.alwaysonline') sock.sendPresenceUpdate('unavailable');
                        saveDatabase(db);
                        await sock.sendMessage(from, { text: `❌ ${command} désactivé !` }, { quoted: m });
                    } else await sock.sendMessage(from, { text: `⚠️ Usage: ${command} on/off` }, { quoted: m });
                }
            }

            // CONFIGURATION GROUPE (ANTI)
            const antiCommands = ['.antilink-delete', '.antilink-warn', '.antilink-kick', '.antisticker', '.antimedia', '.antitemu', '.antispam', '.antimention', '.antitag', '.antinsfw', '.antibad'];
            if (antiCommands.includes(command)) {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Groupe seulement." }, { quoted: m });
                if (!isCreator && !isAdmin) return sock.sendMessage(from, { text: "⛔ Admins seulement." }, { quoted: m });

                const keyMap = { 
                    '.antilink-delete': 'antilink_delete', 
                    '.antilink-warn': 'antilink_warn', 
                    '.antilink-kick': 'antilink_kick', 
                    '.antisticker': 'antisticker', 
                    '.antimedia': 'antimedia', 
                    '.antitemu': 'antitemu', 
                    '.antispam': 'antispam', 
                    '.antimention': 'antimention', 
                    '.antitag': 'antitag', 
                    '.antinsfw': 'antinsfw', 
                    '.antibad': 'antibad' 
                };
                
                const settingKey = keyMap[command];
                if (args[0] === 'on') { 
                    db[from][settingKey] = true; 
                    saveDatabase(db); 
                    await sock.sendMessage(from, { text: `✅ ${settingKey} ACTIVÉ` }, { quoted: m }); 
                } else if (args[0] === 'off') { 
                    db[from][settingKey] = false; 
                    saveDatabase(db); 
                    await sock.sendMessage(from, { text: `❌ ${settingKey} DÉSACTIVÉ` }, { quoted: m }); 
                } else {
                    await sock.sendMessage(from, { text: `⚠️ Usage: ${command} on/off` }, { quoted: m });
                }
            }

            // GESTION MOTS INTERDITS
            if (command === '.addbadword' || command === '.delbadword') {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Groupe seulement." }, { quoted: m });
                if (!isCreator && !isAdmin) return sock.sendMessage(from, { text: "⛔ Admins seulement." }, { quoted: m });
                
                const textArg = args.join(' ');
                if (!textArg) return sock.sendMessage(from, { text: "⚠️ Précise le mot." }, { quoted: m });

                if (command === '.addbadword') { 
                    db[from].badwords.push(textArg); 
                    saveDatabase(db); 
                    await sock.sendMessage(from, { text: `✅ "${textArg}" ajouté aux mots interdits.` }); 
                } else { 
                    db[from].badwords = db[from].badwords.filter(w => w !== textArg); 
                    saveDatabase(db); 
                    await sock.sendMessage(from, { text: `🗑️ "${textArg}" retiré des mots interdits.` }); 
                }
            }

        } catch (e) {
            console.error("❌ Erreur traitement message:", e);
        }
    });
}

connectToWhatsApp();

// ==============================================
// FONCTION DE SCRAPING TEXTPRO (MOTEUR MAISON)
// ==============================================
const cheerio = require('cheerio');
const FormData = require('form-data');

async function textPro(url, text) {
    if (!/^https:\/\/textpro\.me\/.+\.html$/.test(url)) throw new Error("Url TextPro invalide");
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Cookie': '' // Sera rempli dynamiquement
    };

    // 1. Récupérer la page et le Token
    const getPage = await axios.get(url, { headers });
    const $ = cheerio.load(getPage.data);
    const token = $('input[name="__RequestVerificationToken"]').val();
    const cookie = getPage.headers['set-cookie']; // Récupérer les cookies de session
    
    if (!token) throw new Error("Token introuvable sur TextPro");

    // 2. Préparer le formulaire
    const form = new FormData();
    form.append('text[]', text);
    form.append('submit', 'Go');
    form.append('token', token);
    form.append('build_server', 'https://textpro.me');
    form.append('build_server_id', 1);

    // 3. Envoyer la demande de création
    const postData = await axios({
        url: 'https://textpro.me/effect/create-image',
        method: 'POST',
        data: form,
        headers: {
            ...headers,
            'Cookie': cookie,
            ...form.getHeaders()
        }
    });

    // 4. Récupérer le résultat JSON
    if (!postData.data.success) throw new Error(postData.data.info || "Erreur inconnue TextPro");
    
    const imageCode = postData.data.fullsize_image;
    const finalUrl = `https://textpro.me${imageCode}`;
    
    return finalUrl;
}