const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    downloadContentFromMessage,
    delay,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const pino = require('pino');

const execAsync = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.json());

// ==========================================
// BASE DE DATOS SLIM XIT v4.9
// ==========================================
const CLAVE_ACCESO = 'slim2026';
const FILE_DATA = path.join(process.cwd(), 'slim_xit_data.json');

const VERSION_ACTUAL = 'v3.7 Pro';
const VERSION_SIGUIENTE = 'v3.8';

let xitData = {
    linkCubanMods: 'https://www.mediafire.com/file_premium/r4y5l07gkdqy7rk/Cuban-Mods-9.10.apks/file', 
    linkProxy: 'https://proxycuban.com/downloads/android/cuban-proxy.apk', 
    linkFreeFire: 'https://www.mediafire.com/file/bly39zmswdekijf/Free+Fire+MAX_2.126.1_APKPure.xapk/file', 
    linkGratis: 'https://www.mediafire.com/file/ejemplo_gratis/file',
    linkFakeLag: 'https://www.mediafire.com/file/ejemplo_fakelag/file',
    linkHolograma: 'https://www.mediafire.com/file/ejemplo_holograma/file',
    usuariosAutorizados: [],
    ownersAutorizados: [],
    usuariosBaneados: [],
    usuariosRegistro: {}, 
    respuestasAuto: {},
    advertencias: {} 
};

let ultimaKeyReset = '';

function cargarDatos() {
    try {
        if (fs.existsSync(FILE_DATA)) {
            const raw = fs.readFileSync(FILE_DATA, 'utf-8');
            xitData = { ...xitData, ...JSON.parse(raw) };
        } else {
            guardarDatos();
        }
    } catch (e) {
        console.log('Error cargando base de datos:', e);
    }
}

function guardarDatos() {
    try {
        fs.writeFileSync(FILE_DATA, JSON.stringify(xitData, null, 2), 'utf-8');
    } catch (e) {
        console.log('Error guardando base de datos:', e);
    }
}

cargarDatos();

global.botActivo = true;
global.mantenimientoActivo = false;

function getTmp() {
    const dir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function bajarMedia(msgMedia, tipo) {
    const stream = await downloadContentFromMessage(msgMedia, tipo);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

let sock = null;
let currentQR = null;
let isConnected = false;

async function startBot(forceReset = false) {
    const authFolder = 'auth_info_session';

    if (forceReset) {
        if (sock) {
            try { sock.ws.close(); } catch(e){}
            sock = null;
        }
        if (fs.existsSync(authFolder)) {
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e){}
        }
    }

    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.macOS("Desktop"),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQR = await QRCode.toDataURL(qr);
                io.emit('qr', currentQR);
            } catch (err) {
                console.error('Error QR:', err);
            }
        }

        if (connection === 'open') {
            console.log(`✅ ¡SLIM XIT BOT CONECTADO Y CORRIENDO CON ÉXITO!`);
            isConnected = true;
            currentQR = null;
            const phone = sock.user.id.split(':')[0];
            io.emit('status', { connected: true, phone });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const deberiaReconectar = statusCode !== DisconnectReason.loggedOut;
            console.log(`🔄 Conexión cerrada. Status: ${statusCode}. ¿Reconectando?:`, deberiaReconectar);
            io.emit('status', { connected: false });

            if (deberiaReconectar) {
                await delay(3000);
                startBot();
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const esGrupo = from.endsWith('@g.us');
            const cuerpo = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            
            if (!cuerpo.startsWith('.')) return;

            const args = cuerpo.slice(1).trim().split(/\s+/);
            const cmd = args.shift().toLowerCase();
            const texto = args.join(' ');

            const esOwnerChat = msg.key.fromMe; 
            let esUserAdmin = false;
            let esBotAdmin = false;

            if (esGrupo) {
                const metadata = await sock.groupMetadata(from);
                const participantes = metadata.participants;
                const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                
                const userAdminCheck = participantes.find(p => p.id === (msg.key.participant || from));
                const botAdminCheck = participantes.find(p => p.id === botJid);

                esUserAdmin = userAdminCheck?.admin === 'admin' || userAdminCheck?.admin === 'superadmin';
                esBotAdmin = botAdminCheck?.admin === 'admin' || botAdminCheck?.admin === 'superadmin';
            }

            const deMismo = msg.key.participant || from;

            await atenderComandos(sock, from, msg, cmd, texto, esOwnerChat, esGrupo, esUserAdmin, esBotAdmin, deMismo);

        } catch (err) {
            console.log('Error procesando mensaje:', err);
        }
    });
}

