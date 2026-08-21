/**
 * app.js - Optical Tote Broadcaster & Controller (Host)
 * Accepts pasted Totes/barcodes, chunks into tsX-code items,
 * broadcasts animated QR codes at 10 FPS with persistent speed slider,
 * restart capabilities, and dismissable mobile receiver QR modal.
 */

(function () {
    'use strict';

    // State
    const state = {
        rawTotes: [],
        codes: [], // formatted ts0-tote ... ts99-tote-last
        qrCanvases: [], // pre-rendered canvas elements
        activeIndices: [], // list of indices remaining in the loop
        ackSet: new Set(), // acknowledged indices
        currentIndexInActive: 0,
        isPlaying: false,
        fps: 10,
        timerId: null,
        
        // Webcam state
        isCamActive: false,
        currentFacingMode: 'user', // default to front-facing camera
        camStream: null,
        camDetector: null,
        camScanInterval: null
    };

    // DOM Elements
    const elements = {
        // Screens
        inputScreen: document.getElementById('inputScreen'),
        broadcastScreen: document.getElementById('broadcastScreen'),
        
        // Input Controls
        totesInput: document.getElementById('totesInput'),
        toteCountBadge: document.getElementById('toteCountBadge'),
        generateSampleBtn: document.getElementById('generateSampleBtn'),
        pasteClipboardBtn: document.getElementById('pasteClipboardBtn'),
        clearInputBtn: document.getElementById('clearInputBtn'),
        broadcastSpeedSlider: document.getElementById('broadcastSpeedSlider'),
        broadcastFpsDisplay: document.getElementById('broadcastFpsDisplay'),
        broadcastIntervalDisplay: document.getElementById('broadcastIntervalDisplay'),
        startBroadcastBtn: document.getElementById('startBroadcastBtn'),
        
        // Broadcast Controls
        broadcastCanvas: document.getElementById('broadcastCanvas'),
        frameIndexDisplay: document.getElementById('frameIndexDisplay'),
        frameCodeDisplay: document.getElementById('frameCodeDisplay'),
        inLoopBadge: document.getElementById('inLoopBadge'),
        playPauseBtn: document.getElementById('playPauseBtn'),
        playPauseIcon: document.getElementById('playPauseIcon'),
        playPauseText: document.getElementById('playPauseText'),
        restartBroadcastBtn: document.getElementById('restartBroadcastBtn'),
        prevBtn: document.getElementById('prevBtn'),
        nextBtn: document.getElementById('nextBtn'),
        backToInputBtn: document.getElementById('backToInputBtn'),
        liveSpeedSlider: document.getElementById('liveSpeedSlider'),
        liveFpsDisplay: document.getElementById('liveFpsDisplay'),
        liveIntervalDisplay: document.getElementById('liveIntervalDisplay'),
        
        // Stats & Matrix
        statTotal: document.getElementById('statTotal'),
        statActive: document.getElementById('statActive'),
        statAck: document.getElementById('statAck'),
        hostMatrix: document.getElementById('hostMatrix'),
        
        // Webcam Scanner
        toggleCamBtn: document.getElementById('toggleCamBtn'),
        flipCamBtn: document.getElementById('flipCamBtn'),
        webcamContainer: document.getElementById('webcamContainer'),
        webcamVideo: document.getElementById('webcamVideo'),
        webcamCanvas: document.getElementById('webcamCanvas'),
        webcamStatusText: document.getElementById('webcamStatusText'),

        // Receiver Link Modal
        showReceiverLinkBtn: document.getElementById('showReceiverLinkBtn'),
        showReceiverModalLiveBtn: document.getElementById('showReceiverModalLiveBtn'),
        receiverLinkModal: document.getElementById('receiverLinkModal'),
        closeReceiverModalBtn: document.getElementById('closeReceiverModalBtn'),
        dismissReceiverModalBtn: document.getElementById('dismissReceiverModalBtn'),
        receiverLinkCanvas: document.getElementById('receiverLinkCanvas'),
        receiverUrlLink: document.getElementById('receiverUrlLink')
    };

    // Synthesized sound on ACK
    let audioCtx = null;
    function playAckChime() {
        try {
            if (!audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) audioCtx = new AudioContextClass();
            }
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            if (!audioCtx) return;

            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(587.33, now); // D5
            osc.frequency.setValueAtTime(880, now + 0.08); // A5
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        } catch (e) {}
    }

    function getParsedTotesFromInput() {
        const text = elements.totesInput ? elements.totesInput.value.trim() : '';
        if (!text) return [];

        return text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .slice(0, 100);
    }

    function updateInputCount() {
        const count = getParsedTotesFromInput().length;
        if (elements.toteCountBadge) {
            elements.toteCountBadge.textContent = `${count} Tote${count === 1 ? '' : 's'} entered`;
        }
    }

    function generate100SampleTotes() {
        const samples = [];
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for (let i = 1; i <= 100; i++) {
            let randStr = '';
            for (let k = 0; k < 6; k++) {
                randStr += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            const padded = String(i).padStart(3, '0');
            samples.push(`TOTE_${padded}_${randStr}`);
        }

        if (elements.totesInput) {
            elements.totesInput.value = samples.join('\n');
            updateInputCount();
        }
        showToast('Generated 100 sample Totes!', 'info');
    }

    // =========================================================================
    // QR BROADCAST ENGINE
    // =========================================================================

    function startBroadcast() {
        let totes = getParsedTotesFromInput();
        if (totes.length === 0) {
            generate100SampleTotes();
            totes = getParsedTotesFromInput();
        }

        state.rawTotes = totes;
        const total = totes.length;

        state.codes = [];
        state.qrCanvases = [];
        state.activeIndices = [];
        state.ackSet.clear();

        for (let i = 0; i < total; i++) {
            const isLast = (i === total - 1);
            const formatted = `ts${i}-${totes[i]}${isLast ? '-last' : ''}`;
            state.codes.push(formatted);
            state.activeIndices.push(i);

            const canvas = document.createElement('canvas');
            if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
                window.QRCodeLib.drawToCanvas(canvas, formatted, {
                    width: 300,
                    height: 300,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            }
            state.qrCanvases.push(canvas);
        }

        state.currentIndexInActive = 0;

        if (elements.inputScreen) elements.inputScreen.style.display = 'none';
        if (elements.broadcastScreen) elements.broadcastScreen.style.display = 'block';

        buildHostMatrixDOM(total);
        updateMatrixUI();
        updateStatsUI();
        renderCurrentFrame();
        startPlayback();

        showToast(`Broadcasting ${total} Totes at ${state.fps} FPS`, 'success');
    }

    function restartBroadcast() {
        state.currentIndexInActive = 0;
        renderCurrentFrame();
        if (!state.isPlaying) {
            startPlayback();
        }
        showToast('Restarted stream loop from frame 1', 'info');
    }

    function returnToInputScreen() {
        stopPlayback();
        stopWebcam();
        if (elements.broadcastScreen) elements.broadcastScreen.style.display = 'none';
        if (elements.inputScreen) elements.inputScreen.style.display = 'block';
    }

    function renderCurrentFrame() {
        if (!elements.broadcastCanvas || state.qrCanvases.length === 0) return;

        if (state.activeIndices.length === 0) {
            const ctx = elements.broadcastCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 300, 300);
            ctx.fillStyle = '#10b981';
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('All Totes Delivered! 🎉', 150, 140);
            ctx.fillStyle = '#64748b';
            ctx.font = '14px sans-serif';
            ctx.fillText('Client acknowledged 100%', 150, 175);
            if (elements.frameIndexDisplay) elements.frameIndexDisplay.textContent = 'All Items Delivered!';
            if (elements.frameCodeDisplay) elements.frameCodeDisplay.textContent = 'Broadcast Complete';
            if (elements.inLoopBadge) elements.inLoopBadge.textContent = '0 in loop (Done)';
            return;
        }

        const realIndex = state.activeIndices[state.currentIndexInActive];
        const sourceCanvas = state.qrCanvases[realIndex];

        if (elements.broadcastCanvas) {
            elements.broadcastCanvas.width = 300;
            elements.broadcastCanvas.height = 300;
            const ctx = elements.broadcastCanvas.getContext('2d');
            if (sourceCanvas) {
                ctx.drawImage(sourceCanvas, 0, 0, 300, 300);
            } else if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
                window.QRCodeLib.drawToCanvas(elements.broadcastCanvas, state.codes[realIndex], {
                    width: 300,
                    height: 300,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            }
        }

        const total = state.codes.length;
        if (elements.frameIndexDisplay) {
            elements.frameIndexDisplay.textContent = `Frame: ${realIndex + 1} / ${total} (${state.activeIndices.length} in loop)`;
        }
        if (elements.frameCodeDisplay) {
            elements.frameCodeDisplay.textContent = state.codes[realIndex] || '';
        }
        if (elements.inLoopBadge) {
            elements.inLoopBadge.textContent = `${state.activeIndices.length} in loop`;
        }

        highlightActiveMatrixCell(realIndex);
    }

    function stepNext() {
        if (state.activeIndices.length === 0) return;
        state.currentIndexInActive = (state.currentIndexInActive + 1) % state.activeIndices.length;
        renderCurrentFrame();
    }

    function stepPrev() {
        if (state.activeIndices.length === 0) return;
        state.currentIndexInActive = (state.currentIndexInActive - 1 + state.activeIndices.length) % state.activeIndices.length;
        renderCurrentFrame();
    }

    function startPlayback() {
        stopPlayback();
        state.isPlaying = true;
        updatePlayPauseButton();

        const intervalMs = Math.round(1000 / state.fps);
        state.timerId = setInterval(() => {
            stepNext();
        }, intervalMs);
    }

    function stopPlayback() {
        if (state.timerId) {
            clearInterval(state.timerId);
            state.timerId = null;
        }
        state.isPlaying = false;
        updatePlayPauseButton();
    }

    function togglePlayPause() {
        if (state.isPlaying) {
            stopPlayback();
        } else {
            startPlayback();
        }
    }

    function updatePlayPauseButton() {
        if (!elements.playPauseBtn) return;
        if (state.isPlaying) {
            elements.playPauseIcon.textContent = '⏸️';
            elements.playPauseText.textContent = 'Pause';
            elements.playPauseBtn.classList.remove('btn-secondary');
            elements.playPauseBtn.classList.add('btn-primary');
        } else {
            elements.playPauseIcon.textContent = '▶️';
            elements.playPauseText.textContent = 'Play';
            elements.playPauseBtn.classList.remove('btn-primary');
            elements.playPauseBtn.classList.add('btn-secondary');
        }
    }

    function setFps(newFps) {
        state.fps = Math.max(1, Math.min(20, newFps));
        const interval = Math.round(1000 / state.fps);
        
        if (elements.broadcastFpsDisplay) elements.broadcastFpsDisplay.textContent = `${state.fps} FPS`;
        if (elements.broadcastIntervalDisplay) elements.broadcastIntervalDisplay.textContent = `${interval}ms`;
        if (elements.liveFpsDisplay) elements.liveFpsDisplay.textContent = `${state.fps} FPS`;
        if (elements.liveIntervalDisplay) elements.liveIntervalDisplay.textContent = `${interval}ms`;

        if (elements.broadcastSpeedSlider) elements.broadcastSpeedSlider.value = state.fps;
        if (elements.liveSpeedSlider) elements.liveSpeedSlider.value = state.fps;

        if (state.isPlaying) {
            startPlayback();
        }
    }

    // =========================================================================
    // 100-SQUARE TRANSMISSION MATRIX & STATS
    // =========================================================================

    function buildHostMatrixDOM(count) {
        if (!elements.hostMatrix) return;
        elements.hostMatrix.innerHTML = '';

        for (let i = 0; i < count; i++) {
            const cell = document.createElement('div');
            cell.className = 'matrix-cell active';
            cell.id = `hostMatrixCell_${i}`;
            cell.title = `Tote #${i + 1}: ${state.rawTotes[i] || ''}`;
            cell.textContent = `${i}`;
            elements.hostMatrix.appendChild(cell);
        }
    }

    function updateMatrixUI() {
        const total = state.codes.length;
        for (let i = 0; i < total; i++) {
            const cell = document.getElementById(`hostMatrixCell_${i}`);
            if (!cell) continue;

            if (state.ackSet.has(i)) {
                cell.className = 'matrix-cell ack';
            } else {
                cell.className = 'matrix-cell active';
            }
        }
    }

    function highlightActiveMatrixCell(activeIdx) {
        document.querySelectorAll('.matrix-cell.playing').forEach(el => {
            const idx = parseInt(el.textContent, 10);
            if (state.ackSet.has(idx)) {
                el.className = 'matrix-cell ack';
            } else {
                el.className = 'matrix-cell active';
            }
        });

        const activeCell = document.getElementById(`hostMatrixCell_${activeIdx}`);
        if (activeCell) {
            activeCell.classList.add('playing');
        }
    }

    function updateStatsUI() {
        const total = state.codes.length;
        if (elements.statTotal) elements.statTotal.textContent = total;
        if (elements.statActive) elements.statActive.textContent = state.activeIndices.length;
        if (elements.statAck) elements.statAck.textContent = state.ackSet.size;
    }

    function processClientAck(ackList) {
        if (!Array.isArray(ackList) || ackList.length === 0) return;

        const total = state.codes.length;
        let newAcks = 0;

        ackList.forEach(idx => {
            if (typeof idx === 'number' && idx >= 0 && idx < total) {
                if (!state.ackSet.has(idx)) {
                    state.ackSet.add(idx);
                    newAcks++;
                }
            }
        });

        if (newAcks > 0) {
            playAckChime();

            // Reconstruct active queue omitting all acknowledged items
            state.activeIndices = [];
            for (let i = 0; i < total; i++) {
                if (!state.ackSet.has(i)) {
                    state.activeIndices.push(i);
                }
            }

            if (state.currentIndexInActive >= state.activeIndices.length) {
                state.currentIndexInActive = 0;
            }

            updateMatrixUI();
            updateStatsUI();
            renderCurrentFrame();

            showToast(`ACK: Dropped ${newAcks} Totes. Remaining: ${state.activeIndices.length}`, 'success');
        }
    }

    // =========================================================================
    // WEBCAM SCANNER & HEX BITSET DECODER
    // =========================================================================

    function decodeAckHexBitset(hexStr) {
        const indices = [];
        for (let nib = 0; nib < hexStr.length; nib++) {
            const val = parseInt(hexStr[nib], 16);
            if (isNaN(val)) continue;
            for (let b = 0; b < 4; b++) {
                if ((val & (1 << b)) !== 0) {
                    indices.push(nib * 4 + b);
                }
            }
        }
        return indices;
    }

    async function stopWebcam() {
        if (state.camScanInterval) {
            clearInterval(state.camScanInterval);
            state.camScanInterval = null;
        }

        if (state.camStream) {
            const tracks = state.camStream.getTracks();
            tracks.forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.camStream = null;
        }

        if (elements.webcamVideo) {
            elements.webcamVideo.srcObject = null;
        }

        await new Promise(r => setTimeout(r, 200));

        state.isCamActive = false;
        if (elements.webcamContainer) elements.webcamContainer.style.display = 'none';
        if (elements.flipCamBtn) elements.flipCamBtn.style.display = 'none';
        if (elements.toggleCamBtn) {
            elements.toggleCamBtn.textContent = '📷 Start Webcam';
            elements.toggleCamBtn.classList.remove('btn-primary');
            elements.toggleCamBtn.classList.add('btn-secondary');
        }
    }

    async function startWebcam() {
        await stopWebcam();

        if (elements.webcamContainer) elements.webcamContainer.style.display = 'block';
        if (elements.flipCamBtn) elements.flipCamBtn.style.display = 'inline-flex';
        if (elements.webcamStatusText) elements.webcamStatusText.textContent = 'Starting webcam...';

        try {
            const constraints = {
                audio: false,
                video: {
                    facingMode: { ideal: state.currentFacingMode },
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.camStream = stream;
            state.isCamActive = true;

            if (elements.webcamVideo) {
                elements.webcamVideo.srcObject = stream;
                await elements.webcamVideo.play();
            }

            if (elements.toggleCamBtn) {
                elements.toggleCamBtn.textContent = '🛑 Stop Webcam';
                elements.toggleCamBtn.classList.remove('btn-secondary');
                elements.toggleCamBtn.classList.add('btn-primary');
            }

            if (elements.webcamStatusText) elements.webcamStatusText.textContent = 'Scanning for client ACK QR code...';

            startWebcamScanLoop();
        } catch (err) {
            console.error('Webcam error:', err);
            showToast('Webcam error: ' + (err.message || err.name), 'error');
            await stopWebcam();
        }
    }

    function toggleWebcam() {
        if (state.isCamActive) {
            stopWebcam();
        } else {
            startWebcam();
        }
    }

    function flipWebcam() {
        state.currentFacingMode = (state.currentFacingMode === 'user') ? 'environment' : 'user';
        startWebcam();
    }

    function startWebcamScanLoop() {
        if ('BarcodeDetector' in window && !state.camDetector) {
            try {
                state.camDetector = new BarcodeDetector({ formats: ['qr_code'] });
            } catch (e) {}
        }

        const scanCanvas = elements.webcamCanvas || document.createElement('canvas');
        const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

        state.camScanInterval = setInterval(async () => {
            if (!state.isCamActive || !elements.webcamVideo) return;
            if (elements.webcamVideo.readyState < 2) return;

            // 1. BarcodeDetector
            if (state.camDetector) {
                try {
                    const barcodes = await state.camDetector.detect(elements.webcamVideo);
                    if (barcodes && barcodes.length > 0) {
                        handleAckQrRawText(barcodes[0].rawValue);
                        return;
                    }
                } catch (e) {}
            }

            // 2. jsQR
            if (typeof jsQR !== 'undefined') {
                scanCanvas.width = elements.webcamVideo.videoWidth || 320;
                scanCanvas.height = elements.webcamVideo.videoHeight || 240;
                scanCtx.drawImage(elements.webcamVideo, 0, 0, scanCanvas.width, scanCanvas.height);
                const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
                const qrCode = jsQR(imageData.data, imageData.width, imageData.height);
                if (qrCode && qrCode.data) {
                    handleAckQrRawText(qrCode.data);
                }
            }
        }, 150);
    }

    function handleAckQrRawText(text) {
        if (!text || typeof text !== 'string') return;
        text = text.trim();

        try {
            if (text.startsWith('ACK:H:')) {
                const hexStr = text.substring(6);
                const indices = decodeAckHexBitset(hexStr);
                processClientAck(indices);
            } else if (text.startsWith('ACK:')) {
                const parts = text.substring(4).split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
                processClientAck(parts);
            } else if (text.startsWith('ACK_RANGES:')) {
                const rangeStr = text.substring(11);
                const list = [];
                rangeStr.split(',').forEach(token => {
                    if (token.includes('-')) {
                        const [start, end] = token.split('-').map(n => parseInt(n, 10));
                        for (let k = start; k <= end; k++) list.push(k);
                    } else {
                        const n = parseInt(token, 10);
                        if (!isNaN(n)) list.push(n);
                    }
                });
                processClientAck(list);
            } else if (text.startsWith('{')) {
                const json = JSON.parse(text);
                if (Array.isArray(json.ack)) {
                    processClientAck(json.ack);
                }
            }
        } catch (e) {
            console.warn('ACK decode error:', e);
        }
    }

    // =========================================================================
    // RECEIVER LINK MODAL (SCAN WITH PHONE TO OPEN peerGrab)
    // =========================================================================

    function getReceiverFullUrl() {
        const href = window.location.href;
        if (href.includes('index.html')) {
            return href.replace('index.html', 'peerGrab.html');
        }
        // Fallback for directory paths
        const base = href.split('?')[0].split('#')[0];
        return base.endsWith('/') ? `${base}peerGrab.html` : `${base}/peerGrab.html`;
    }

    function showReceiverLinkModal() {
        if (!elements.receiverLinkModal) return;

        const fullUrl = getReceiverFullUrl();
        if (elements.receiverUrlLink) {
            elements.receiverUrlLink.href = fullUrl;
            elements.receiverUrlLink.textContent = fullUrl;
        }

        if (elements.receiverLinkCanvas && window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            try {
                window.QRCodeLib.drawToCanvas(elements.receiverLinkCanvas, fullUrl, {
                    width: 200,
                    height: 200,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            } catch (e) {
                console.warn('Receiver link QR draw error:', e);
            }
        }

        elements.receiverLinkModal.style.display = 'flex';
    }

    function hideReceiverLinkModal() {
        if (elements.receiverLinkModal) {
            elements.receiverLinkModal.style.display = 'none';
        }
    }

    function showToast(message, type = 'info', duration = 3000) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, duration);
    }

    // =========================================================================
    // INITIALIZATION & BINDINGS
    // =========================================================================

    function bindEvents() {
        if (elements.totesInput) {
            elements.totesInput.addEventListener('input', updateInputCount);
        }

        if (elements.generateSampleBtn) {
            elements.generateSampleBtn.addEventListener('click', generate100SampleTotes);
        }

        if (elements.pasteClipboardBtn) {
            elements.pasteClipboardBtn.addEventListener('click', async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text && elements.totesInput) {
                        elements.totesInput.value = text;
                        updateInputCount();
                        showToast('Pasted from clipboard!', 'success');
                    }
                } catch (e) {
                    showToast('Clipboard access denied. Please paste manually.', 'error');
                }
            });
        }

        if (elements.clearInputBtn) {
            elements.clearInputBtn.addEventListener('click', () => {
                if (elements.totesInput) elements.totesInput.value = '';
                updateInputCount();
            });
        }

        if (elements.broadcastSpeedSlider) {
            elements.broadcastSpeedSlider.addEventListener('input', (e) => {
                setFps(parseInt(e.target.value, 10));
            });
        }

        if (elements.liveSpeedSlider) {
            elements.liveSpeedSlider.addEventListener('input', (e) => {
                setFps(parseInt(e.target.value, 10));
            });
        }

        if (elements.startBroadcastBtn) {
            elements.startBroadcastBtn.addEventListener('click', startBroadcast);
        }

        if (elements.restartBroadcastBtn) {
            elements.restartBroadcastBtn.addEventListener('click', restartBroadcast);
        }

        if (elements.playPauseBtn) {
            elements.playPauseBtn.addEventListener('click', togglePlayPause);
        }

        if (elements.prevBtn) elements.prevBtn.addEventListener('click', stepPrev);
        if (elements.nextBtn) elements.nextBtn.addEventListener('click', stepNext);
        if (elements.backToInputBtn) elements.backToInputBtn.addEventListener('click', returnToInputScreen);

        if (elements.toggleCamBtn) elements.toggleCamBtn.addEventListener('click', toggleWebcam);
        if (elements.flipCamBtn) elements.flipCamBtn.addEventListener('click', flipWebcam);

        // Modal triggers
        if (elements.showReceiverLinkBtn) elements.showReceiverLinkBtn.addEventListener('click', showReceiverLinkModal);
        if (elements.showReceiverModalLiveBtn) elements.showReceiverModalLiveBtn.addEventListener('click', showReceiverLinkModal);
        if (elements.closeReceiverModalBtn) elements.closeReceiverModalBtn.addEventListener('click', hideReceiverLinkModal);
        if (elements.dismissReceiverModalBtn) elements.dismissReceiverModalBtn.addEventListener('click', hideReceiverLinkModal);

        if (elements.receiverLinkModal) {
            elements.receiverLinkModal.addEventListener('click', (e) => {
                if (e.target === elements.receiverLinkModal) hideReceiverLinkModal();
            });
        }

        window.addEventListener('beforeunload', () => {
            stopPlayback();
            stopWebcam();
        });
    }

    function init() {
        bindEvents();
        updateInputCount();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
