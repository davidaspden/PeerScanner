/**
 * peerGrab.js - Client Optical QR Stream Receiver & Physical Tote Finder
 * 1. Ingestion Phase: Camera QR stream receiver with live 25-char Hex Bitset ACK.
 * 2. Results Phase: Full completed ACK QR, export, copy, and 5-second long-press reset.
 * 3. Finding Phase: Full-page Code 128 physical barcode scanner with bold last-4-digits HUD.
 */

(function () {
    'use strict';

    const DEFAULT_TOTAL = 100;
    const LONG_PRESS_MS = 5000;

    // State
    const state = {
        phase: 'receiving', // 'receiving' | 'results' | 'finding'
        totalCount: DEFAULT_TOTAL,
        hasReceivedLastMarker: false,
        receivedMap: new Map(), // index -> { index, tote, rawCode, timestamp }
        toteLookup: new Map(), // normalizedTote -> index
        foundMap: new Map(), // index -> { index, tote, foundAt }
        viewMode: 'split', // 'split' | 'max-ack' | 'max-cam'
        isListVisible: false,
        isDrawerVisible: false,
        isScanning: false,
        isFindingScanning: false,
        currentFacingMode: 'user', // Ingestion defaults to front camera
        findingFacingMode: 'environment', // Finding defaults to rear camera
        camStream: null,
        findingCamStream: null,
        scanInterval: null,
        findingScanInterval: null,
        barcodeDetector: null,
        findingBarcodeDetector: null,
        zxingReader: null,
        ackDebounceTimer: null,
        hudDismissTimer: null,
        
        // Long Press State
        longPressTimer: null,
        longPressAnimId: null,
        longPressStartTime: 0
    };

    // DOM Elements
    const elements = {
        // Nav Badge
        navProgressPill: document.getElementById('navProgressPill'),
        navPillLabel: document.getElementById('navPillLabel'),
        navPillCount: document.getElementById('navPillCount'),
        navPillTotal: document.getElementById('navPillTotal'),
        
        // Sections
        receiverSection: document.getElementById('receiverSection'),
        resultsSection: document.getElementById('resultsSection'),
        findingSection: document.getElementById('findingSection'),
        
        // View Mode Toolbar (Ingestion)
        viewSplitBtn: document.getElementById('viewSplitBtn'),
        viewMaxAckBtn: document.getElementById('viewMaxAckBtn'),
        viewMaxCamBtn: document.getElementById('viewMaxCamBtn'),
        flipClientCamBtn: document.getElementById('flipClientCamBtn'),
        
        // Ingestion Top Panels & Columns
        panelGridContainer: document.getElementById('panelGridContainer'),
        camPanelCol: document.getElementById('camPanelCol'),
        ackPanelCol: document.getElementById('ackPanelCol'),
        
        // Ingestion Camera
        cameraBox: document.getElementById('cameraBox'),
        clientVideo: document.getElementById('clientVideo'),
        clientScanCanvas: document.getElementById('clientScanCanvas'),
        clientScanBox: document.getElementById('clientScanBox'),
        camLoading: document.getElementById('camLoading'),
        camLoadingText: document.getElementById('camLoadingText'),
        lastCapturedCode: document.getElementById('lastCapturedCode'),
        
        // Ingestion Progress
        capturedCountText: document.getElementById('capturedCountText'),
        targetTotalText: document.getElementById('targetTotalText'),
        progressPercentText: document.getElementById('progressPercentText'),
        progressBarFill: document.getElementById('progressBarFill'),
        clientGrid: document.getElementById('clientGrid'),
        
        // Ingestion ACK QR
        ackCanvas: document.getElementById('ackCanvas'),
        ackCountBadge: document.getElementById('ackCountBadge'),
        
        // Results Screen
        finalAckCanvas: document.getElementById('finalAckCanvas'),
        resultsTotalBadge: document.getElementById('resultsTotalBadge'),
        startFindingBtn: document.getElementById('startFindingBtn'),
        resultsListCard: document.getElementById('resultsListCard'),
        resultsList: document.getElementById('resultsList'),
        
        // Finding Mode Elements
        findingCameraViewport: document.getElementById('findingCameraViewport'),
        findingVideo: document.getElementById('findingVideo'),
        findingHudOverlay: document.getElementById('findingHudOverlay'),
        hudCodePrefix: document.getElementById('hudCodePrefix'),
        hudCodeLast4: document.getElementById('hudCodeLast4'),
        findingStatusMessage: document.getElementById('findingStatusMessage'),
        findingListToggleBtn: document.getElementById('findingListToggleBtn'),
        findingFlipCamBtn: document.getElementById('findingFlipCamBtn'),
        findingExitBtn: document.getElementById('findingExitBtn'),
        findingListDrawer: document.getElementById('findingListDrawer'),
        findingChecklist: document.getElementById('findingChecklist'),
        closeDrawerBtn: document.getElementById('closeDrawerBtn'),
        drawerFoundCount: document.getElementById('drawerFoundCount'),
        drawerTotalCount: document.getElementById('drawerTotalCount'),
        
        // Fixed Bottom Bar
        fixedBottomBar: document.getElementById('fixedBottomBar'),
        exportJsonBtn: document.getElementById('exportJsonBtn'),
        copyAllBtn: document.getElementById('copyAllBtn'),
        toggleListBtn: document.getElementById('toggleListBtn'),
        scanAgainBtn: document.getElementById('scanAgainBtn'),
        resetBtnLabel: document.getElementById('resetBtnLabel'),
        resetProgressFill: document.getElementById('resetProgressFill')
    };

    // =========================================================================
    // AUDIO SYNTHESIZER
    // =========================================================================
    let audioCtx = null;
    function playChirp(isSuccess = true) {
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

            if (isSuccess) {
                // High double chirp for barcode capture
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1046.50, now); // C6
                osc.frequency.exponentialRampToValueAtTime(1567.98, now + 0.08); // G6
                gain.gain.setValueAtTime(0.22, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
                osc.start(now);
                osc.stop(now + 0.12);
            } else {
                // Low pitch warning tone
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(300, now);
                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
            }
        } catch (e) {}
    }

    function playResetTone() {
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

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(520, now);
            osc.frequency.exponentialRampToValueAtTime(220, now + 0.25);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        } catch (e) {}
    }

    // =========================================================================
    // INGESTION VIEW MODE MANAGEMENT
    // =========================================================================

    function setViewMode(mode) {
        state.viewMode = mode;

        if (elements.panelGridContainer) {
            elements.panelGridContainer.classList.remove('mode-split', 'mode-max-ack', 'mode-max-cam');
            elements.panelGridContainer.classList.add(`mode-${mode}`);
        }

        const btnMap = {
            'split': elements.viewSplitBtn,
            'max-ack': elements.viewMaxAckBtn,
            'max-cam': elements.viewMaxCamBtn
        };

        Object.keys(btnMap).forEach(k => {
            const btn = btnMap[k];
            if (!btn) return;
            if (k === mode) {
                btn.classList.remove('btn-secondary');
                btn.classList.add('btn-primary');
            } else {
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
            }
        });
    }

    function toggleMaximizePanel(target) {
        if (state.viewMode === target) {
            setViewMode('split');
        } else {
            setViewMode(target);
        }
    }

    // =========================================================================
    // INGESTION GRID & TOTALS
    // =========================================================================

    function buildGridDOM() {
        if (!elements.clientGrid) return;
        elements.clientGrid.innerHTML = '';

        for (let i = 0; i < state.totalCount; i++) {
            const block = document.createElement('div');
            const isCaptured = state.receivedMap.has(i);
            block.className = isCaptured ? 'chunk-block ack' : 'chunk-block missing';
            block.id = `clientBlock_${i}`;
            const item = state.receivedMap.get(i);
            block.title = isCaptured ? `Barcode #${i + 1}: ${item.tote}` : `Barcode #${i + 1} (Missing)`;
            elements.clientGrid.appendChild(block);
        }
    }

    function setTargetTotal(count) {
        if (count === state.totalCount && state.hasReceivedLastMarker) return;
        state.totalCount = count;
        state.hasReceivedLastMarker = true;

        if (elements.targetTotalText) elements.targetTotalText.textContent = count;
        if (elements.navPillTotal) elements.navPillTotal.textContent = count;
        buildGridDOM();
        updateProgressUI();
        updateAckQRCode();
    }

    // =========================================================================
    // INGESTION CAMERA CONTROLS (FRONT FACING DEFAULT)
    // =========================================================================

    async function stopCamera() {
        if (state.scanInterval) {
            clearInterval(state.scanInterval);
            state.scanInterval = null;
        }

        if (state.camStream) {
            const tracks = state.camStream.getTracks();
            tracks.forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.camStream = null;
        }

        if (elements.clientVideo) {
            elements.clientVideo.srcObject = null;
        }

        state.isScanning = false;
        await new Promise(r => setTimeout(r, 150));
    }

    async function startCamera() {
        await stopCamera();

        if (elements.camLoading) {
            if (elements.camLoadingText) {
                elements.camLoadingText.textContent = `Starting ${state.currentFacingMode === 'user' ? 'front' : 'rear'} camera...`;
            }
            elements.camLoading.style.display = 'flex';
        }

        try {
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: state.currentFacingMode },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    }
                });
            } catch (errPreferred) {
                console.warn('Preferred camera facingMode failed, falling back to generic video constraint:', errPreferred);
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: true
                });
            }

            state.camStream = stream;

            if (elements.clientVideo) {
                elements.clientVideo.srcObject = stream;
                await elements.clientVideo.play().catch(e => console.warn('Video play warning:', e));
            }

            state.isScanning = true;
            if (elements.camLoading) elements.camLoading.style.display = 'none';

            startScanLoop();
        } catch (err) {
            console.error('Client camera error:', err);
            if (elements.camLoadingText) {
                elements.camLoadingText.textContent = 'Camera error: ' + (err.message || err.name || 'Check permissions');
            }
            showToast('Camera error: ' + (err.message || err.name), 'error');
        }
    }

    function flipCamera() {
        state.currentFacingMode = (state.currentFacingMode === 'user') ? 'environment' : 'user';
        startCamera();
    }

    // =========================================================================
    // INGESTION SCANNING LOOP (QR CODES)
    // =========================================================================

    function startScanLoop() {
        if ('BarcodeDetector' in window && !state.barcodeDetector) {
            try {
                state.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
            } catch (e) {}
        }

        const canvas = elements.clientScanCanvas || document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        state.scanInterval = setInterval(async () => {
            if (!state.isScanning || !elements.clientVideo || state.phase !== 'receiving') return;
            if (elements.clientVideo.readyState < 2) return;

            // 1. Native BarcodeDetector
            if (state.barcodeDetector) {
                try {
                    const codes = await state.barcodeDetector.detect(elements.clientVideo);
                    if (codes && codes.length > 0) {
                        for (const item of codes) {
                            if (item.rawValue) processDetectedQrCode(item.rawValue);
                        }
                        return;
                    }
                } catch (e) {}
            }

            // 2. Fallback to jsQR
            if (typeof jsQR !== 'undefined') {
                canvas.width = elements.clientVideo.videoWidth || 640;
                canvas.height = elements.clientVideo.videoHeight || 480;
                ctx.drawImage(elements.clientVideo, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const result = jsQR(imageData.data, imageData.width, imageData.height);
                if (result && result.data) {
                    processDetectedQrCode(result.data);
                }
            }
        }, 55);
    }

    function processDetectedQrCode(text) {
        if (!text || typeof text !== 'string' || state.phase !== 'receiving') return;
        text = text.trim();

        const match = text.match(/^ts(\d+)-(.+?)(-last)?$/);
        if (!match) return;

        const index = parseInt(match[1], 10);
        const rawTote = match[2];
        const isLast = Boolean(match[3]);

        if (isLast && !state.hasReceivedLastMarker) {
            setTargetTotal(index + 1);
        }

        if (state.receivedMap.has(index)) return;

        const now = new Date().toISOString();
        state.receivedMap.set(index, {
            index: index,
            tote: rawTote,
            rawCode: text,
            timestamp: now
        });

        // Register in lookup table for instant finding mode matching
        state.toteLookup.set(rawTote.trim(), index);
        state.toteLookup.set(rawTote.trim().toUpperCase(), index);

        playChirp(true);
        if (elements.clientScanBox) {
            elements.clientScanBox.classList.add('success');
            setTimeout(() => {
                if (elements.clientScanBox) elements.clientScanBox.classList.remove('success');
            }, 250);
        }

        if (elements.lastCapturedCode) {
            elements.lastCapturedCode.textContent = `[#${index + 1}] ${rawTote}`;
        }

        const block = document.getElementById(`clientBlock_${index}`);
        if (block) {
            block.className = 'chunk-block ack just-added';
            block.title = `Barcode #${index + 1}: ${rawTote}`;
            setTimeout(() => {
                if (block) block.classList.remove('just-added');
            }, 400);
        }

        updateProgressUI();
        queueAckQrUpdate();

        if (state.receivedMap.size >= state.totalCount) {
            onAllTotesIngested();
        }
    }

    function updateProgressUI() {
        const count = (state.phase === 'finding') ? state.foundMap.size : state.receivedMap.size;
        const total = state.totalCount;
        const percent = Math.min(100, Math.round((count / total) * 100));

        if (elements.capturedCountText) elements.capturedCountText.textContent = count;
        if (elements.targetTotalText) elements.targetTotalText.textContent = total;
        if (elements.navPillCount) elements.navPillCount.textContent = count;
        if (elements.navPillTotal) elements.navPillTotal.textContent = total;
        if (elements.progressPercentText) elements.progressPercentText.textContent = `${percent}%`;
        if (elements.progressBarFill) elements.progressBarFill.style.width = `${percent}%`;

        // Terminology & Left-to-Right Progress Gradient Fill on Nav Pill
        if (elements.navProgressPill) {
            if (state.phase === 'finding') {
                if (elements.navPillLabel) elements.navPillLabel.textContent = 'Found:';
            } else {
                if (elements.navPillLabel) elements.navPillLabel.textContent = 'Received:';
            }
            elements.navProgressPill.style.background = `linear-gradient(to right, rgba(16, 185, 129, 0.45) 0%, rgba(16, 185, 129, 0.45) ${percent}%, rgba(255, 255, 255, 0.08) ${percent}%, rgba(255, 255, 255, 0.08) 100%)`;
        }
    }

    // =========================================================================
    // HEX BITSET ACK QR GENERATOR
    // =========================================================================

    function encodeAckHexBitset(receivedSet, total = 100) {
        let hex = '';
        const numNibbles = Math.ceil(total / 4);
        for (let nib = 0; nib < numNibbles; nib++) {
            let val = 0;
            for (let b = 0; b < 4; b++) {
                const idx = nib * 4 + b;
                if (idx < total && receivedSet.has(idx)) {
                    val |= (1 << b);
                }
            }
            hex += val.toString(16);
        }
        return `ACK:H:${hex}`;
    }

    function queueAckQrUpdate() {
        // Update immediately with zero delay so host webcam gets real-time ACK feedback
        updateAckQRCode();
    }

    function updateAckQRCode() {
        if (!elements.ackCanvas) return;

        const count = state.receivedMap.size;
        if (elements.ackCountBadge) {
            elements.ackCountBadge.textContent = `${count} / ${state.totalCount}`;
        }

        if (count === 0) {
            elements.ackCanvas.width = 220;
            elements.ackCanvas.height = 220;
            const ctx = elements.ackCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 220, 220);
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting scans...', 110, 115);
            return;
        }

        const payload = encodeAckHexBitset(state.receivedMap, state.totalCount);

        if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            try {
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    width: 220,
                    height: 220,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            } catch (e) {
                console.warn('ACK QR draw error:', e);
            }
        }
    }

    // =========================================================================
    // INGESTION COMPLETION & RESULTS SCREEN
    // =========================================================================

    async function onAllTotesIngested() {
        if (state.phase !== 'receiving') return;
        state.phase = 'results';

        await stopCamera();

        // Switch to Results Screen
        if (elements.receiverSection) elements.receiverSection.style.display = 'none';
        if (elements.findingSection) elements.findingSection.style.display = 'none';
        if (elements.resultsSection) elements.resultsSection.style.display = 'block';
        if (elements.fixedBottomBar) elements.fixedBottomBar.style.display = 'block';

        if (elements.resultsTotalBadge) {
            elements.resultsTotalBadge.textContent = `${state.totalCount} Barcodes Received`;
        }

        // Draw Full Completed ACK QR at top of results screen
        if (elements.finalAckCanvas && window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            const finalPayload = encodeAckHexBitset(state.receivedMap, state.totalCount);
            try {
                window.QRCodeLib.drawToCanvas(elements.finalAckCanvas, finalPayload, {
                    width: 240,
                    height: 240,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            } catch (e) {
                console.warn('Final ACK QR error:', e);
            }
        }

        renderResultsList();
        updateProgressUI();
        showToast('All barcodes ingested! Ready to find physical totes.', 'success', 5000);
    }

    function renderResultsList() {
        if (!elements.resultsList) return;

        const items = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            const tote = item ? item.tote : `BC_${i + 1}`;
            const isFound = state.foundMap.has(i);
            const time = item ? new Date(item.timestamp).toLocaleTimeString() : '';
            
            items.push(`
                <div class="scanned-item ${isFound ? 'is-found' : ''}" id="resultItem_${i}">
                    <div class="scanned-item-info">
                        <span class="scanned-item-code">
                            ${isFound ? '<span class="found-check-icon">✅</span>' : '<span class="pending-icon">⏳</span>'}
                            ${escapeHtml(tote)}
                        </span>
                        <div class="scanned-item-meta">
                            <span class="scanned-item-badge peer">#${i + 1}</span>
                            <span>${isFound ? 'Found' : 'Ingested ' + escapeHtml(time)}</span>
                        </div>
                    </div>
                    <div class="scanned-item-actions">
                        <button class="item-action-btn copy-btn" data-code="${escapeHtml(tote)}" title="Copy">📋</button>
                    </div>
                </div>
            `);
        }

        elements.resultsList.innerHTML = items.join('');

        elements.resultsList.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.getAttribute('data-code');
                if (code) {
                    navigator.clipboard.writeText(code).then(() => {
                        showToast(`Copied: ${code}`, 'success');
                    });
                }
            });
        });
    }

    function toggleListVisibility() {
        state.isListVisible = !state.isListVisible;
        if (elements.resultsListCard) {
            elements.resultsListCard.style.display = state.isListVisible ? 'block' : 'none';
        }
        if (elements.toggleListBtn) {
            elements.toggleListBtn.textContent = state.isListVisible ? '🙈 Hide List' : '📜 Show List';
        }
    }

    // =========================================================================
    // PHYSICAL FINDING MODE (CODE 128 SCANNER & HUD)
    // =========================================================================

    async function enterFindingMode() {
        state.phase = 'finding';

        // Hide receiving and results, show full page finding section
        if (elements.receiverSection) elements.receiverSection.style.display = 'none';
        if (elements.resultsSection) elements.resultsSection.style.display = 'none';
        if (elements.fixedBottomBar) elements.fixedBottomBar.style.display = 'none';
        if (elements.findingSection) elements.findingSection.style.display = 'block';

        updateProgressUI();
        buildFindingChecklistDOM();
        await startFindingCamera();
    }

    async function exitFindingMode() {
        await stopFindingCamera();
        state.phase = 'results';

        if (elements.findingSection) elements.findingSection.style.display = 'none';
        if (elements.resultsSection) elements.resultsSection.style.display = 'block';
        if (elements.fixedBottomBar) elements.fixedBottomBar.style.display = 'block';

        renderResultsList();
        updateProgressUI();
    }

    async function stopFindingCamera() {
        if (state.findingScanInterval) {
            clearInterval(state.findingScanInterval);
            state.findingScanInterval = null;
        }

        if (state.findingCamStream) {
            state.findingCamStream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.findingCamStream = null;
        }

        if (elements.findingVideo) {
            elements.findingVideo.srcObject = null;
        }

        state.isFindingScanning = false;
        await new Promise(r => setTimeout(r, 150));
    }

    async function startFindingCamera() {
        await stopFindingCamera();

        try {
            let stream = null;
            // Prefer rear environment camera for physical barcode hunting
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: state.findingFacingMode },
                        width: { ideal: 1280 },
                        height: { ideal: 720 }
                    }
                });
            } catch (errPref) {
                console.warn('Finding rear camera failed, fallback to generic video:', errPref);
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: true
                });
            }

            state.findingCamStream = stream;

            if (elements.findingVideo) {
                elements.findingVideo.srcObject = stream;
                await elements.findingVideo.play().catch(e => console.warn('Finding video play warning:', e));
            }

            state.isFindingScanning = true;
            startFindingScanLoop();
        } catch (err) {
            console.error('Finding camera error:', err);
            showToast('Finding camera error: ' + (err.message || err.name), 'error');
        }
    }

    function flipFindingCamera() {
        state.findingFacingMode = (state.findingFacingMode === 'environment') ? 'user' : 'environment';
        startFindingCamera();
    }

    function startFindingScanLoop() {
        // Initialize BarcodeDetector for Code 128 and common 1D barcodes
        if ('BarcodeDetector' in window && !state.findingBarcodeDetector) {
            try {
                state.findingBarcodeDetector = new BarcodeDetector({
                    formats: ['code_128', 'code_39', 'ean_13', 'upc_a', 'itf', 'qr_code']
                });
            } catch (e) {
                console.warn('BarcodeDetector 1D format error:', e);
            }
        }

        // Initialize ZXing MultiFormatReader fallback
        if (typeof ZXing !== 'undefined' && !state.zxingReader) {
            try {
                state.zxingReader = new ZXing.BrowserMultiFormatReader();
            } catch (e) {
                console.warn('ZXing init error:', e);
            }
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        state.findingScanInterval = setInterval(async () => {
            if (!state.isFindingScanning || !elements.findingVideo || state.phase !== 'finding') return;
            if (elements.findingVideo.readyState < 2) return;

            // 1. Native BarcodeDetector (Ultra fast on Chrome/Android/iOS 17+)
            if (state.findingBarcodeDetector) {
                try {
                    const barcodes = await state.findingBarcodeDetector.detect(elements.findingVideo);
                    if (barcodes && barcodes.length > 0) {
                        for (const b of barcodes) {
                            if (b.rawValue) processPhysicalBarcode(b.rawValue);
                        }
                        return;
                    }
                } catch (e) {}
            }

            // 2. ZXing BrowserMultiFormatReader Fallback for 1D barcodes
            if (state.zxingReader) {
                try {
                    canvas.width = elements.findingVideo.videoWidth || 640;
                    canvas.height = elements.findingVideo.videoHeight || 480;
                    ctx.drawImage(elements.findingVideo, 0, 0, canvas.width, canvas.height);
                    
                    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const luminanceSource = new ZXing.RGBLuminanceSource(img.data, canvas.width, canvas.height);
                    const binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
                    const result = state.zxingReader.decodeBitmap(binaryBitmap);
                    if (result && result.getText()) {
                        processPhysicalBarcode(result.getText());
                    }
                } catch (e) {}
            }
        }, 80);
    }

    function processPhysicalBarcode(rawText) {
        if (!rawText || state.phase !== 'finding') return;
        const code = String(rawText).trim();

        // Check if code matches any received tote
        let matchedIndex = -1;
        if (state.toteLookup.has(code)) {
            matchedIndex = state.toteLookup.get(code);
        } else if (state.toteLookup.has(code.toUpperCase())) {
            matchedIndex = state.toteLookup.get(code.toUpperCase());
        } else {
            // Also check if prefix tsXX- is attached or stripped
            const stripped = code.replace(/^ts\d+-/, '').replace(/-last$/, '');
            if (state.toteLookup.has(stripped)) {
                matchedIndex = state.toteLookup.get(stripped);
            }
        }

        if (matchedIndex === -1) {
            // Not in our received list
            return;
        }

        const toteData = state.receivedMap.get(matchedIndex);
        const toteName = toteData ? toteData.tote : code;

        // Check if already found
        const isNewlyFound = !state.foundMap.has(matchedIndex);
        if (isNewlyFound) {
            state.foundMap.set(matchedIndex, {
                index: matchedIndex,
                tote: toteName,
                foundAt: new Date().toISOString()
            });

            playChirp(true);
            triggerHapticFeedback();
            updateProgressUI();
            updateFindingChecklist();

            if (state.foundMap.size >= state.totalCount) {
                showToast('🎉 ALL 100 TOTES FOUND! Mission accomplished!', 'success', 6000);
            }
        }

        // Display Floating Scanned HUD with bold last 4 digits
        showScannedToteHud(toteName, isNewlyFound);
    }

    function showScannedToteHud(toteCode, isNew) {
        if (!elements.findingHudOverlay) return;

        // Format barcode: bold last 4 digits
        const codeStr = String(toteCode);
        let prefix = codeStr;
        let last4 = '';

        if (codeStr.length > 4) {
            prefix = codeStr.slice(0, -4);
            last4 = codeStr.slice(-4);
        } else {
            prefix = '';
            last4 = codeStr;
        }

        if (elements.hudCodePrefix) elements.hudCodePrefix.textContent = prefix;
        if (elements.hudCodeLast4) elements.hudCodeLast4.textContent = last4;

        if (elements.findingStatusMessage) {
            elements.findingStatusMessage.textContent = isNew ? `Found: ${toteCode} ✅` : `Already Found: ${toteCode}`;
        }

        // Show HUD overlay
        elements.findingHudOverlay.style.display = 'flex';
        elements.findingHudOverlay.classList.remove('hud-fading');
        elements.findingHudOverlay.classList.add('hud-visible');

        if (state.hudDismissTimer) clearTimeout(state.hudDismissTimer);

        // Fade out after 1.7s, hide after 2.0s
        state.hudDismissTimer = setTimeout(() => {
            if (elements.findingHudOverlay) {
                elements.findingHudOverlay.classList.remove('hud-visible');
                elements.findingHudOverlay.classList.add('hud-fading');
                setTimeout(() => {
                    if (elements.findingHudOverlay) elements.findingHudOverlay.style.display = 'none';
                }, 300);
            }
        }, 1700);
    }

    function triggerHapticFeedback() {
        try {
            if ('vibrate' in navigator) {
                navigator.vibrate([80, 40, 80]);
            }
        } catch (e) {}
    }

    function buildFindingChecklistDOM() {
        if (!elements.findingChecklist) return;
        updateFindingChecklist();
    }

    function updateFindingChecklist() {
        if (!elements.findingChecklist) return;

        const count = state.foundMap.size;
        const total = state.totalCount;

        if (elements.drawerFoundCount) elements.drawerFoundCount.textContent = count;
        if (elements.drawerTotalCount) elements.drawerTotalCount.textContent = total;

        const items = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            const tote = item ? item.tote : `BC_${i + 1}`;
            const isFound = state.foundMap.has(i);
            
            items.push(`
                <div class="scanned-item ${isFound ? 'is-found' : 'is-pending'}">
                    <div class="scanned-item-info">
                        <span class="scanned-item-code">
                            ${isFound ? '<span class="found-check-icon">✅</span>' : '<span class="pending-icon">⏳</span>'}
                            ${escapeHtml(tote)}
                        </span>
                        <div class="scanned-item-meta">
                            <span class="scanned-item-badge peer">#${i + 1}</span>
                            <span>${isFound ? 'Found' : 'Missing'}</span>
                        </div>
                    </div>
                </div>
            `);
        }

        elements.findingChecklist.innerHTML = items.join('');
    }

    function toggleFindingListDrawer() {
        state.isDrawerVisible = !state.isDrawerVisible;
        if (elements.findingListDrawer) {
            elements.findingListDrawer.style.display = state.isDrawerVisible ? 'flex' : 'none';
        }
    }

    // =========================================================================
    // 5-SECOND LONG PRESS DESTRUCTIVE RESET HANDLER
    // =========================================================================

    function startLongPressReset(e) {
        if (e.type === 'pointerdown' && e.button !== 0) return; // Left click only
        
        state.longPressStartTime = performance.now();
        if (elements.scanAgainBtn) elements.scanAgainBtn.classList.add('long-press-active');

        function animateProgress(now) {
            const elapsed = now - state.longPressStartTime;
            const progress = Math.min(1, elapsed / LONG_PRESS_MS);
            const percent = Math.round(progress * 100);

            if (elements.resetProgressFill) {
                elements.resetProgressFill.style.width = `${percent}%`;
            }

            if (elements.resetBtnLabel) {
                const remaining = Math.max(0, Math.ceil((LONG_PRESS_MS - elapsed) / 1000));
                elements.resetBtnLabel.textContent = `⚠️ Hold ${remaining}s...`;
            }

            if (progress < 1) {
                state.longPressAnimId = requestAnimationFrame(animateProgress);
            } else {
                // 5 seconds completed!
                executeFullReset();
            }
        }

        state.longPressAnimId = requestAnimationFrame(animateProgress);
    }

    function cancelLongPressReset() {
        if (state.longPressAnimId) {
            cancelAnimationFrame(state.longPressAnimId);
            state.longPressAnimId = null;
        }

        if (elements.scanAgainBtn) elements.scanAgainBtn.classList.remove('long-press-active');
        if (elements.resetProgressFill) elements.resetProgressFill.style.width = '0%';
        if (elements.resetBtnLabel) elements.resetBtnLabel.textContent = '🔄 Reset (Hold 5s)';
    }

    async function executeFullReset() {
        cancelLongPressReset();
        playResetTone();

        try {
            if ('vibrate' in navigator) navigator.vibrate([150, 50, 150]);
        } catch (e) {}

        // Reset all application state
        state.phase = 'receiving';
        state.hasReceivedLastMarker = false;
        state.receivedMap.clear();
        state.toteLookup.clear();
        state.foundMap.clear();
        state.isListVisible = false;
        state.isDrawerVisible = false;

        await stopFindingCamera();
        await stopCamera();

        buildGridDOM();
        updateProgressUI();
        updateAckQRCode();

        if (elements.resultsSection) elements.resultsSection.style.display = 'none';
        if (elements.resultsListCard) elements.resultsListCard.style.display = 'none';
        if (elements.findingSection) elements.findingSection.style.display = 'none';
        if (elements.findingListDrawer) elements.findingListDrawer.style.display = 'none';
        if (elements.fixedBottomBar) elements.fixedBottomBar.style.display = 'none';
        if (elements.receiverSection) elements.receiverSection.style.display = 'block';

        setViewMode('split');
        await startCamera();

        showToast('Application reset. Ready for new QR broadcast.', 'info');
    }

    // =========================================================================
    // EXPORT & CLIPBOARD UTILITIES
    // =========================================================================

    function exportJSON() {
        const exportData = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            const isFound = state.foundMap.has(i);
            const foundData = state.foundMap.get(i);
            exportData.push({
                index: i + 1,
                barcode: item ? item.tote : `BC_${i + 1}`,
                ingestedAt: item ? item.timestamp : null,
                found: isFound,
                foundAt: foundData ? foundData.foundAt : null
            });
        }

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
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

        showToast(`Exported ${exportData.length} Barcodes as JSON file`, 'success');
    }

    function copyAllToClipboard() {
        const lines = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            lines.push(item ? item.tote : `BC_${i + 1}`);
        }

        navigator.clipboard.writeText(lines.join('\n')).then(() => {
            showToast(`Copied all ${lines.length} Barcodes to clipboard!`, 'success');
        }).catch(err => {
            showToast('Failed to copy to clipboard', 'error');
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
    // INITIALIZATION & EVENT BINDINGS
    // =========================================================================

    function bindEvents() {
        // Ingestion View Mode Buttons
        if (elements.viewSplitBtn) elements.viewSplitBtn.addEventListener('click', () => setViewMode('split'));
        if (elements.viewMaxAckBtn) elements.viewMaxAckBtn.addEventListener('click', () => setViewMode('max-ack'));
        if (elements.viewMaxCamBtn) elements.viewMaxCamBtn.addEventListener('click', () => setViewMode('max-cam'));
        if (elements.flipClientCamBtn) elements.flipClientCamBtn.addEventListener('click', flipCamera);

        // Tap on panels directly to toggle focus
        if (elements.ackPanelCol) {
            elements.ackPanelCol.addEventListener('click', () => toggleMaximizePanel('max-ack'));
        }
        if (elements.camPanelCol) {
            elements.camPanelCol.addEventListener('click', () => toggleMaximizePanel('max-cam'));
        }

        // Results Screen Buttons
        if (elements.startFindingBtn) elements.startFindingBtn.addEventListener('click', enterFindingMode);
        if (elements.exportJsonBtn) elements.exportJsonBtn.addEventListener('click', exportJSON);
        if (elements.copyAllBtn) elements.copyAllBtn.addEventListener('click', copyAllToClipboard);
        if (elements.toggleListBtn) elements.toggleListBtn.addEventListener('click', toggleListVisibility);

        // 5-Second Long Press Reset Handlers
        if (elements.scanAgainBtn) {
            elements.scanAgainBtn.addEventListener('pointerdown', startLongPressReset);
            elements.scanAgainBtn.addEventListener('pointerup', cancelLongPressReset);
            elements.scanAgainBtn.addEventListener('pointercancel', cancelLongPressReset);
            elements.scanAgainBtn.addEventListener('pointerleave', cancelLongPressReset);
            elements.scanAgainBtn.addEventListener('contextmenu', e => e.preventDefault());
        }

        // Finding Mode Controls
        if (elements.findingListToggleBtn) elements.findingListToggleBtn.addEventListener('click', toggleFindingListDrawer);
        if (elements.findingFlipCamBtn) elements.findingFlipCamBtn.addEventListener('click', flipFindingCamera);
        if (elements.findingExitBtn) elements.findingExitBtn.addEventListener('click', exitFindingMode);
        if (elements.closeDrawerBtn) elements.closeDrawerBtn.addEventListener('click', toggleFindingListDrawer);

        window.addEventListener('beforeunload', () => {
            stopCamera();
            stopFindingCamera();
        });
    }

    function init() {
        buildGridDOM();
        bindEvents();
        setViewMode('split');
        updateProgressUI();
        startCamera();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