// Iniciar bot al arrancar servidor
startBot();

// ==========================================
// FUNCIÓN DE COMANDOS COMPLETA DE SLIM XIT
// ==========================================
async function atenderComandos(sock, from, msg, cmd, texto, esOwnerChat, esGrupo, esUserAdmin, esBotAdmin, deMismo) {
    let realFrom = (typeof from === 'string' && from.includes('@')) ? from : (from?.key?.remoteJid || msg?.key?.remoteJid);
    
    const reply = async (txt) => {
        if (!realFrom) return console.log("⚠️ Destino no válido.");
        const opcionesReply = (msg && typeof msg === 'object' && msg.key) ? { quoted: msg } : {};
        return await sock.sendMessage(realFrom, { text: txt }, opcionesReply);
    };

    let remitente = (typeof deMismo === 'string' && deMismo.includes('@')) ? deMismo : null;
    if (!remitente) remitente = msg?.key?.participant || msg?.key?.remoteJid || realFrom;
    if (!remitente || typeof remitente !== 'string' || !remitente.includes('@')) remitente = realFrom;

    if (xitData.usuariosBaneados.includes(remitente) && !esOwnerChat) return;
    if (xitData.usuariosBaneados.includes(realFrom) && !esOwnerChat) return;
    if (!global.botActivo && !esOwnerChat) return;

    if (global.mantenimientoActivo && !esOwnerChat) {
        const comandosComunes = ['menu', 'help', 'ayuda', 'cubanmods', 'proxy', 'gratis', 'fakelag', 'holograma', 'mp3', 'mp4', 'sticker', 's'];
        if (comandosComunes.includes(cmd) || !esGrupo) {
            return await reply(`🚧 ─── *SLIM XIT SYSTEM* ─── 🚧\n\nEl bot se encuentra actualmente bajo mantenimiento global. Espera la versión *${VERSION_SIGUIENTE}*.`);
        }
    }

    if (cmd === 'registro') {
        const nombreRegistrar = texto ? texto.trim() : "Usuario Slim";
        if (!xitData.usuariosRegistro) xitData.usuariosRegistro = {};
        
        xitData.usuariosRegistro[remitente] = nombreRegistrar;
        guardarDatos();
        return await reply(`✨ 🟢 *¡REGISTRO EXITOSO!* 🟢 ✨\n\n👤 Registrado en el sistema como: *${nombreRegistrar}*`);
    }

    else if (cmd === 'unregistro') {
        if (!xitData.usuariosRegistro || !xitData.usuariosRegistro[remitente]) {
            return await reply('⚠️ No estás registrado en la base de datos de este bot.');
        }
        delete xitData.usuariosRegistro[remitente];
        if (!xitData.usuariosBaneados.includes(remitente)) {
            xitData.usuariosBaneados.push(remitente);
        }
        guardarDatos();
        return await reply('👋 *PROCESO COMPLETADO:* Tu registro ha sido eliminado y tu ID ha sido bloqueada de forma permanente.');
    }

    else if (cmd === 'proxy') {
        let respuestaDecorada = `⚡ ─── *SLIM XIT PROXY SYSTEM* ─── ⚡\n\n` +
                                `🟢 *ESTADO:* Enlaces Libres de Acceso Público\n\n` +
                                `📦 *LINK DIRECTO CUBAN PROXY APK:*\n» ${xitData.linkProxy}\n\n` +
                                `🔥 *LINK DIRECTO FREE FIRE MAX XAPK:*\n» ${xitData.linkFreeFire}\n\n` +
                                `🔑 *SITIO GENERADOR DE KEYS PROXY:*\n» https://cubanmods.com/keygratis.php\n\n` +
                                `✨ ────────────────────────── ✨`;
        return await reply(respuestaDecorada);
    }

    else if (cmd === 'gratis') {
        let menuGratis = `🎁 ─── *SLIM XIT FREE MODS* ─── 🎁\n\n` +
                         `🟢 *ENLACES LIBRES DISPONIBLES DE HOY:*\n\n` +
                         `📂 *APK MOD GRATUITO:*\n» ${xitData.linkGratis}\n\n` +
                         `🔄 _Nota: Este enlace se cambia cada 24 horas._\n\n` +
                         `⚠️ *ADVERTENCIA GENERAL:*\n` +
                         `Recuerda que los hacks empiezan a dar ban después de 12 o 24 horas. 🎉`;
        return await reply(menuGratis);
    }

    else if (cmd === 'fakelag') {
        let menuLag = `🛡️ ─── *SLIM XIT FAKE LAG FULL* ─── 🛡️\n\n` +
                      `🟢 *ENLACE DE DESCARGA DIRECTA (FF):*\n» ${xitData.linkFakeLag}\n\n` +
                      `⏳ _Actualización periódica: Cada 5 a 7 días según el parche._\n\n` +
                      `⚠️ *ADVERTENCIA DE SEGURIDAD:*\n` +
                      `Los archivos inyectados o modificaciones externas empiezan a dar ban tras 12 o 24 horas de uso continuo. Úsalo bajo tu propio riesgo.`;
        return await reply(menuLag);
    }

    else if (cmd === 'holograma') {
        let menuHolo = `🔮 ─── *SLIM XIT HOLOGRAMA FF* ─── 🔮\n\n` +
                       `🟢 *ENLACE DE DESCARGA DIRECTA:*\n» ${xitData.linkHolograma}\n\n` +
                       `⏳ _Actualización periódica: Sincronizado cada 5 a 7 días de forma manual._\n\n` +
                       `⚠️ *ADVERTENCIA DE SEGURIDAD:*\n` +
                       `Los complementos visuales pesados causan reportes directos y baneo seguro entre las 12 y 24 horas posteriores.`;
        return await reply(menuHolo);
    }

    else if (cmd === 'reset') {
        if (!texto) return reply('⚠️ Uso: .reset [Tu Key]');
        ultimaKeyReset = texto.trim();
        return await reply('⏳ *Procesando Reset local...* En un estimado de 2 minutos se le da reset a tu key.');
    }

    else if (cmd === 'menu' || cmd === 'help' || cmd === 'ayuda') {
        if (!xitData.usuariosAutorizados.includes(remitente) && !xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) {
            return await reply('❌ *ACCESO DENEGADO:* Requieres activar el menú primero. Usa el comando:\n\n» `.key slim2026`');
        }

        let menuCompleto = `✨ *Slim XIT* desarrollado por Slim ૮(˶ᵔᵕᵔ˶)as\n\n` +
                           `🔒 *PRIVACIDAD ACTIVA:* ON 🤫\n\n` +
                           `╭質ࣶ፝֟╾╌ֵ╾͜─ํ͜┈ְ ࣭࣪⢏\n│👑 MODO PERSONAL SLIM\n├╾\n` +
                           `│✿ .registro -> Registrar tu nombre/apodo\n│✿ .unregistro -> Darte de baja y auto-banearte\n│✿ .cubanmods -> Enlaces directos de Cuban Mods\n│✿ .proxy -> Enlaces de descarga Proxy & FF Max\n│✿ .gratis -> Enlaces de APKs Gratuitas Diarias\n│✿ .fakelag -> Fake Lags Full actualizados\n│✿ .holograma -> Hologramas FF actualizados\n│✿ .info -> Detalles del bot\n│✿ .soporte -> Contacto de soporte\n╰質ࣶ፝֟╾╌ֵ╾͜─ํ͜┈ְ ࣭࣪⢏╯\n\n` +
                           `╭質ࣶ፝֟╾╌ֵ╾͜─ํ͜┈ְ ࣭࣪⢏\n│❀ Multimedia y Descargas\n├╾\n` +
                           `│✿ .mp3 + <enlace o NOMBRE/ARTISTA>\n│✿ .mp4 + <enlace o NOMBRE/ARTISTA>\n│✿ .sticker / .s -> Convierte imagen citada/enviada\n╰質፝֟࢏╾⢏╯\n\n` +
                           `╭質ࣶ፝֟╾╌ֵ╾͜─ํ͜┈ְ ࣭࣪⢏\n│❀ Gestión de Grupo (Solo Admins)\n├╾\n` +
                           `│✿ .promover | .degradar | .expulsar\n│✿ .advertir | .advertencias\n│✿ .abrir | .cerrar\n╰質ࣶ፝֟╾⢏╯`;
        await reply(menuCompleto);
    }

    else if (cmd === 'contraseña' || cmd === 'key') {
        const claveIngresada = texto ? texto.trim() : '';
        if (claveIngresada === '2') {
            if (xitData.ownersAutorizados.includes(remitente)) return reply('⚠️ Ya eres Administrador Principal.');
            xitData.ownersAutorizados.push(remitente); 
            guardarDatos();
            return await reply('👑 *MODO ADMINISTRADOR SUPREMO CONCEDIDO*');
        }
        if (claveIngresada === CLAVE_ACCESO) {
            if (xitData.usuariosAutorizados.includes(remitente)) return reply('⚠️ Tu acceso ya se encontraba activo.');
            xitData.usuariosAutorizados.push(remitente); 
            guardarDatos();
            await reply('✅ *ACCESO AL MENÚ OTORGADO CORRECTAMENTE*');
        } else { 
            reply('❌ *Contraseña Inválida.*'); 
        }
    }

    else if (cmd === 'usuarios') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ No eres Administrador.');
        if (!xitData.usuariosRegistro) xitData.usuariosRegistro = {};
        const totalReg = Object.keys(xitData.usuariosRegistro).length;
        return await reply(`📊 *Base de Datos Slim XIT:* Total registrados: *${totalReg}*`);
    }

    else if (cmd === 'cubanmods') {
        let msgLinks = `📦 ─── *SISTEMA CUBAN MODS LIBERADO* ─── 📦\n\n` +
                       `🚀 *LINK DIRECTO DE DESCARGA APK (Original):*\n» ${xitData.linkCubanMods}\n\n` +
                       `🔑 *SITIO GENERADOR DE KEYS GRATIS:*\n» https://cubanmods.com/keygratis.php\n\n` +
                       `⚙️ Descarga la aplicación de forma libre e instálala en tu terminal con ZArchiver.`;
        return await reply(msgLinks);
    }

    else if (cmd === 'mantenimiento') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ No autorizado.');
        global.mantenimientoActivo = true;
        return await reply('🚧 *MANTENIMIENTO ACTIVADO:* Todos los chats externos y grupos han sido congelados.');
    }

    else if (cmd === 'unmantenimiento') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ No autorizado.');
        global.mantenimientoActivo = false;
        return await reply('🚀 *MANTENIMIENTO DESACTIVADO:* El bot vuelve a estar disponible.');
    }

    else if (cmd === 'espejo') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ No autorizado.');
        global.modoEspejoActivo = !global.modoEspejoActivo;
        return await reply(`🔮 *MODO ESPEJO:* ${global.modoEspejoActivo ? 'ACTIVADO 🟢' : 'DESACTIVADO 🔴'}`);
    }

    else if (cmd === 'mensaje') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return;
        const listaUsuarios = Object.keys(xitData.usuariosRegistro || {}).filter(jid => jid && jid.includes('@'));
        await reply(`⏳ *Enviando aviso Cuban Mods a ${listaUsuarios.length} usuarios...*`);
        for (let userJid of listaUsuarios) {
            try {
                let msgDecorado = `🚨 ─── *AVISO IMPORTANTE CUBAN MODS* ─── 🚨\n\n📢 *ATENCIÓN AL CLIENTE:*\n\n» ${texto.trim()}\n\n✨ ────────────────────────── ✨`;
                await sock.sendMessage(userJid, { text: msgDecorado });
                await new Promise(res => setTimeout(res, 1000));
            } catch (e) {}
        }
        return await reply('✅ *Aviso de mantenimiento enviado correctamente.*');
    }

    else if (cmd === 'actualizar') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return;
        const listaUsuarios = Object.keys(xitData.usuariosRegistro || {}).filter(jid => jid && jid.includes('@'));
        await reply(`⏳ *Propagando reapertura Cuban Mods...*`);
        for (let userJid of listaUsuarios) {
            try {
                let msgDecorado = `🚀 ─── *CUBAN MODS RESTABLECIDO* ─── 🚀\n\n⚡ El APK se encuentra completamente disponible y funcional de nuevo.\n\n🔗 *Link de descarga directa:*\n» ${xitData.linkCubanMods}\n\n✨ ¡Gracias por su paciencia! ✨`;
                await sock.sendMessage(userJid, { text: msgDecorado });
                await new Promise(res => setTimeout(res, 1000));
            } catch (e) {}
        }
        return await reply('✅ *Aviso de actualización propagado exitosamente.*');
    }

    else if (cmd === 'cambiar') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ No autorizado.'); 
        if (!texto) return reply('⚠️ Uso: .cambiar [mods / proxy / ff / gratis / fakelag / holograma] [Link]');
        
        const args = texto.trim().split(/\s+/);
        const tipo = args[0].toLowerCase();
        const urlLink = args[1];

        if (!urlLink) return reply('⚠️ Falta indicar el enlace URL.');

        if (tipo === 'mods') {
            xitData.linkCubanMods = urlLink; guardarDatos();
            await reply(`✅ *Link de Cuban Mods Actualizado:* \n${xitData.linkCubanMods}`);
        } else if (tipo === 'proxy') {
            xitData.linkProxy = urlLink; guardarDatos();
            await reply(`✅ *Link de Cuban Proxy Actualizado:* \n${xitData.linkProxy}`);
        } else if (tipo === 'ff') {
            xitData.linkFreeFire = urlLink; guardarDatos();
            await reply(`✅ *Link de Free Fire MAX Actualizado:* \n${xitData.linkFreeFire}`);
        } else if (tipo === 'gratis') {
            xitData.linkGratis = urlLink; guardarDatos();
            await reply(`✅ *Link de APKs Gratuitas Actualizado:* \n${xitData.linkGratis}`);
        } else if (tipo === 'fakelag') {
            xitData.linkFakeLag = urlLink; guardarDatos();
            await reply(`✅ *Link de Fake Lag Actualizado:* \n${xitData.linkFakeLag}`);
        } else if (tipo === 'holograma') {
            xitData.linkHolograma = urlLink; guardarDatos();
            await reply(`✅ *Link de Holograma FF Actualizado:* \n${xitData.linkHolograma}`);
        } else {
            await reply('❌ Subcomando inválido.');
        }
    }

    else if (cmd === 'ban') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return;
        let infoContexto = msg?.message?.extendedTextMessage?.contextInfo;
        let target = infoContexto?.mentionedJid?.[0] || infoContexto?.participant || realFrom;
        if (!target) return reply('❌ ID indetectable.');
        if (!xitData.usuariosBaneados.includes(target)) { 
            xitData.usuariosBaneados.push(target); 
            guardarDatos();
        }
        await reply(`🚫 ID Baneado del Sistema: ${target}`);
    }

    else if (cmd === 'unban') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return;
        let infoContexto = msg?.message?.extendedTextMessage?.contextInfo;
        let target = infoContexto?.mentionedJid?.[0] || infoContexto?.participant || realFrom;
        xitData.usuariosBaneados = xitData.usuariosBaneados.filter(u => u !== target); 
        guardarDatos();
        await reply(`✅ ID Desbaneado: ${target}`);
    }

    else if (cmd === 'slimxit') {
        if (!xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('❌ Acceso Restringido.');
        let panelAdminTxt = `⚙ *PANEL ADMINISTRATIVO REDISEÑADO SLIM XIT* ⚙\n\n` +
                            `• *ban / unban* -> Control de IDs\n` +
                            `• *cambiar [tipo] [Enlace]* -> Configurar URLs\n` +
                            `• *listo / error* -> Reset de keys\n` +
                            `• *mantenimiento / unmantenimiento* -> Bloqueos\n\n` +
                            `📢 *COMUNICADOS:*\n` +
                            `• *.mensaje [texto]* | *.actualizar* -> Cuban Mods\n` +
                            `• *.global [texto]* -> Difusión general`;
        return await reply(panelAdminTxt);
    }

    else if (cmd === 'listo' && (xitData.ownersAutorizados.includes(remitente) || esOwnerChat)) {
        if (!ultimaKeyReset) return reply('⚠️ No hay key en espera.');
        await reply(`✅ Tu key *${ultimaKeyReset}* ha sido reseteada.`);
        ultimaKeyReset = '';
    }

    else if (cmd === 'error' && (xitData.ownersAutorizados.includes(remitente) || esOwnerChat)) {
        if (!ultimaKeyReset) return reply('⚠️ No hay key en espera.');
        await reply(`❌ Tu key *${ultimaKeyReset}* no se pudo resetear.`);
        ultimaKeyReset = ''; 
    }

    else if (cmd === 'mp3') {
        if (!texto) return reply('⚠️ Uso: .mp3 [Nombre o Enlace]');
        await reply('⏳ *Procesando audio...*');
        try {
            let resDescarga = await axios.get(`https://api.lolhuman.xyz/api/ytplay2?apikey=GataDios&query=${encodeURIComponent(texto)}`);
            let audioUrl = resDescarga.data.result.audio;
            await sock.sendMessage(realFrom, { audio: { url: audioUrl }, mimetype: 'audio/mp4' }, { quoted: msg });
        } catch (e) { await reply('❌ Error al obtener el archivo de audio.'); }
    }

    else if (cmd === 'mp4') {
        if (!texto) return reply('⚠️ Uso: .mp4 [Nombre o Enlace]');
        await reply('⏳ *Procesando video...*');
        try {
            let resDescarga = await axios.get(`https://api.lolhuman.xyz/api/ytplay2?apikey=GataDios&query=${encodeURIComponent(texto)}`);
            let videoUrl = resDescarga.data.result.video;
            await sock.sendMessage(realFrom, { video: { url: videoUrl }, mimetype: 'video/mp4' }, { quoted: msg });
        } catch (e) { await reply('❌ Error al obtener el archivo de video.'); }
    }

    else if (cmd === 'sticker' || cmd === 's') {
        const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
        const tipoImagen = citado?.imageMessage || citado?.viewOnceMessage?.message?.imageMessage;
        if (!tipoImagen) return reply('⚠️ Responde a una imagen con .s o .sticker');
        const rutaInput = path.join(getTmp(), `img_${Date.now()}.jpg`);
        const outSticker = path.join(getTmp(), `st_${Date.now()}.webp`);
        try {
            const bufferImagen = await bajarMedia(tipoImagen, 'image');
            fs.writeFileSync(rutaInput, bufferImagen);
            await execAsync(`ffmpeg -i "${rutaInput}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000" -loop 0 -an "${outSticker}"`);
            await sock.sendMessage(realFrom, { sticker: fs.readFileSync(outSticker) }, { quoted: msg });
        } catch (e) { await reply('❌ Falló la conversión a sticker.'); } 
        finally {
            if (fs.existsSync(rutaInput)) fs.unlinkSync(rutaInput);
            if (fs.existsSync(outSticker)) fs.unlinkSync(outSticker);
        }
    }

    else if (['promover', 'degradar', 'expulsar', 'privacy', 'abrir', 'cerrar', 'advertir', 'advertencias'].includes(cmd)) {
        if (!esGrupo) return reply('⚠️ Comando exclusivo para grupos.');
        if (!esUserAdmin && !xitData.ownersAutorizados.includes(remitente) && !esOwnerChat) return reply('⚠️ Requiere Rango Admin.');
        
        if (cmd === 'abrir') {
            if (!esBotAdmin) return reply('❌ El bot necesita ser Admin.');
            await sock.groupSettingUpdate(realFrom, 'not_announcement'); return await reply('🔓 *Grupo Abierto*');
        }
        if (cmd === 'cerrar') {
            if (!esBotAdmin) return reply('❌ El bot necesita ser Admin.');
            await sock.groupSettingUpdate(realFrom, 'announcement'); return await reply('🔒 *Grupo Cerrado*');
        }

        let infoContexto = msg?.message?.extendedTextMessage?.contextInfo;
        let objetivoJid = infoContexto?.mentionedJid?.[0] || infoContexto?.participant;

        if (!objetivoJid || typeof objetivoJid !== 'string' || !objetivoJid.includes('@')) return reply('⚠️ Etiqueta a alguien con el @ o responde a su mensaje.');
        if (!xitData.advertencias) xitData.advertencias = {};

        switch (cmd) {
            case 'promover': await sock.groupParticipantsUpdate(realFrom, [objetivoJid], 'promote'); break;
            case 'degradar': await sock.groupParticipantsUpdate(realFrom, [objetivoJid], 'demote'); break;
            case 'expulsar': await sock.groupParticipantsUpdate(realFrom, [objetivoJid], 'remove'); break;
            case 'advertir':
                if (!xitData.advertencias[objetivoJid]) xitData.advertencias[objetivoJid] = 0;
                xitData.advertencias[objetivoJid] += 1; guardarDatos();
                await reply(`⚠️ *ADVERTENCIA:* @${objetivoJid.split('@')[0]} lleva ${xitData.advertencias[objetivoJid]}/3 reportes.`);
                if (xitData.advertencias[objetivoJid] >= 3 && esBotAdmin) {
                    await sock.groupParticipantsUpdate(realFrom, [objetivoJid], 'remove');
                    xitData.advertencias[objetivoJid] = 0; guardarDatos();
                    await reply(`🚫 Usuario removido por acumular 3 advertencias.`);
                }
                break;
            case 'advertencias':
                await reply(`📊 Advertencias registradas: ${xitData.advertencias[objetivoJid] || 0}`);
                break;
        }
    }
}

