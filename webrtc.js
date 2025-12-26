// --- Constantes e Variáveis de UI ---
const SIGNALING_URL = 'signal.php';
const POLLING_INTERVAL = 500;

let peerConnection;
let dataChannel;
let pollingTimer;
let localStream = null;
let isOffering = false;

// --- 1. Sinalização HTTP e Desconexão ---
async function notifyDisconnect() {
    if (!hash)
        return;
    const payload = {
        action: 'disconnect',
        to: hash
    };
    try {
        await fetch(SIGNALING_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('Falha ao notificar desconexão:', e);
    }
}

async function sendSignal(data) {
    if (!to || !hash)
        return;
    const payload = {
        to: to,
        to: hash,
        data: data
    };
    try {
        await fetch(SIGNALING_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.log(`Erro de rede ao enviar sinal: ${e.message}`, 'error');
    }
}

async function pollSignaling() {
    if (!hash)
        return;
    try {
        const response = await fetch(`${SIGNALING_URL}?hash=${hash}`);
        const result = await response.json();
        if (result.success) {
            const roomStatus = result.roomStatus;
            if (roomStatus.status === 'matched') {
                if (to !== roomStatus.to) {
                    to = roomStatus.to;
                    console.log(`Par encontrado! ID: ${to}. Iniciando Offer...`);
                    console.log('Par encontrado. Negociando conexão...');
                    createOffer();
                }
            } else if (roomStatus.status === 'connected' && to === null) {
                to = roomStatus.to;
                console.log('Conexão anterior detectada. Tentando Offer para reconexão...');
                createOffer();
            }
            result.messages.forEach(handleSignalingMessage);
        }
    } catch (e) {
        // Erro silencioso de polling
    }
}

// --- 2. Criação e Gerenciamento do PeerConnection (Com Mídia) ---
function createPeerConnection(isCreator = false) {
    if (peerConnection)
        peerConnection.close();
    peerConnection = new RTCPeerConnection({
        iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
    });

    // ⚠️ Adiciona as trilhas de áudio/vídeo locais
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // ⚠️ Evento para receber trilhas remotas
//    peerConnection.ontrack = (event) => {
//        if (REMOTE_VIDEO.srcObject !== event.streams[0]) {
//            REMOTE_VIDEO.srcObject = event.streams[0];
//            console.log('Stream remoto de áudio/vídeo iniciado!');
//        }
//    };
    
    peerConnection.onicecandidate = (event) => {
        if (peerConnection.localDescription && event.candidate) {
            sendSignal({
                type: 'ice-candidate',
                candidate: event.candidate.toJSON()
            });
        }
    };

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannelEvents(dataChannel);
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection.iceConnectionState === 'connected') {
            console.log(`CONECTADO VIA P2P com ${to}.`);
        } else if (peerConnection.iceConnectionState === 'failed') {
            console.log('Conexão P2P falhou. Limpando sala e buscando novo par.');
            to = null;
            if (peerConnection)
                peerConnection.close();
            notifyDisconnect();
        }
    };

    if (isCreator) {
        dataChannel = peerConnection.createDataChannel('chat_channel');
        setupDataChannelEvents(dataChannel);
}
}

// --- 3. Lógica do DataChannel ---
function setupDataChannelEvents(channel) {
    channel.onopen = () => {
        console.log('Canal de Dados P2P Aberto!');
    };

    channel.onclose = () => {
        console.log('Canal de Dados P2P Fechado. Buscando novo par...');
        to = null;
        notifyDisconnect();
    };

    channel.onmessage = (event) => {
        console.log(`${to}: ${event.data}`);
    };
}

function sendP2PMessage(msg) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(msg);
    }
}

// --- 4. O Modelo Offer/Answer ---
async function createOffer() {
    if (isOffering)
        return;
    isOffering = true;
    createPeerConnection(true);

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendSignal({type: 'offer', sdp: peerConnection.localDescription.toJSON()});
    } catch (e) {
        console.log(`Falha ao criar Offer: ${e.message}`);
    } finally {
        isOffering = false;
    }
}

async function createAnswer(offerSdp, to_) {
    to = to_;
    createPeerConnection(false);

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        sendSignal({type: 'answer', sdp: peerConnection.localDescription.toJSON()});
    } catch (e) {
        console.log(`Falha ao criar Answer: ${e.message}`);
    }
}

// --- 5. Manipulação de Mensagens Recebidas ---
async function handleSignalingMessage(signal) {
    if (signal.to !== hash)
        return;

    const data = signal.data;

    try {
        if (data.type === 'offer') {
            await createAnswer(data.sdp, signal.to);

        } else if (data.type === 'answer') {
            if (!peerConnection || peerConnection.signalingState !== 'have-local-offer')
                return;
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

        } else if (data.type === 'ice-candidate') {
            if (data.candidate && peerConnection) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        } else if (data.type === 'room-disconnected') {
            console.log(`[PARCEIRO DESCONECTADO] ${signal.to} saiu. Voltando para a fila.`, 'system');

            if (peerConnection) {
                peerConnection.close();
            }
            to = null;
            console.log('Aguardando um par para iniciar a sala...');
        }

    } catch (e) {
        console.log(`Falha no Processamento WebRTC: ${e.name}`, 'error');
        console.error(e);
    }
}

// --- 6. Inicialização (Ordem de Execução Corrigida) ---
async function initWebRTC() {
    // 3. Inicia o polling e o emparelhamento automático
    pollingTimer = setInterval(pollSignaling, POLLING_INTERVAL);
    console.log(`Polling de sala e sinalização iniciado a cada ${POLLING_INTERVAL / 1000}s.`, 'system');

    // 4. Eventos
    window.addEventListener('beforeunload', notifyDisconnect);
    sendP2PMessage('Hello world');
}

// Inicia a aplicação
//initWebRTC();