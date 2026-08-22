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
        hasEstablishedTotal: false,
        hasReceivedLastMarker: false,
        receivedMap: new Map(), // index -> { index, tote, rawCode, timestamp }
        toteLookup: new Map(), // normalizedTote -> index
        foundMap: new Map(), // index -> { index, tote, foundAt }
        viewMode: 'split', // 'split' | 'max-ack' | 'max-cam'
        isListVisible: false,
        isDrawerVisible: false,
        isScanning: false,
        isFindingScanning: false,
        isTorchOn: false,
        currentFacingMode: 'user', // Ingestion: 'user' (1-to-1) or 'environment' (Group)
        findingFacingMode: 'environment', // Finding defaults to rear camera
        camStream: null,
        findingCamStream: null,
        scanInterval: null,
        findingScanInterval: null,
        barcodeDetector: null,
        findingBarcodeDetector: null,
        cooldownMap: new Map(), // code -> lastScannedTimestamp
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
        
        // Ingestion Mode Toolbar
        clientMode1to1Btn: document.getElementById('clientMode1to1Btn'),
        clientModeGroupBtn: document.getElementById('clientModeGroupBtn'),
        floatingFlipCamBtn: document.getElementById('floatingFlipCamBtn'),
        
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
        hudContentCard: document.getElementById('hudContentCard'),
        hudCheckBadge: document.getElementById('hudCheckBadge'),
        hudTitleText: document.getElementById('hudTitleText'),
        hudCodePrefix: document.getElementById('hudCodePrefix'),
        hudCodeLast4: document.getElementById('hudCodeLast4'),
        findingListToggleBtn: document.getElementById('findingListToggleBtn'),
        findingTorchBtn: document.getElementById('findingTorchBtn'),
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
    // INGESTION TRANSMISSION MODE MANAGEMENT (1-to-1 Handshake vs Group Multicast)
    // =========================================================================

    function setClientTransmissionMode(mode) {
        state.clientTransmissionMode = mode; // '1to1' or 'group'

        if (mode === '1to1') {
            state.currentFacingMode = 'user'; // Front camera for desk-based 1-to-1 handshake
            if (elements.clientMode1to1Btn) {
                elements.clientMode1to1Btn.classList.add('btn-primary');
                elements.clientMode1to1Btn.classList.remove('btn-secondary');
            }
            if (elements.clientModeGroupBtn) {
                elements.clientModeGroupBtn.classList.remove('btn-primary');
                elements.clientModeGroupBtn.classList.add('btn-secondary');
            }
            if (elements.panelGridContainer) {
                elements.panelGridContainer.classList.remove('mode-group');
                elements.panelGridContainer.classList.add('mode-1to1');
            }
            if (elements.ackPanelCol) {
                elements.ackPanelCol.style.display = 'flex';
            }
        } else {
            state.currentFacingMode = 'environment'; // Rear camera for scanning large group broadcast screen
            if (elements.clientModeGroupBtn) {
                elements.clientModeGroupBtn.classList.add('btn-primary');
                elements.clientModeGroupBtn.classList.remove('btn-secondary');
            }
            if (elements.clientMode1to1Btn) {
                elements.clientMode1to1Btn.classList.remove('btn-primary');
                elements.clientMode1to1Btn.classList.add('btn-secondary');
            }
            if (elements.panelGridContainer) {
                elements.panelGridContainer.classList.remove('mode-1to1');
                elements.panelGridContainer.classList.add('mode-group');
            }
            if (elements.ackPanelCol) {
                elements.ackPanelCol.style.display = 'none';
            }
        }

        if (state.phase === 'receiving') {
            startCamera();
        }
    }

    // =========================================================================
    // INGESTION GRID & TOTALS
    // =========================================================================

    function buildGridDOM() {
        if (!elements.clientGrid) return;
        elements.clientGrid.innerHTML = '';

        if (!state.hasEstablishedTotal && state.receivedMap.size === 0) {
            const hint = document.createElement('div');
            hint.style.gridColumn = '1 / -1';
            hint.style.padding = '14px 10px';
            hint.style.textAlign = 'center';
            hint.style.color = 'var(--text-muted)';
            hint.style.fontSize = '0.78rem';
            hint.style.fontStyle = 'italic';
            hint.textContent = 'Point camera at host broadcast to establish barcode manifest...';
            elements.clientGrid.appendChild(hint);
            return;
        }

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
        if (state.hasEstablishedTotal && count === state.totalCount) return;
        state.totalCount = count;
        state.hasEstablishedTotal = true;
        state.hasReceivedLastMarker = true;

        if (elements.targetTotalText) elements.targetTotalText.textContent = count;
        if (elements.navPillTotal) elements.navPillTotal.textContent = count;
        buildGridDOM();
        updateProgressUI();
        updateAckQRCode();
    }

    // =========================================================================
    // ROBUST HARDWARE CAMERA STREAM ACQUISITION
    // =========================================================================

    async function getMediaStreamForFacingMode(facingMode, isHD = false) {
        const resConstraint = isHD 
            ? { width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 } } 
            : { width: { ideal: 640 }, height: { ideal: 480 } };
        
        // 1. Try exact facingMode (Forces mobile browsers to switch physical lens)
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { exact: facingMode },
                    ...resConstraint
                }
            });
        } catch (e1) {}

        // 2. Try direct facingMode string
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: facingMode,
                    ...resConstraint
                }
            });
        } catch (e2) {}

        // 3. Enumerate physical device IDs and select matching lens
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            if (videoDevices.length > 1) {
                const target = videoDevices.find(d => {
                    const label = (d.label || '').toLowerCase();
                    if (facingMode === 'environment') {
                        return label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('0');
                    } else {
                        return label.includes('front') || label.includes('user') || label.includes('1');
                    }
                });
                if (target && target.deviceId) {
                    return await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: {
                            deviceId: { exact: target.deviceId },
                            ...resConstraint
                        }
                    });
                }
            }
        } catch (e3) {}

        // 4. Try ideal facingMode
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: facingMode },
                    ...resConstraint
                }
            });
        } catch (e4) {}

        // 5. Generic video stream fallback
        return await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
        });
    }

    // =========================================================================
    // INGESTION CAMERA CONTROLS (FRONT / REAR FACING)
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
        // Wait 250ms to allow mobile OS hardware camera driver to fully unbind and release lock
        await new Promise(r => setTimeout(r, 250));
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
            const stream = await getMediaStreamForFacingMode(state.currentFacingMode, false);
            state.camStream = stream;

            if (elements.clientVideo) {
                elements.clientVideo.srcObject = stream;
                if (elements.clientVideo.paused) {
                    try {
                        await elements.clientVideo.play();
                    } catch (e) {
                        if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
                            console.warn('Video play warning:', e);
                        }
                    }
                }
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

        // Supports both ts{index}/{total}-{toteName} and legacy ts{index}-{toteName}
        const match = text.match(/^ts(\d+)(?:\/(\d+))?-(.+?)(-last)?$/);
        if (!match) return;

        const index = parseInt(match[1], 10);
        const frameTotal = match[2] ? parseInt(match[2], 10) : null;
        const rawTote = match[3];
        const isLast = Boolean(match[4]);

        // Establish target total immediately on the very first frame!
        if (frameTotal && frameTotal > 0 && (!state.hasEstablishedTotal || state.totalCount !== frameTotal)) {
            setTargetTotal(frameTotal);
        } else if (isLast && !state.hasEstablishedTotal) {
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

        if (state.hasEstablishedTotal && state.receivedMap.size >= state.totalCount) {
            onAllTotesIngested();
        }
    }

    function updateProgressUI() {
        const count = (state.phase === 'finding') ? state.foundMap.size : state.receivedMap.size;
        const isTotalKnown = state.hasEstablishedTotal || state.phase === 'finding';
        const total = isTotalKnown ? state.totalCount : '--';
        const percent = isTotalKnown ? Math.min(100, Math.round((count / state.totalCount) * 100)) : 0;

        if (elements.capturedCountText) elements.capturedCountText.textContent = count;
        if (elements.targetTotalText) elements.targetTotalText.textContent = total;
        if (elements.navPillCount) elements.navPillCount.textContent = count;
        if (elements.navPillTotal) elements.navPillTotal.textContent = total;
        if (elements.progressPercentText) elements.progressPercentText.textContent = isTotalKnown ? `${percent}%` : '--%';
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
            hex += val.toString(16).toUpperCase();
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
            elements.ackCanvas.width = 180;
            elements.ackCanvas.height = 180;
            const ctx = elements.ackCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 180, 180);
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting scans...', 90, 95);
            return;
        }

        const payload = encodeAckHexBitset(state.receivedMap, state.totalCount);

        if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            try {
                // Force Version 2 (25x25) with Level L for big, coarse, chunky scan modules
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    typeNumber: 2,
                    width: 180,
                    height: 180,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            } catch (e) {
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    width: 180,
                    height: 180,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
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
        await stopCamera();

        // 1. Save current ingested barcodes to localStorage
        if (state.receivedMap.size > 0) {
            const list = [];
            for (let i = 0; i < state.totalCount; i++) {
                if (state.receivedMap.has(i)) {
                    list.push(state.receivedMap.get(i).tote);
                }
            }
            if (list.length > 0) {
                try {
                    localStorage.setItem('peerScanner_barcodes', list.join('\n'));
                } catch (e) {}
            }
        }

        // 2. Fresh Page Reload Transition:
        // Transitioning with a fresh URL (?mode=finding) guarantees the browser OS camera driver completely releases the front camera!
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('mode') !== 'finding') {
            const currentBase = window.location.href.split('?')[0].split('#')[0];
            window.location.replace(`${currentBase}?mode=finding`);
            return;
        }

        state.phase = 'finding';

        // Load barcodes from localStorage or samples
        if (state.receivedMap.size === 0) {
            try {
                const saved = localStorage.getItem('peerScanner_barcodes');
                if (saved && saved.trim().length > 0) {
                    const list = saved.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                    state.totalCount = list.length;
                    list.forEach((tote, i) => {
                        state.receivedMap.set(i, { index: i, tote: tote });
                        state.toteLookup.set(tote, i);
                        state.toteLookup.set(tote.toUpperCase(), i);
                    });
                }
            } catch (e) {}

            if (state.receivedMap.size === 0) {
                // Generate 100 sample barcodes for instant testing
                state.totalCount = 100;
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                for (let i = 0; i < 100; i++) {
                    let randStr = '';
                    for (let k = 0; k < 6; k++) randStr += chars.charAt(Math.floor(Math.random() * chars.length));
                    const tote = `BC_${String(i + 1).padStart(3, '0')}_${randStr}`;
                    state.receivedMap.set(i, { index: i, tote: tote });
                    state.toteLookup.set(tote, i);
                    state.toteLookup.set(tote.toUpperCase(), i);
                }
            }
        }

        // Show full-page physical finding screen
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

        if (typeof Quagga !== 'undefined') {
            try {
                Quagga.offDetected();
                Quagga.stop();
            } catch (e) {}
        }

        if (state.findingCamStream) {
            state.findingCamStream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.findingCamStream = null;
        }

        const container = document.querySelector('#findingCameraViewport');
        if (container) {
            const injectedVideos = container.querySelectorAll('video');
            injectedVideos.forEach(v => {
                try { v.srcObject = null; } catch(e) {}
            });
        }

        state.isFindingScanning = false;
        await new Promise(r => setTimeout(r, 200));
    }

    async function startFindingCamera(retryCount = 0) {
        await stopFindingCamera();

        // 1. Quagga2 Dedicated LiveStream Engine with Polling Retry
        if (typeof Quagga !== 'undefined') {
            try {
                const targetEl = document.querySelector('#findingCameraViewport');
                Quagga.init({
                    inputStream: {
                        name: "LiveStream",
                        type: "LiveStream",
                        target: targetEl,
                        constraints: {
                            facingMode: state.findingFacingMode,
                            width: { min: 640, ideal: 1280, max: 1920 },
                            height: { min: 480, ideal: 720, max: 1080 }
                        },
                        singleChannel: false
                    },
                    locator: {
                        patchSize: "large",
                        halfSample: true
                    },
                    numOfWorkers: (navigator.hardwareConcurrency ? Math.min(4, Math.max(1, navigator.hardwareConcurrency - 1)) : 2),
                    frequency: 15,
                    decoder: {
                        readers: ["code_128_reader"],
                        multiple: false
                    },
                    locate: true
                }, function (err) {
                    if (err) {
                        console.warn(`[Quagga LiveStream Attempt ${retryCount + 1}] Hardware busy, polling retry...`, err);
                        if (retryCount < 3) {
                            setTimeout(() => startFindingCamera(retryCount + 1), 400);
                        } else {
                            console.warn('[Quagga LiveStream] Max retries reached, switching to direct video fallback');
                            startFindingCameraFallback();
                        }
                        return;
                    }

                    console.log('[Quagga LiveStream] 🚀 Code 128 Engine Active on', state.findingFacingMode, 'lens!');
                    Quagga.start();
                    state.isFindingScanning = true;

                    Quagga.offDetected();
                    Quagga.onDetected((result) => {
                        if (!state.isFindingScanning || state.phase !== 'finding') return;
                        if (result && result.codeResult && result.codeResult.code) {
                            processPhysicalBarcode(result.codeResult.code);
                        }
                    });
                });
                return;
            } catch (eQ) {
                if (retryCount < 3) {
                    setTimeout(() => startFindingCamera(retryCount + 1), 400);
                    return;
                }
            }
        }

        // 2. Direct Fallback Stream
        await startFindingCameraFallback();
    }

    async function startFindingCameraFallback() {
        try {
            const stream = await getMediaStreamForFacingMode(state.findingFacingMode, true);
            state.findingCamStream = stream;

            if (elements.findingVideo) {
                elements.findingVideo.srcObject = stream;
                if (elements.findingVideo.paused) {
                    try { await elements.findingVideo.play(); } catch (e) {}
                }
            }

            state.isFindingScanning = true;
            await startFindingScanLoop();
        } catch (err) {
            console.error('Finding camera fallback error:', err);
            showToast('Camera error: ' + (err.message || err.name), 'error');
        }
    }

    async function toggleTorch() {
        let track = null;
        if (typeof Quagga !== 'undefined' && Quagga.CameraAccess) {
            try {
                track = Quagga.CameraAccess.getActiveTrack();
            } catch (e) {}
        }
        if (!track && state.findingCamStream) {
            track = state.findingCamStream.getVideoTracks()[0];
        }

        if (!track) return;

        try {
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            if ('torch' in capabilities) {
                state.isTorchOn = !state.isTorchOn;
                await track.applyConstraints({
                    advanced: [{ torch: state.isTorchOn }]
                });

                if (elements.findingTorchBtn) {
                    elements.findingTorchBtn.textContent = state.isTorchOn ? '🔦 Torch ON' : '🔦 Torch';
                    elements.findingTorchBtn.classList.toggle('btn-primary', state.isTorchOn);
                    elements.findingTorchBtn.classList.toggle('btn-secondary', !state.isTorchOn);
                }
            } else {
                showToast('Torch control not available on this lens', 'info', 2000);
            }
        } catch (err) {
            console.warn('Torch constraint error:', err);
        }
    }

    function flipFindingCamera() {
        state.isTorchOn = false;
        state.findingFacingMode = (state.findingFacingMode === 'environment') ? 'user' : 'environment';
        startFindingCamera();
    }

    async function startFindingScanLoop() {
        let has1DBarcodeDetector = false;

        // 1. Check if hardware BarcodeDetector natively supports 1D Code 128
        if ('BarcodeDetector' in window) {
            try {
                if (typeof BarcodeDetector.getSupportedFormats === 'function') {
                    const formats = await BarcodeDetector.getSupportedFormats();
                    if (formats && formats.includes('code_128')) {
                        state.findingBarcodeDetector = new BarcodeDetector({
                            formats: ['code_128']
                        });
                        has1DBarcodeDetector = true;
                    }
                }
            } catch (e) {
                console.warn('BarcodeDetector 1D check:', e);
            }
        }

        // 2. Initialize ZXing Code 128 Reader
        if (typeof ZXing !== 'undefined' && !state.zxingReader) {
            try {
                const hints = new Map();
                hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128]);
                hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
                state.zxingReader = new ZXing.BrowserMultiFormatReader(hints);
            } catch (eZxing) {
                console.error('[Finder Scan] ZXing init error:', eZxing);
            }
        }

        const scanCanvas = document.createElement('canvas');
        const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
        const rotCanvas = document.createElement('canvas');
        const rotCtx = rotCanvas.getContext('2d', { willReadFrequently: true });

        // 3. Controlled Scanning Loop (60ms interval, Hardware GPU BarcodeDetector + Dual-Axis ZXing)
        state.findingScanInterval = setInterval(async () => {
            if (!state.isFindingScanning || !elements.findingVideo || state.phase !== 'finding') return;
            if (elements.findingVideo.readyState < 2) return;

            let foundCode = null;

            // Step 1: Hardware GPU BarcodeDetector (Zero-copy on Android/iOS)
            if (state.findingBarcodeDetector) {
                try {
                    const barcodes = await state.findingBarcodeDetector.detect(elements.findingVideo);
                    if (barcodes && barcodes.length > 0) {
                        for (const b of barcodes) {
                            if (b.rawValue) {
                                foundCode = b.rawValue;
                                break;
                            }
                        }
                    }
                } catch (eDet) {}
            }

            // Step 2: ZXing Decoder on Raw Video Canvas (Pass A: Horizontal 0°)
            if (!foundCode && state.zxingReader) {
                const vW = elements.findingVideo.videoWidth || 640;
                const vH = elements.findingVideo.videoHeight || 480;
                scanCanvas.width = vW;
                scanCanvas.height = vH;
                scanCtx.drawImage(elements.findingVideo, 0, 0, vW, vH);

                try {
                    const resA = state.zxingReader.decodeFromCanvas(scanCanvas);
                    if (resA && resA.getText()) {
                        foundCode = resA.getText();
                    }
                } catch (eA) {}

                // Step 3: Vertical 90° Rotated Pass for Vertical Tote Barcodes
                if (!foundCode) {
                    rotCanvas.width = vH;
                    rotCanvas.height = vW;
                    rotCtx.save();
                    rotCtx.translate(vH / 2, vW / 2);
                    rotCtx.rotate(Math.PI / 2);
                    rotCtx.drawImage(scanCanvas, -vW / 2, -vH / 2);
                    rotCtx.restore();

                    try {
                        const resB = state.zxingReader.decodeFromCanvas(rotCanvas);
                        if (resB && resB.getText()) {
                            foundCode = resB.getText();
                        }
                    } catch (eB) {}
                }
            }

            if (foundCode) {
                processPhysicalBarcode(foundCode);
            }
        }, 60);

        console.log('[Finder Scan] Ready! Hardware Detector:', has1DBarcodeDetector, 'ZXing Code 128 Reader:', !!state.zxingReader);
    }

    function processPhysicalBarcode(rawText) {
        if (!rawText) return;
        const code = String(rawText).trim();

        // Reject noise or partial reads (must be at least 4 chars and valid barcode characters)
        if (code.length < 4 || !/^[A-Za-z0-9_\-\.\:\/]+$/.test(code)) {
            return;
        }

        // Cooldown debounce: Ignore identical barcode scanned within 2.0 seconds
        const now = performance.now();
        const lastScannedTime = state.cooldownMap.get(code) || 0;
        if (now - lastScannedTime < 2000) {
            return;
        }
        state.cooldownMap.set(code, now);

        console.log('[Finder Scan] 🎯 Valid decoded barcode:', code);

        // Check if code matches any received tote
        let matchedIndex = -1;
        if (state.toteLookup.has(code)) {
            matchedIndex = state.toteLookup.get(code);
        } else if (state.toteLookup.has(code.toUpperCase())) {
            matchedIndex = state.toteLookup.get(code.toUpperCase());
        } else {
            const stripped = code.replace(/^ts\d+-/, '').replace(/-last$/, '');
            if (state.toteLookup.has(stripped)) {
                matchedIndex = state.toteLookup.get(stripped);
            }
        }

        if (matchedIndex === -1) {
            // Unlisted barcode: only show HUD if it has substantial length (>= 6 chars) to prevent spurious noise
            if (code.length >= 6) {
                playChirp(false);
                showScannedToteHud(code, 'unlisted');
            }
            return;
        }

        const toteData = state.receivedMap.get(matchedIndex);
        const toteName = toteData ? toteData.tote : code;

        const isNewlyFound = !state.foundMap.has(matchedIndex);
        if (isNewlyFound) {
            // Newly captured tote!
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
                showToast('🎉 ALL TOTES FOUND! Mission accomplished!', 'success', 6000);
            }

            showScannedToteHud(toteName, true);
        } else {
            // Previously found tote scanned again
            playChirp(false);
            showScannedToteHud(toteName, false);
        }
    }

    function showScannedToteHud(toteCode, status) {
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

        if (elements.hudTitleText) {
            if (status === true) elements.hudTitleText.textContent = 'TOTE FOUND';
            else if (status === false) elements.hudTitleText.textContent = 'ALREADY FOUND';
            else elements.hudTitleText.textContent = 'UNLISTED BARCODE';
        }

        if (elements.hudCheckBadge) {
            if (status === true) elements.hudCheckBadge.textContent = '✅';
            else if (status === false) elements.hudCheckBadge.textContent = 'ℹ️';
            else elements.hudCheckBadge.textContent = '📦';
        }

        if (elements.hudContentCard) {
            if (status === true) elements.hudContentCard.className = 'hud-content-card hud-new';
            else if (status === false) elements.hudContentCard.className = 'hud-content-card hud-already-found';
            else elements.hudContentCard.className = 'hud-content-card hud-unlisted';
        }

        // Show HUD overlay
        elements.findingHudOverlay.style.display = 'flex';
        elements.findingHudOverlay.classList.remove('hud-fading');
        elements.findingHudOverlay.classList.add('hud-visible');

        if (state.hudDismissTimer) clearTimeout(state.hudDismissTimer);

        // Hold for 1.0s, then fade out over 0.25s
        state.hudDismissTimer = setTimeout(() => {
            if (elements.findingHudOverlay) {
                elements.findingHudOverlay.classList.remove('hud-visible');
                elements.findingHudOverlay.classList.add('hud-fading');
                setTimeout(() => {
                    if (elements.findingHudOverlay) elements.findingHudOverlay.style.display = 'none';
                }, 250);
            }
        }, 1000);
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
        // Ingestion Transmission Mode Buttons
        if (elements.clientMode1to1Btn) elements.clientMode1to1Btn.addEventListener('click', () => setClientTransmissionMode('1to1'));
        if (elements.clientModeGroupBtn) elements.clientModeGroupBtn.addEventListener('click', () => setClientTransmissionMode('group'));
        if (elements.floatingFlipCamBtn) elements.floatingFlipCamBtn.addEventListener('click', flipCamera);

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
        if (elements.findingTorchBtn) elements.findingTorchBtn.addEventListener('click', toggleTorch);
        if (elements.findingFlipCamBtn) elements.findingFlipCamBtn.addEventListener('click', flipFindingCamera);
        if (elements.findingExitBtn) elements.findingExitBtn.addEventListener('click', exitFindingMode);
        if (elements.closeDrawerBtn) elements.closeDrawerBtn.addEventListener('click', toggleFindingListDrawer);

        // Direct Finding Trigger
        const directFindingBtn = document.getElementById('directFindingBtn');
        if (directFindingBtn) directFindingBtn.addEventListener('click', enterFindingMode);

        window.addEventListener('beforeunload', () => {
            stopCamera();
            stopFindingCamera();
        });
    }

    async function init() {
        buildGridDOM();
        bindEvents();

        // Check if URL specifies direct finding mode (e.g. peerGrab.html?mode=finding or peerGrab.html#finding)
        const urlParams = new URLSearchParams(window.location.search);
        const isDirectFinding = urlParams.get('mode') === 'finding' || 
                                urlParams.get('find') === '1' || 
                                window.location.hash.includes('finding');

        if (isDirectFinding) {
            await enterFindingMode();
        } else {
            const initialMode = (urlParams.get('mode') === 'group' || urlParams.get('mode') === 'multicast') ? 'group' : '1to1';
            setClientTransmissionMode(initialMode);
            updateProgressUI();
            startCamera();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