// ==========================================
// 🌐 PANEL WEB CON SOCKET.IO EN TIEMPO REAL
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>slim whatsapp bot</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .card { background: #111b21; padding: 25px; border-radius: 12px; width: 100%; max-width: 440px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; border: 1px solid #222d34; }
            h2 { color: #00a884; margin-bottom: 5px; font-size: 1.6rem; text-transform: lowercase; }
            .subtitle { font-size: 0.85rem; color: #8696a0; margin-bottom: 20px; }
            label { display: block; text-align: left; margin: 10px 0 5px; font-size: 0.85rem; color: #8696a0; }
            input { width: 100%; padding: 12px; margin-bottom: 15px; border-radius: 8px; border: 1px solid #2a3942; background: #111b21; color: #fff; box-sizing: border-box; outline: none; }
            button { width: 100%; padding: 12px; background: #00a884; color: #111b21; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; transition: 0.2s; margin-top: 8px; }
            button:hover { background: #029071; }
            .btn-reset { background: #202c33; color: #f15c6d; border: 1px solid #2a3942; }
            .code-box { font-size: 2.2rem; font-weight: bold; letter-spacing: 5px; color: #00a884; background: #202c33; padding: 15px; border-radius: 8px; margin-top: 15px; border: 1px dashed #00a884; user-select: all; }
            #qr-container { margin-top: 15px; display: flex; justify-content: center; align-items: center; flex-direction: column; }
            #qr-container img { width: 230px; height: 230px; border-radius: 8px; background: white; padding: 10px; }
            .status-badge { font-size: 0.95rem; font-weight: bold; padding: 10px; border-radius: 8px; margin-bottom: 15px; background: #182229; border: 1px solid #222d34; }
            .badge-online { color: #00a884; }
            .badge-offline { color: #f15c6d; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>slim whatsapp bot</h2>
            <div class="subtitle">Panel de Control En Vivo 24/7</div>

            <div class="status-badge" id="statusBadge">
                ESTADO: <span class="badge-offline" id="statusText">🔴 DESCONECTADO</span>
            </div>

            <label>Número de Teléfono (con clave de país):</label>
            <input type="text" id="phone" placeholder="Ej México: 521612... | Cuba: 53... (Sin + ni espacios)">

            <button onclick="requestPairingCode()">Obtener Código de 8 Dígitos Real</button>
            <button onclick="requestQR()" style="background: #202c33; color: #e9edef;">Generar Código QR En Vivo</button>
            <button onclick="resetSession()" class="btn-reset">🧹 Desconectar / Limpiar Sesión</button>

            <div id="result"></div>
        </div>

        <script>
            const socket = io();

            socket.on('connect', () => {
                console.log('Conectado al servidor WebSocket');
            });

            socket.on('status', (data) => {
                const badge = document.getElementById('statusText');
                if (data.connected) {
                    badge.className = 'badge-online';
                    badge.innerText = '🟢 CONECTADO (' + data.phone + ')';
                    document.getElementById('result').innerHTML = '<p style="color:#00a884; font-weight:bold; margin-top:15px;">¡Bot activado y respondiendo en WhatsApp!</p>';
                } else {
                    badge.className = 'badge-offline';
                    badge.innerText = '🔴 DISPONIBLE PARA VINCULAR';
                }
            });

            socket.on('qr', (qrData) => {
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = '<div id="qr-container"><img src="' + qrData + '" alt="QR Code"><p style="font-size:0.85rem; color:#8696a0; margin-top:8px;">Escanea inmediatamente desde WhatsApp > Dispositivos vinculados</p></div>';
            });

            async function requestPairingCode() {
                const phone = document.getElementById('phone').value;
                const resultDiv = document.getElementById('result');

                if(!phone || phone.length < 8) { 
                    alert('Ingresa tu número con código de país. Ej: 521612... o 53...'); 
                    return; 
                }

                resultDiv.innerHTML = '<p style="color:#8696a0;">Solicitando código oficial a WhatsApp...</p>';

                try {
                    const res = await fetch('/pair-code', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ phone })
                    });
                    const data = await res.json();

                    if(data.code) {
                        resultDiv.innerHTML = '<p style="margin-top:15px; color:#8696a0;">Ingresa este código en tu celular:</p>' +
                                              '<div class="code-box">' + data.code + '</div>' +
                                              '<p style="font-size:0.8rem; color:#8696a0; margin-top:8px;">WhatsApp > Dispositivos vinculados > Vincular con el número de teléfono</p>';
                    } else {
                        resultDiv.innerHTML = '<p style="color:#f15c6d; margin-top:15px;">Error: ' + (data.error || 'No se pudo generar el código.') + '</p>';
                    }
                } catch(e) {
                    resultDiv.innerHTML = '<p style="color:#f15c6d; margin-top:15px;">Error al conectar con el servidor.</p>';
                }
            }

            async function requestQR() {
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = '<p style="color:#8696a0;">Generando Código QR en vivo...</p>';
                await fetch('/start-qr', { method: 'POST' });
            }

            async function resetSession() {
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = '<p style="color:#8696a0;">Limpiando sesión...</p>';
                await fetch('/reset', { method: 'POST' });
                resultDiv.innerHTML = '<p style="color:#00a884;">✅ Sesión limpiada. Ahora puedes vincular nuevamente.</p>';
            }
        </script>
    </body>
    </html>
    `);
});

app.post('/pair-code', async (req, res) => {
    const { phone } = req.body;
    try {
        let cleanedNumber = phone.replace(/[^0-9]/g, '');

        if (!cleanedNumber || cleanedNumber.length < 8) {
            return res.status(400).json({ error: 'Número de teléfono inválido.' });
        }

        // Formateo automático de México (52 -> 521)
        if (cleanedNumber.startsWith('52') && !cleanedNumber.startsWith('521') && cleanedNumber.length === 12) {
            cleanedNumber = '521' + cleanedNumber.slice(2);
        }

        if (!sock || isConnected) {
            await startBot(true);
            await delay(3000);
        }

        const code = await sock.requestPairingCode(cleanedNumber);
        console.log(`🔑 Código oficial de WhatsApp emitido para ${cleanedNumber}: ${code}`);
        res.json({ code });
    } catch (err) {
        console.error('Error Pair Code:', err);
        res.status(500).json({ error: 'Error solicitando código a WhatsApp. Presiona "Limpiar Sesión" e intenta nuevamente.' });
    }
});

app.post('/start-qr', async (req, res) => {
    try {
        await startBot(true);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    await startBot(true);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.emit('status', { connected: isConnected, phone: sock?.user?.id?.split(':')[0] || null });
    if (currentQR) {
        socket.emit('qr', currentQR);
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor Slim XIT corriendo en el puerto ${PORT}`);
});
