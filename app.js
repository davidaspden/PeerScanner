/**
 * PeerScanner - WebRTC Barcode Scanner Application Logic
 * Supports PeerJS peer-to-peer WebRTC data synchronization,
 * QuaggaJS barcode scanning, native BarcodeDetector API,
 * torch controls, sound/haptic feedback, JSON export,
 * and seamless loading of optical QR stream data.
 */

(function () {
    'use strict';

    // Application State
    const state = {
        peer: null,
        connection: null,
        myPeerId: null,
        connectedPeerId: null,
        scannedItems: [], // [{ id, barcode, format, timestamp, timeDisplay, source }]
        isScanning: false,
        isTorchOn: false,
        lastScannedCode: null,
        lastScanTime: 0,
        scanCooldownMs: 2000, // Cooldown for duplicate scans
        minScanIntervalMs: 600, // Minimum delay between any scans
        barcodeDetector: null,
        detectorInterval: null
    };

    // DOM Elements
    const elements = {
        // Screens
        connectionScreen: document.getElementById('connectionScreen'),
        scannerScreen: document.getElementById('scannerScreen'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        
        // Connection screen
        peerIdDisplay: document.getElementById('peerId'),
        copyPeerIdBtn: document.getElementById('copyPeerIdBtn'),
        remotePeerIdInput: document.getElementById('remotePeerId'),
        connectBtn: document.getElementById('connectBtn'),
        connectionStatus: document.getElementById('connectionStatus'),
        
        // Scanner screen
        quaggaContainer: document.getElementById('quagga-container'),
        scanBox: document.querySelector('.scan-box'),
        peerStatusBadge: document.getElementById('peerStatusBadge'),
        peerStatusText: document.getElementById('peerStatusText'),
        lastScannedDisplay: document.getElementById('lastScannedDisplay'),
        lastScannedCode: document.getElementById('lastScannedCode'),
        fabButton: document.getElementById('fabButton'),
        fabCount: document.getElementById('fabCount'),
        
        // Modal
        scannedModal: document.getElementById('scannedModal'),
        closeModalBtn: document.getElementById('closeModalBtn'),
        scannedList: document.getElementById('scannedList'),
        clearScannedBtn: document.getElementById('clearScannedBtn'),
        exportScannedBtn: document.getElementById('exportScannedBtn'),
        
        // Action Bar
        disconnectBtn: document.getElementById('disconnectBtn'),
        torchBtn: document.getElementById('torchBtn')
    };

    // Web Audio Synthesizer for Scans
    let audioCtx = null;

    /**
     * Play synthesized audio chirp on barcode detection
     * @param {boolean} isRemote - whether the scan originated from remote peer
     */
    function playScanSound(isRemote = false) {
        try {
            if (!audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) {
                    audioCtx = new AudioContextClass();
                }
            }
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            if (!audioCtx) return;

            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            if (!isRemote) {
                // Local scan: crisp high-pitched chirp (880Hz -> 1760Hz)
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.exponentialRampToValueAtTime(1760, now + 0.08);
                gain.gain.setValueAtTime(0.3, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
                osc.start(now);
                osc.stop(now + 0.14);
            } else {
                // Remote peer scan: dual tone melodic chime
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(587.33, now); // D5
                osc.frequency.setValueAtTime(880, now + 0.06); // A5
                gain.gain.setValueAtTime(0.25, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
                osc.start(now);
                osc.stop(now + 0.2);
            }
        } catch (e) {
            console.warn('Audio playback not permitted or supported:', e);
        }
    }

    /**
     * Trigger device haptic vibration if supported
     */
    function triggerHaptic() {
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate([60, 40, 60]);
            } catch (e) {}
        }
    }

    /**
     * Show non-intrusive floating toast notification
     */
    function showToast(message, type = 'info', duration = 3000) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        let icon = 'ℹ️';
        if (type === 'success') icon = '✅';
        if (type === 'error') icon = '⚠️';

        toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, duration);
    }

    /**
     * Show connection status message on setup screen
     */
    function showConnectionStatus(message, type = 'info') {
        if (!elements.connectionStatus) return;
        if (!message) {
            elements.connectionStatus.style.display = 'none';
            elements.connectionStatus.textContent = '';
            elements.connectionStatus.className = 'status-message';
            return;
        }
        elements.connectionStatus.textContent = message;
        elements.connectionStatus.className = `status-message ${type}`;
        elements.connectionStatus.style.display = 'block';
    }

    /**
     * Escape HTML string helper
     */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Switch visible screen
     */
    function switchScreen(screenName) {
        if (screenName === 'scanner') {
            elements.connectionScreen.classList.remove('active');
            elements.scannerScreen.classList.add('active');
        } else {
            elements.scannerScreen.classList.remove('active');
            elements.connectionScreen.classList.add('active');
        }
    }

    /**
     * Set loading indicator state
     */
    function setLoading(isLoading, text = 'Initializing camera...') {
        if (!elements.loadingIndicator) return;
        if (isLoading) {
            const p = elements.loadingIndicator.querySelector('p');
            if (p) p.textContent = text;
            elements.loadingIndicator.classList.add('active');
        } else {
            elements.loadingIndicator.classList.remove('active');
        }
    }

    /**
     * Build scan reticle corners and laser elements inside .scan-box
     */
    function setupScanBoxOverlay() {
        if (!elements.scanBox) return;
        if (!elements.scanBox.querySelector('.scan-laser')) {
            const laser = document.createElement('div');
            laser.className = 'scan-laser';
            elements.scanBox.appendChild(laser);
        }
        if (!elements.scanBox.querySelector('.scan-box-corner-tr')) {
            const tr = document.createElement('div');
            tr.className = 'scan-box-corner-tr';
            elements.scanBox.appendChild(tr);
        }
        if (!elements.scanBox.querySelector('.scan-box-corner-bl')) {
            const bl = document.createElement('div');
            bl.className = 'scan-box-corner-bl';
            elements.scanBox.appendChild(bl);
        }
    }

    /**
     * Ensure peer status dot indicator is present
     */
    function setupPeerStatusIndicator() {
        if (!elements.peerStatusBadge) return;
        if (!elements.peerStatusBadge.querySelector('.peer-status-dot')) {
            const dot = document.createElement('span');
            dot.className = 'peer-status-dot';
            elements.peerStatusBadge.insertBefore(dot, elements.peerStatusBadge.firstChild);
        }
    }

    // =========================================================================
    // PEERJS WEBRTC CONNECTION HANDLING
    // =========================================================================

    /**
     * Initialize local PeerJS instance
     */
    function initPeer() {
        if (typeof Peer === 'undefined') {
            showConnectionStatus('PeerJS library failed to load. (Use optical transfer if offline/air-gapped)', 'info');
            return;
        }

        if (elements.peerIdDisplay) {
            elements.peerIdDisplay.textContent = 'Generating...';
            elements.peerIdDisplay.classList.add('loading');
        }

        const randomId = 'ps-' + Math.random().toString(36).substring(2, 8);
        
        try {
            state.peer = new Peer(randomId, {
                debug: 1
            });
        } catch (e) {
            state.peer = new Peer({ debug: 1 });
        }

        state.peer.on('open', (id) => {
            state.myPeerId = id;
            if (elements.peerIdDisplay) {
                elements.peerIdDisplay.textContent = id;
                elements.peerIdDisplay.classList.remove('loading');
            }
            showConnectionStatus('Ready to connect. Share your Peer ID or connect to a remote Peer ID.', 'info');

            // Check if there is an auto-connect URL parameter
            checkUrlParameters();
        });

        // Handle incoming connection
        state.peer.on('connection', (conn) => {
            setupDataConnection(conn, false);
        });

        // Peer error handling
        state.peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            let message = 'Connection notice: ' + (err.message || err.type || 'Offline');
            if (err.type === 'peer-unavailable') {
                message = 'Remote peer not found or offline. Please check the ID.';
            } else if (err.type === 'network') {
                message = 'Network unavailable for signaling server. Try optical QR transfer!';
            }
            showConnectionStatus(message, 'info');
        });

        state.peer.on('disconnected', () => {
            showConnectionStatus('Disconnected from signaling server.', 'info');
            if (state.peer && !state.peer.destroyed) {
                state.peer.reconnect();
            }
        });
    }

    /**
     * Connect to remote peer by ID
     */
    function connectToRemotePeer(remoteId) {
        if (!remoteId || !remoteId.trim()) {
            showConnectionStatus('Please enter a valid remote Peer ID.', 'error');
            return;
        }

        remoteId = remoteId.trim();

        if (remoteId === state.myPeerId) {
            showConnectionStatus('Cannot connect to your own Peer ID.', 'error');
            return;
        }

        if (!state.peer || state.peer.disconnected) {
            showConnectionStatus('Signaling connection not ready. Please wait...', 'error');
            return;
        }

        showConnectionStatus(`Connecting to ${remoteId}...`, 'info');
        if (elements.connectBtn) {
            elements.connectBtn.disabled = true;
            elements.connectBtn.textContent = 'Connecting...';
        }

        const conn = state.peer.connect(remoteId, {
            reliable: true
        });

        setupDataConnection(conn, true);
    }

    /**
     * Set up event listeners for a PeerJS DataConnection
     */
    function setupDataConnection(conn, isInitiator) {
        if (state.connection) {
            try { state.connection.close(); } catch (e) {}
        }

        state.connection = conn;
        state.connectedPeerId = conn.peer;

        conn.on('open', () => {
            console.log('Connected to peer:', conn.peer);
            showConnectionStatus('', '');
            if (elements.connectBtn) {
                elements.connectBtn.disabled = false;
                elements.connectBtn.textContent = 'Connect';
            }

            if (elements.peerStatusText) {
                elements.peerStatusText.textContent = `Connected: ${conn.peer}`;
            }
            if (elements.peerStatusBadge) {
                elements.peerStatusBadge.classList.remove('disconnected');
            }

            switchScreen('scanner');
            showToast(`Connected to peer: ${conn.peer}`, 'success');

            startScanner();

            if (isInitiator && state.scannedItems.length > 0) {
                sendToPeer({
                    type: 'SYNC_LIST',
                    items: state.scannedItems
                });
            }
        });

        conn.on('data', (data) => {
            handleIncomingData(data);
        });

        conn.on('close', () => {
            handlePeerDisconnection('Peer disconnected.');
        });

        conn.on('error', (err) => {
            console.error('DataConnection error:', err);
            showToast('Peer connection error: ' + (err.message || err.type), 'error');
        });
    }

    /**
     * Send payload to connected peer over WebRTC
     */
    function sendToPeer(payload) {
        if (state.connection && state.connection.open) {
            try {
                state.connection.send(payload);
            } catch (e) {
                console.error('Error sending data to peer:', e);
            }
        }
    }

    /**
     * Handle incoming data message from remote peer
     */
    function handleIncomingData(data) {
        if (!data || typeof data !== 'object') return;

        switch (data.type) {
            case 'SCAN':
                if (data.barcode) {
                    onBarcodeDetected(data.barcode, data.format, 'peer', data.timestamp);
                }
                break;

            case 'SYNC_LIST':
                if (Array.isArray(data.items)) {
                    data.items.forEach(remoteItem => {
                        const exists = state.scannedItems.some(
                            item => item.id === remoteItem.id || 
                                   (item.barcode === remoteItem.barcode && item.timestamp === remoteItem.timestamp)
                        );
                        if (!exists) {
                            state.scannedItems.push({
                                ...remoteItem,
                                source: 'peer'
                            });
                        }
                    });
                    state.scannedItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                    updateFabCount();
                    renderScannedList();
                    showToast(`Synced ${data.items.length} items from peer`, 'info');
                }
                break;

            case 'CLEAR_LIST':
                state.scannedItems = [];
                updateFabCount();
                renderScannedList();
                if (elements.lastScannedCode) {
                    elements.lastScannedCode.textContent = 'Scanning...';
                }
                showToast('Peer cleared the scanned items list', 'info');
                break;

            default:
                console.log('Received unknown message type:', data);
        }
    }

    /**
     * Handle peer disconnection
     */
    function handlePeerDisconnection(reason = 'Disconnected') {
        showToast(reason, 'error');
        if (elements.peerStatusText) {
            elements.peerStatusText.textContent = 'Peer disconnected';
        }
        if (elements.peerStatusBadge) {
            elements.peerStatusBadge.classList.add('disconnected');
        }

        if (elements.connectBtn) {
            elements.connectBtn.disabled = false;
            elements.connectBtn.textContent = 'Connect';
        }

        state.connectedPeerId = null;
        state.connection = null;
    }

    /**
     * Disconnect button handler
     */
    function disconnect() {
        if (state.connection) {
            try { state.connection.close(); } catch (e) {}
            state.connection = null;
        }
        state.connectedPeerId = null;
        
        stopScanner();
        switchScreen('connection');
        showConnectionStatus('Disconnected.', 'info');
        showToast('Disconnected from peer', 'info');
    }

    /**
     * Check URL search params for ?connect=<peerId>
     */
    function checkUrlParameters() {
        const params = new URLSearchParams(window.location.search);
        const connectParam = params.get('connect') || params.get('peer');
        if (connectParam && connectParam !== state.myPeerId) {
            if (elements.remotePeerIdInput) {
                elements.remotePeerIdInput.value = connectParam;
            }
            connectToRemotePeer(connectParam);
        }
    }

    /**
     * Copy peer ID or share link to clipboard
     */
    async function copyPeerId() {
        if (!state.myPeerId) {
            showToast('Peer ID not ready yet', 'error');
            return;
        }

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(state.myPeerId);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = state.myPeerId;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }

            if (elements.copyPeerIdBtn) {
                const originalText = elements.copyPeerIdBtn.textContent;
                elements.copyPeerIdBtn.textContent = 'Copied!';
                elements.copyPeerIdBtn.classList.add('btn-primary');
                setTimeout(() => {
                    elements.copyPeerIdBtn.textContent = originalText;
                    elements.copyPeerIdBtn.classList.remove('btn-primary');
                }, 2000);
            }
            showToast('Peer ID copied to clipboard!', 'success');
        } catch (e) {
            showToast('Failed to copy ID: ' + e.message, 'error');
        }
    }

    // =========================================================================
    // BARCODE SCANNER ENGINE (QUAGGA + NATIVE BARCODE DETECTOR)
    // =========================================================================

    /**
     * Start camera stream and barcode scanner
     */
    function startScanner() {
        if (state.isScanning) return;
        setLoading(true, 'Initializing camera...');

        if ('BarcodeDetector' in window && !state.barcodeDetector) {
            try {
                BarcodeDetector.getSupportedFormats().then(supportedFormats => {
                    state.barcodeDetector = new BarcodeDetector({
                        formats: supportedFormats || ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e']
                    });
                }).catch(() => {
                    state.barcodeDetector = new BarcodeDetector();
                });
            } catch (e) {
                console.log('Native BarcodeDetector not available:', e);
            }
        }

        if (typeof Quagga === 'undefined') {
            setLoading(false);
            showToast('Quagga barcode scanner library is not loaded', 'error');
            return;
        }

        const quaggaConfig = {
            inputStream: {
                name: 'Live',
                type: 'LiveStream',
                target: elements.quaggaContainer,
                constraints: {
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    facingMode: { ideal: 'environment' },
                    aspectRatio: { min: 1, max: 2 }
                }
            },
            locator: {
                patchSize: 'medium',
                halfSample: true
            },
            numOfWorkers: navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2,
            frequency: 10,
            decoder: {
                readers: [
                    'code_128_reader',
                    'ean_reader',
                    'ean_8_reader',
                    'code_39_reader',
                    'code_39_vin_reader',
                    'codabar_reader',
                    'upc_reader',
                    'upc_e_reader',
                    'i2of5_reader',
                    '2of5_reader',
                    'code_93_reader'
                ]
            },
            locate: true
        };

        Quagga.init(quaggaConfig, (err) => {
            setLoading(false);
            if (err) {
                console.error('Quagga init failed:', err);
                showToast('Camera initialization failed: ' + (err.message || err.name || err), 'error');
                return;
            }

            Quagga.start();
            state.isScanning = true;

            startNativeBarcodeDetectorLoop();
        });

        Quagga.onDetected(handleQuaggaDetection);
    }

    /**
     * Native BarcodeDetector loop for sub-millisecond detection and 2D/QR code support
     */
    function startNativeBarcodeDetectorLoop() {
        if (!state.barcodeDetector) return;
        if (state.detectorInterval) clearInterval(state.detectorInterval);

        state.detectorInterval = setInterval(async () => {
            if (!state.isScanning || !state.barcodeDetector) return;
            const video = elements.quaggaContainer ? elements.quaggaContainer.querySelector('video') : null;
            if (!video || video.readyState < 2) return;

            try {
                const barcodes = await state.barcodeDetector.detect(video);
                if (barcodes && barcodes.length > 0) {
                    const detected = barcodes[0];
                    if (detected.rawValue) {
                        onBarcodeDetected(detected.rawValue, detected.format || 'BARCODE', 'local');
                    }
                }
            } catch (e) {}
        }, 150);
    }

    /**
     * Stop camera stream and barcode scanner cleanly
     */
    function stopScanner() {
        if (state.detectorInterval) {
            clearInterval(state.detectorInterval);
            state.detectorInterval = null;
        }

        if (typeof Quagga !== 'undefined' && state.isScanning) {
            try {
                Quagga.offDetected(handleQuaggaDetection);
                Quagga.stop();
            } catch (e) {
                console.warn('Error stopping Quagga:', e);
            }
        }

        if (elements.quaggaContainer) {
            const video = elements.quaggaContainer.querySelector('video');
            if (video && video.srcObject) {
                const tracks = video.srcObject.getTracks();
                tracks.forEach(track => track.stop());
                video.srcObject = null;
            }
            elements.quaggaContainer.innerHTML = '';
        }

        state.isScanning = false;
        state.isTorchOn = false;
        if (elements.torchBtn) {
            elements.torchBtn.classList.remove('active');
            elements.torchBtn.innerHTML = '💡 Torch';
        }
    }

    /**
     * Quagga detection handler
     */
    function handleQuaggaDetection(result) {
        if (!result || !result.codeResult || !result.codeResult.code) return;
        
        const code = result.codeResult.code;
        const format = result.codeResult.format || 'BARCODE';

        if (result.codeResult.startInfo && result.codeResult.startInfo.error > 0.15) {
            return;
        }

        onBarcodeDetected(code, format, 'local');
    }

    /**
     * Process detected barcode (from local camera or received from peer)
     */
    function onBarcodeDetected(code, format = 'BARCODE', source = 'local', explicitTimestamp = null) {
        if (!code || typeof code !== 'string') return;
        code = code.trim();
        if (code.length === 0) return;

        const now = Date.now();

        // Debounce check
        if (source === 'local') {
            if (code === state.lastScannedCode && (now - state.lastScanTime < state.scanCooldownMs)) {
                return;
            }
            if (now - state.lastScanTime < state.minScanIntervalMs) {
                return;
            }
        }

        state.lastScannedCode = code;
        state.lastScanTime = now;

        if (elements.scanBox && source === 'local') {
            elements.scanBox.classList.add('success');
            setTimeout(() => {
                if (elements.scanBox) elements.scanBox.classList.remove('success');
            }, 500);
        }

        playScanSound(source === 'peer');
        if (source === 'local') {
            triggerHaptic();
        }

        const dateObj = explicitTimestamp ? new Date(explicitTimestamp) : new Date();
        const isoTimestamp = dateObj.toISOString();
        const timeDisplay = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        if (elements.lastScannedCode) {
            elements.lastScannedCode.textContent = (source === 'peer' ? '📱 Peer: ' : '🔍 ') + code;
        }
        if (elements.lastScannedDisplay) {
            elements.lastScannedDisplay.classList.add('highlight');
            setTimeout(() => {
                if (elements.lastScannedDisplay) elements.lastScannedDisplay.classList.remove('highlight');
            }, 1000);
        }

        const item = {
            id: 'scan_' + dateObj.getTime() + '_' + Math.random().toString(36).substring(2, 6),
            barcode: code,
            format: format.toUpperCase().replace(/_/g, ' '),
            timestamp: isoTimestamp,
            timeDisplay: timeDisplay,
            source: source
        };

        state.scannedItems.unshift(item);
        updateFabCount();
        renderScannedList();

        if (source === 'local') {
            sendToPeer({
                type: 'SCAN',
                barcode: code,
                format: item.format,
                timestamp: isoTimestamp
            });
            showToast(`Scanned: ${code}`, 'success', 2000);
        } else {
            showToast(`Received: ${code} from peer`, 'info', 2500);
        }
    }

    /**
     * Toggle camera torch / flashlight
     */
    function toggleTorch() {
        if (!state.isScanning) {
            showToast('Start scanner to use torch', 'info');
            return;
        }

        let track = null;

        if (typeof Quagga !== 'undefined' && Quagga.CameraAccess && Quagga.CameraAccess.getActiveTrack) {
            track = Quagga.CameraAccess.getActiveTrack();
        }

        if (!track && elements.quaggaContainer) {
            const video = elements.quaggaContainer.querySelector('video');
            if (video && video.srcObject) {
                const tracks = video.srcObject.getVideoTracks();
                if (tracks && tracks.length > 0) {
                    track = tracks[0];
                }
            }
        }

        if (!track) {
            showToast('No active camera track found', 'error');
            return;
        }

        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (!capabilities.torch) {
            showToast('Torch is not supported by this camera', 'info');
            return;
        }

        const nextTorchState = !state.isTorchOn;

        track.applyConstraints({
            advanced: [{ torch: nextTorchState }]
        }).then(() => {
            state.isTorchOn = nextTorchState;
            if (elements.torchBtn) {
                elements.torchBtn.classList.toggle('active', state.isTorchOn);
                elements.torchBtn.innerHTML = state.isTorchOn ? '🔦 Torch ON' : '💡 Torch';
            }
            showToast(state.isTorchOn ? 'Torch turned ON' : 'Torch turned OFF', 'info');
        }).catch(err => {
            console.error('Torch error:', err);
            showToast('Could not toggle torch: ' + err.message, 'error');
        });
    }

    // =========================================================================
    // SCANNED ITEMS LIST & JSON EXPORT
    // =========================================================================

    /**
     * Update FAB badge count
     */
    function updateFabCount() {
        if (elements.fabCount) {
            elements.fabCount.textContent = state.scannedItems.length;
        }
    }

    /**
     * Render the list of scanned barcodes in the modal
     */
    function renderScannedList() {
        if (!elements.scannedList) return;

        if (state.scannedItems.length === 0) {
            elements.scannedList.innerHTML = `
                <div class="scanned-empty">
                    <span class="scanned-empty-icon">📦</span>
                    <p>No barcodes scanned yet.</p>
                </div>
            `;
            return;
        }

        elements.scannedList.innerHTML = state.scannedItems.map((item) => `
            <div class="scanned-item" data-id="${escapeHtml(item.id)}">
                <div class="scanned-item-info">
                    <span class="scanned-item-code">${escapeHtml(item.barcode)}</span>
                    <div class="scanned-item-meta">
                        <span class="scanned-item-badge ${item.source === 'peer' ? 'peer' : ''}">${escapeHtml(item.source === 'peer' ? 'Peer' : 'You')}</span>
                        <span class="scanned-item-badge">${escapeHtml(item.format)}</span>
                        <span>${escapeHtml(item.timeDisplay || '')}</span>
                    </div>
                </div>
                <div class="scanned-item-actions">
                    <button class="item-action-btn copy-btn" data-barcode="${escapeHtml(item.barcode)}" title="Copy Barcode">📋</button>
                    <button class="item-action-btn delete item-delete-btn" data-id="${escapeHtml(item.id)}" title="Delete">🗑️</button>
                </div>
            </div>
        `).join('');

        // Attach event listeners to item actions
        elements.scannedList.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = btn.getAttribute('data-barcode');
                if (code) {
                    navigator.clipboard.writeText(code).then(() => {
                        showToast(`Copied barcode: ${code}`, 'success');
                    }).catch(() => {
                        showToast('Failed to copy', 'error');
                    });
                }
            });
        });

        elements.scannedList.querySelectorAll('.item-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                deleteScannedItem(id);
            });
        });
    }

    /**
     * Delete individual scanned item
     */
    function deleteScannedItem(id) {
        state.scannedItems = state.scannedItems.filter(item => item.id !== id);
        updateFabCount();
        renderScannedList();
    }

    /**
     * Clear all scanned items
     */
    function clearAllScanned() {
        if (state.scannedItems.length === 0) {
            showToast('No barcodes to clear', 'info');
            return;
        }

        if (!confirm('Are you sure you want to clear all scanned barcodes?')) {
            return;
        }

        state.scannedItems = [];
        updateFabCount();
        renderScannedList();
        if (elements.lastScannedCode) {
            elements.lastScannedCode.textContent = 'Scanning...';
        }

        sendToPeer({
            type: 'CLEAR_LIST'
        });

        showToast('All scanned barcodes cleared', 'info');
    }

    /**
     * Export scanned barcodes as a JSON array of { barcode, timestamp } objects
     */
    function exportScannedJSON() {
        if (state.scannedItems.length === 0) {
            showToast('No barcodes to export', 'info');
            return;
        }

        const exportData = state.scannedItems.map(item => ({
            barcode: item.barcode,
            timestamp: item.timestamp
        }));

        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `barcodes_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Exported ${exportData.length} barcodes to JSON file`, 'success');
    }

    /**
     * Modal display controls
     */
    function openModal() {
        renderScannedList();
        if (elements.scannedModal) {
            elements.scannedModal.classList.add('active');
        }
    }

    function closeModal() {
        if (elements.scannedModal) {
            elements.scannedModal.classList.remove('active');
        }
    }

    /**
     * Load items imported from peerGrab.html optical transfer
     */
    function loadImportedOpticalCodes() {
        try {
            const stored = localStorage.getItem('scannedItems');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    state.scannedItems = parsed;
                    updateFabCount();
                    renderScannedList();

                    const hasImported = localStorage.getItem('hasImportedOptical');
                    if (hasImported === 'true') {
                        localStorage.removeItem('hasImportedOptical');
                        showToast(`Loaded ${parsed.length} codes from optical QR transfer!`, 'success', 4000);
                        if (elements.lastScannedCode && parsed[0]) {
                            elements.lastScannedCode.textContent = parsed[0].barcode;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Error reading stored scannedItems:', e);
        }
    }

    // =========================================================================
    // EVENT LISTENERS & INITIALIZATION
    // =========================================================================

    function bindEvents() {
        if (elements.copyPeerIdBtn) {
            elements.copyPeerIdBtn.addEventListener('click', copyPeerId);
        }

        if (elements.connectBtn) {
            elements.connectBtn.addEventListener('click', () => {
                const id = elements.remotePeerIdInput ? elements.remotePeerIdInput.value : '';
                connectToRemotePeer(id);
            });
        }

        if (elements.remotePeerIdInput) {
            elements.remotePeerIdInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    connectToRemotePeer(elements.remotePeerIdInput.value);
                }
            });
        }

        if (elements.fabButton) {
            elements.fabButton.addEventListener('click', openModal);
        }

        if (elements.closeModalBtn) {
            elements.closeModalBtn.addEventListener('click', closeModal);
        }

        if (elements.scannedModal) {
            elements.scannedModal.addEventListener('click', (e) => {
                if (e.target === elements.scannedModal) {
                    closeModal();
                }
            });
        }

        if (elements.clearScannedBtn) {
            elements.clearScannedBtn.addEventListener('click', clearAllScanned);
        }

        if (elements.exportScannedBtn) {
            elements.exportScannedBtn.addEventListener('click', exportScannedJSON);
        }

        if (elements.torchBtn) {
            elements.torchBtn.addEventListener('click', toggleTorch);
        }

        if (elements.disconnectBtn) {
            elements.disconnectBtn.addEventListener('click', disconnect);
        }

        window.addEventListener('beforeunload', () => {
            if (state.connection) {
                try { state.connection.close(); } catch (e) {}
            }
            if (state.peer) {
                try { state.peer.destroy(); } catch (e) {}
            }
        });
    }

    function init() {
        setupScanBoxOverlay();
        setupPeerStatusIndicator();
        bindEvents();
        loadImportedOpticalCodes();
        initPeer();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
