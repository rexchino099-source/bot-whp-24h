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

// BASE DE DATOS SLIM XIT v4.9
const FILE_DATA = path.join(process.cwd(), 'slim_xit_data.json');
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

function cargarDatos() {
    try {
        if (fs.existsSync(FILE_DATA)) {
            const raw = fs.readFileSync(FILE_DATA, 'utf-8');
            xitData = { ...xitData, ...JSON.parse(raw) };
        }
    } catch (e) { console.log('Error cargando BD:', e); }
}

function guardarDatos() {
    try { fs.writeFileSync(FILE_DATA, JSON.stringify(xitData, null, 2), 'utf-8'); } 
    catch (e) { console.log('Error guardando BD:', e); }
}

cargarDatos();

global.botActivo = true;
global.mantenimientoActivo = false;

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

    // Identificación estricta como Computadora Mac OS + Chrome para evitar rechazo de WhatsApp
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.macOS("Chrome"),
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
            } catch (err) {}
        }

        if (connection === 'open') {
            console.log(`✅ ¡SLIM XIT BOT CONECTADO Y ACTIVO EN WHATSAPP!`);
            isConnected = true;
            currentQR = null;
            const phone = sock.user.id.split(':')[0];
            io.emit('status', { connected: true, phone });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const deberiaReconectar = statusCode !== DisconnectReason.loggedOut;
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
            const cuerpo = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!cuerpo.startsWith('.')) return;

            const args = cuerpo.slice(1).trim().split(/\s+/);
            const cmd = args.shift().toLowerCase();
            const texto = args.join(' ');

            if (cmd === 'menu' || cmd === 'help') {
                await sock.sendMessage(from, { text: `✨ *Slim XIT WhatsApp Bot Active 24/7*\n\n.cubanmods\n.proxy\n.gratis\n.fakelag\n.holograma\n.mp3 [cancion]\n.mp4 [cancion]` }, { quoted: msg });
            }
        } catch (e) {}
    });
}

startBot();

// PANEL WEB CON SOCKET.IO
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
            body { font-family: sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .card { background: #111b21; padding: 25px; border-radius: 12px; width: 100%; max-width: 420px; text-align: center; border: 1px solid #222d34; }
            h2 { color: #00a884; margin-bottom: 5px; }
            input { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #2a3942; background: #111b21; color: #fff; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #00a884; color: #111b21; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; margin-top: 8px; }
            .code-box { font-size: 2.2rem; font-weight: bold; letter-spacing: 5px; color: #00a884; background: #202c33; padding: 15px; border-radius: 8px; margin-top: 15px; border: 1px dashed #00a884; }
            #qr-container img { width: 220px; height: 220px; border-radius: 8px; background: white; padding: 10px; margin-top: 15px; }
            .badge-online { color: #00a884; font-weight: bold; }
            .badge-offline { color: #f15c6d; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>slim whatsapp bot</h2>
            <div style="margin-bottom: 15px;">ESTADO: <span class="badge-offline" id="statusText">🔴 DESCONECTADO</span></div>

            <label>Número de teléfono:</label>
            <input type="text" id="phone" value="5216121413081">

            <button onclick="requestPairingCode()">Obtener Código de 8 Dígitos Real</button>
            <button onclick="requestQR()" style="background: #202c33; color: #e9edef;">Generar Código QR En Vivo</button>
            <button onclick="resetSession()" style="background: #202c33; color: #f15c6d; border: 1px solid #2a3942;">🧹 Desconectar / Limpiar Sesión</button>

            <div id="result"></div>
        </div>

        <script>
            const socket = io();

            socket.on('status', (data) => {
                const badge = document.getElementById('statusText');
                if (data.connected) {
                    badge.className = 'badge-online';
                    badge.innerText = '🟢 CONECTADO (' + data.phone + ')';
                    document.getElementById('result').innerHTML = '<p style="color:#00a884; font-weight:bold; margin-top:15px;">¡Bot vinculado y funcionando 24/7 en la nube!</p>';
                } else {
                    badge.className = 'badge-offline';
                    badge.innerText = '🔴 DISPONIBLE';
                }
            });

            socket.on('qr', (qrData) => {
                document.getElementById('result').innerHTML = '<div id="qr-container"><img src="' + qrData + '"><p style="font-size:0.8rem; color:#8696a0;">Escanea desde WhatsApp > Dispositivos vinculados</p></div>';
            });

            async function requestPairingCode() {
                const phone = document.getElementById('phone').value;
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = '<p style="color:#8696a0;">Iniciando conexión Mac OS y pidiendo código a WhatsApp...</p>';

                const res = await fetch('/pair-code', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                });
                const data = await res.json();

                if(data.code) {
                    resultDiv.innerHTML = '<p style="margin-top:15px; color:#8696a0;">Ingresa este código en tu WhatsApp rápidamente:</p>' +
                                          '<div class="code-box">' + data.code + '</div>';
                } else {
                    resultDiv.innerHTML = '<p style="color:#f15c6d; margin-top:15px;">Error al obtener código. Dale a Limpiar Sesión e reintenta.</p>';
                }
            }

            async function requestQR() {
                document.getElementById('result').innerHTML = '<p style="color:#8696a0;">Cargando QR...</p>';
                await fetch('/start-qr', { method: 'POST' });
            }

            async function resetSession() {
                document.getElementById('result').innerHTML = '<p style="color:#8696a0;">Limpiando sesión...</p>';
                await fetch('/reset', { method: 'POST' });
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

        if (cleanedNumber.startsWith('52') && !cleanedNumber.startsWith('521') && cleanedNumber.length === 12) {
            cleanedNumber = '521' + cleanedNumber.slice(2);
        }

        await startBot(true);
        await delay(4000); // Dar tiempo a registrar las claves con la red de WhatsApp

        const code = await sock.requestPairingCode(cleanedNumber);
        res.json({ code });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/start-qr', async (req, res) => {
    await startBot(true);
    res.json({ success: true });
});

app.post('/reset', async (req, res) => {
    await startBot(true);
    res.json({ success: true });
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor "slim whatsapp bot" corriendo en puerto ${PORT}`);
});
