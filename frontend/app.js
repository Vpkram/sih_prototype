// Global state
let map = null;
let cameraMarkers = {};
let activeTrajectoryPolyline = null;
let activeStepMarkers = [];
let heatLayer = null;
let heatmapActive = true;
let densityChart = null;
let simulationRunning = true;
let predictedPosMarker = null;
let predictedPosInterval = null;
let lastSightingInterval = null;
let cachedRouteFlows = [];
let activeTrajectoryData = [];
let replayMarker = null;
let replayTimeouts = [];
let isReplaying = false;

// API Configuration
const API_BASE = "";

let isDashboardInitialized = false;

// Initialize App when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
    checkAuthStatus();
    
    // Poll live events, analytics, and security alerts every 3 seconds if authenticated
    setInterval(() => {
        if (sessionStorage.getItem("isLoggedIn") === "true") {
            fetchLiveEvents();
            fetchAnalytics();
            fetchAlerts();
        }
    }, 3000);
});

// Check Authentication Gating Status
function checkAuthStatus() {
    const isLoggedIn = sessionStorage.getItem("isLoggedIn") === "true";
    const loginScreen = document.getElementById("login-screen");
    const appContainer = document.getElementById("app-container");

    if (isLoggedIn) {
        if (loginScreen) loginScreen.classList.add("hidden");
        if (appContainer) appContainer.classList.remove("hidden");

        if (!isDashboardInitialized) {
            initDashboardApp();
            isDashboardInitialized = true;
        }

        setTimeout(() => {
            if (map) {
                map.invalidateSize();
            }
        }, 150);
    } else {
        if (loginScreen) loginScreen.classList.remove("hidden");
        if (appContainer) appContainer.classList.add("hidden");
    }
}

// Initialize Dashboard components once authenticated
function initDashboardApp() {
    initMap();
    loadCameras();
    fetchLiveEvents();
    fetchAnalytics();
    fetchAlerts();
    checkSimulationStatus();
}

// Initialize Leaflet Map
function initMap() {
    // Center around Bengaluru fixed camera locations
    map = L.map("map", {
        center: [12.9450, 77.6250],
        zoom: 12,
        minZoom: 11,
        zoomControl: true
    });

    // Create a dedicated heatmap pane to prevent CSS filters on tiles from affecting heatmap colors
    map.createPane('heatmapPane');
    map.getPane('heatmapPane').style.zIndex = 450;
    map.getPane('heatmapPane').style.pointerEvents = 'none';

    // Standard OpenStreetMap Tiles (free, no key needed)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);
}

// Fetch Fixed Cameras and add Markers
async function loadCameras() {
    try {
        const response = await fetch(`${API_BASE}/cameras`);
        const data = await response.json();
        const cameras = data.cameras || [];

        cameras.forEach(cam => {
            // Custom glowing camera marker icon
            const customIcon = L.divIcon({
                className: "custom-cam-marker",
                html: `
                    <div style="
                        background: #1e293b;
                        border: 2px solid #3b82f6;
                        color: #60a5fa;
                        border-radius: 50%;
                        width: 36px;
                        height: 36px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 0 12px rgba(59, 130, 246, 0.7);
                        font-size: 14px;
                    ">
                        <i class="fa-solid fa-video"></i>
                    </div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            });

            const marker = L.marker([cam.lat, cam.lng], { icon: customIcon, zIndexOffset: 1000 }).addTo(map);
            
            const popupContent = `
                <div style="font-family: 'Outfit', sans-serif; padding: 4px;">
                    <h3 style="margin: 0 0 4px 0; color: #60a5fa; font-size: 14px;">${cam.name}</h3>
                    <p style="margin: 0; font-size: 12px; color: #94a3b8;">ID: <strong>${cam.camera_id}</strong></p>
                    <p style="margin: 4px 0 0 0; font-size: 12px; color: #94a3b8;">Coords: ${cam.lat}, ${cam.lng}</p>
                </div>
            `;
            marker.bindPopup(popupContent);
            
            cameraMarkers[cam.camera_id] = {
                data: cam,
                marker: marker
            };
        });
    } catch (err) {
        console.error("Failed to load camera locations:", err);
    }
}

// Search & Draw Trajectory for a Plate
async function searchTrajectory(plateOverride = null) {
    const input = document.getElementById("plate-input");
    const plateNum = (plateOverride || input.value).trim().toUpperCase();

    if (!plateNum) {
        alert("Please enter a valid plate number (e.g. KA01AB1234)");
        return;
    }

    if (plateOverride) {
        input.value = plateOverride;
    }

    try {
        const response = await fetch(`${API_BASE}/trajectory/${encodeURIComponent(plateNum)}`);
        const data = await response.json();

        if (!data.found || data.trajectory.length === 0) {
            alert(`No trajectory history found for vehicle plate: ${plateNum}`);
            clearTrajectory();
            return;
        }

        renderTrajectoryOnMap(data.trajectory, plateNum);
    } catch (err) {
        console.error("Error fetching trajectory:", err);
        alert("Server error while retrieving vehicle trajectory.");
    }
}

// Draw Polyline and Step Markers on Map
function renderTrajectoryOnMap(trajectory, plateNum) {
    clearTrajectory();
    activeTrajectoryData = trajectory || [];

    const latLngs = [];
    const timelineList = document.getElementById("timeline-list");
    timelineList.innerHTML = "";

    const startTime = new Date(trajectory[0].timestamp);
    const endTime = new Date(trajectory[trajectory.length - 1].timestamp);
    const durationMinutes = Math.round((endTime - startTime) / (1000 * 60));

    // Display Info Card
    document.getElementById("trajectory-info").classList.remove("hidden");
    if (map) map.invalidateSize();
    document.getElementById("plate-badge").innerText = plateNum;
    document.getElementById("stat-detections").innerText = trajectory.length;
    
    const uniqueCams = new Set(trajectory.map(t => t.camera_id));
    document.getElementById("stat-cameras").innerText = uniqueCams.size;
    document.getElementById("stat-duration").innerText = `${durationMinutes}m`;

    trajectory.forEach((item, index) => {
        const latLng = [item.lat, item.lng];
        latLngs.push(latLng);

        // Add step marker on map
        const stepNum = index + 1;
        const stepIcon = L.divIcon({
            className: "trajectory-step-icon",
            html: `
                <div style="
                    background: linear-gradient(135deg, #ef4444, #dc2626);
                    color: white;
                    border-radius: 50%;
                    width: 26px;
                    height: 26px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 12px;
                    border: 2px solid #ffffff;
                    box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);
                ">
                    ${stepNum}
                </div>
            `,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        const stepMarker = L.marker(latLng, { icon: stepIcon }).addTo(map);
        
        const formattedTime = new Date(item.timestamp).toLocaleString();
        stepMarker.bindPopup(`
            <div style="font-family: 'Outfit', sans-serif;">
                <h4 style="margin: 0 0 4px 0; color: #ef4444;">Step ${stepNum}: ${item.plate_number}</h4>
                <p style="margin: 0; font-size: 12px; color: #e2e8f0;">${item.camera_name || item.camera_id}</p>
                <p style="margin: 2px 0 0 0; font-size: 11px; color: #94a3b8;">${formattedTime}</p>
            </div>
        `);
        activeStepMarkers.push(stepMarker);

        // Populate Timeline Card Item
        const timeItem = document.createElement("div");
        timeItem.className = "timeline-item";
        timeItem.innerHTML = `
            <div class="timeline-step">${stepNum}</div>
            <div class="timeline-details">
                <span class="timeline-cam">${item.camera_name || item.camera_id}</span>
                <span class="timeline-time"><i class="fa-regular fa-clock"></i> ${new Date(item.timestamp).toLocaleTimeString()}</span>
            </div>
        `;
        timelineList.appendChild(timeItem);
    });

    // Connect points with glowing polyline
    activeTrajectoryPolyline = L.polyline(latLngs, {
        color: '#3b82f6',
        weight: 5,
        opacity: 0.9,
        dashArray: '8, 8',
        lineCap: 'round'
    }).addTo(map);

    // Zoom map to fit trajectory bounds with maxZoom limit
    if (latLngs.length > 0) {
        const bounds = L.latLngBounds(latLngs);
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        if (map.getZoom() < 12) {
            map.setZoom(12);
        }
    }

    // Render predicted live tracking dot, sighting counter, and ETA prediction
    renderPredictedTracking(trajectory);
}

// Render Predicted Live Position, Last Sighting Counter, & ETA to Next Camera
function renderPredictedTracking(trajectory) {
    if (!trajectory || trajectory.length === 0) return;

    // Clear previous timers & markers
    if (predictedPosMarker) {
        map.removeLayer(predictedPosMarker);
        predictedPosMarker = null;
    }
    if (predictedPosInterval) {
        clearInterval(predictedPosInterval);
        predictedPosInterval = null;
    }
    if (lastSightingInterval) {
        clearInterval(lastSightingInterval);
        lastSightingInterval = null;
    }

    const N = trajectory.length;
    const mostRecentDet = trajectory[N - 1];
    const secondRecentDet = N >= 2 ? trajectory[N - 2] : mostRecentDet;

    // 1. "Last confirmed sighting" live updating badge
    const locationName = mostRecentDet.camera_name || mostRecentDet.camera_id;
    const locElem = document.getElementById("sighting-location");
    if (locElem) locElem.innerText = locationName;

    function updateSightingTime() {
        const detTime = new Date(mostRecentDet.timestamp).getTime();
        const elapsedSec = Math.max(0, Math.floor((Date.now() - detTime) / 1000));

        let formattedStr = "";
        if (elapsedSec < 60) {
            formattedStr = `${elapsedSec} sec ago`;
        } else if (elapsedSec < 3600) {
            const mins = Math.floor(elapsedSec / 60);
            const secs = elapsedSec % 60;
            formattedStr = `${mins} min ${secs}s ago`;
        } else {
            const hrs = Math.floor(elapsedSec / 3600);
            const mins = Math.floor((elapsedSec % 3600) / 60);
            formattedStr = `${hrs}h ${mins}m ago`;
        }

        const el = document.getElementById("sighting-time");
        if (el) el.innerText = formattedStr;
    }

    updateSightingTime();
    lastSightingInterval = setInterval(updateSightingTime, 1000);

    // 2. ETA to next likely camera (corridor analysis)
    const currentCamId = mostRecentDet.camera_id;
    const matchingFlows = (cachedRouteFlows || []).filter(f => f.from_camera_id === currentCamId);
    matchingFlows.sort((a, b) => (b.count || 0) - (a.count || 0));

    const topFlow = matchingFlows.length > 0 ? matchingFlows[0] : null;
    const etaBadge = document.getElementById("eta-badge");
    const etaText = document.getElementById("eta-text");

    let nextTargetCam = null;

    if (topFlow && topFlow.to_camera_id && etaBadge && etaText) {
        const nextCamName = topFlow.to_camera_name || topFlow.to_camera_id;
        const avgTimeMins = Math.round(topFlow.avg_time_mins || 3);
        etaText.innerHTML = `Predicted to reach <strong style="color: #f59e0b;">${nextCamName}</strong> in <strong style="color: #38bdf8;">~${avgTimeMins} min</strong>`;
        etaBadge.classList.remove("hidden");

        if (cameraMarkers[topFlow.to_camera_id] && cameraMarkers[topFlow.to_camera_id].data) {
            nextTargetCam = cameraMarkers[topFlow.to_camera_id].data;
        }
    } else if (etaBadge) {
        etaBadge.classList.add("hidden");
    }

    // 3. Predicted live position pulsing dot on Leaflet map
    let latA = secondRecentDet.lat;
    let lngA = secondRecentDet.lng;
    let latB = mostRecentDet.lat;
    let lngB = mostRecentDet.lng;

    if (nextTargetCam) {
        // Vehicle is traveling from most recent detection towards predicted next camera
        latA = mostRecentDet.lat;
        lngA = mostRecentDet.lng;
        latB = nextTargetCam.lat;
        lngB = nextTargetCam.lng;
    }

    const predictedIcon = L.divIcon({
        className: "predicted-live-marker",
        html: `
            <div class="predicted-marker-wrapper">
                <div class="predicted-pulse-ring"></div>
                <div class="predicted-core-dot"></div>
            </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });

    const startLat = latA + (latB - latA) * 0.2;
    const startLng = lngA + (lngB - lngA) * 0.2;

    predictedPosMarker = L.marker([startLat, startLng], { icon: predictedIcon, zIndexOffset: 1500 }).addTo(map);

    predictedPosMarker.bindTooltip("Predicted position (not live GPS)", {
        permanent: true,
        direction: "top",
        offset: [0, -10],
        className: "predicted-tooltip"
    });

    let animationProgress = 0.2;

    predictedPosInterval = setInterval(() => {
        animationProgress += 0.008;
        if (animationProgress >= 0.85) {
            animationProgress = 0.2;
        }

        const currLat = latA + (latB - latA) * animationProgress;
        const currLng = lngA + (lngB - lngA) * animationProgress;

        if (predictedPosMarker && map) {
            predictedPosMarker.setLatLng([currLat, currLng]);
        }
    }, 50);
}

// Stop current replay route animation
function stopReplayAnimation() {
    replayTimeouts.forEach(t => clearTimeout(t));
    replayTimeouts = [];

    if (replayMarker && map) {
        map.removeLayer(replayMarker);
        replayMarker = null;
    }

    isReplaying = false;
    const btn = document.getElementById("btn-replay-route");
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-play"></i> Replay Route`;
    }
}

// Replay Trajectory Step-by-Step Animation
function replayTrajectory() {
    if (!activeTrajectoryData || activeTrajectoryData.length === 0) {
        showToast("No active trajectory to replay", "error");
        return;
    }

    stopReplayAnimation();
    isReplaying = true;

    const btn = document.getElementById("btn-replay-route");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Replaying...`;
    }

    const trajectory = activeTrajectoryData;
    const totalSteps = trajectory.length;

    const replayIcon = L.divIcon({
        className: "replay-live-marker",
        html: `
            <div class="replay-marker-wrapper">
                <div class="replay-pulse-ring"></div>
                <div class="replay-core-dot">
                    <i class="fa-solid fa-car"></i>
                </div>
            </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });

    replayMarker = L.marker([trajectory[0].lat, trajectory[0].lng], {
        icon: replayIcon,
        zIndexOffset: 2000
    }).addTo(map);

    const firstCamName = trajectory[0].camera_name || trajectory[0].camera_id;
    replayMarker.bindTooltip(`Step 1/${totalSteps}: ${firstCamName}`, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "replay-tooltip"
    });

    let cumulativeDelay = 0;
    const stepDuration = 900; // ms to travel between steps
    const pauseDuration = 600; // ms to pause at camera marker

    for (let i = 0; i < totalSteps - 1; i++) {
        const fromStep = trajectory[i];
        const toStep = trajectory[i + 1];

        const stepsCount = 25;
        const frameInterval = stepDuration / stepsCount;

        for (let f = 1; f <= stepsCount; f++) {
            const delay = cumulativeDelay + (f * frameInterval);
            const progress = f / stepsCount;

            const timeoutId = setTimeout(() => {
                if (!isReplaying || !replayMarker) return;

                const currentLat = fromStep.lat + (toStep.lat - fromStep.lat) * progress;
                const currentLng = fromStep.lng + (toStep.lng - fromStep.lng) * progress;
                replayMarker.setLatLng([currentLat, currentLng]);

                if (f === stepsCount) {
                    const stepNum = i + 2;
                    const camName = toStep.camera_name || toStep.camera_id;
                    if (replayMarker.getTooltip()) {
                        replayMarker.setTooltipContent(`Step ${stepNum}/${totalSteps}: ${camName}`);
                    }
                }
            }, delay);

            replayTimeouts.push(timeoutId);
        }

        cumulativeDelay += stepDuration + pauseDuration;
    }

    const completionTimeout = setTimeout(() => {
        showToast(`Route replay completed (${totalSteps} steps)`, "success");
        stopReplayAnimation();
    }, cumulativeDelay + 800);

    replayTimeouts.push(completionTimeout);
}

// Clear current trajectory route
function clearTrajectory() {
    stopReplayAnimation();
    activeTrajectoryData = [];

    if (activeTrajectoryPolyline) {
        map.removeLayer(activeTrajectoryPolyline);
        activeTrajectoryPolyline = null;
    }
    activeStepMarkers.forEach(m => map.removeLayer(m));
    activeStepMarkers = [];

    if (predictedPosMarker) {
        map.removeLayer(predictedPosMarker);
        predictedPosMarker = null;
    }
    if (predictedPosInterval) {
        clearInterval(predictedPosInterval);
        predictedPosInterval = null;
    }
    if (lastSightingInterval) {
        clearInterval(lastSightingInterval);
        lastSightingInterval = null;
    }

    const trajInfo = document.getElementById("trajectory-info");
    if (trajInfo) trajInfo.classList.add("hidden");
    const timelineList = document.getElementById("timeline-list");
    if (timelineList) timelineList.innerHTML = "";

    if (map) {
        map.invalidateSize();
        map.setView([12.9450, 77.6250], 12);
    }
}

// Fetch Live Detections Feed
async function fetchLiveEvents() {
    try {
        const response = await fetch(`${API_BASE}/events?limit=30`);
        const data = await response.json();
        const events = data.events || [];

        document.getElementById("total-event-count").innerText = data.count || events.length;

        const tbody = document.getElementById("events-tbody");
        if (events.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; color: #94a3b8; padding: 2rem;">
                        No detections recorded yet. Click <strong>Seed Demo Data</strong> or upload a video feed to simulate.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = events.map(ev => {
            const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = new Date(ev.timestamp).toLocaleDateString();
            const cropImg = ev.crop_path ? `<img src="${ev.crop_path}" class="crop-thumb" alt="crop">` : `<span style="color:#64748b;">No Image</span>`;
            
            return `
                <tr>
                    <td><span style="font-family: monospace; color: #94a3b8;">#${ev.id}</span></td>
                    <td>
                        <div>${timeStr}</div>
                        <div style="font-size: 0.75rem; color: #64748b;">${dateStr}</div>
                    </td>
                    <td><span class="plate-badge">${ev.plate_number}</span></td>
                    <td>
                        <strong style="color: #e2e8f0;">${ev.camera_name || ev.camera_id}</strong>
                        <div style="font-size: 0.75rem; color: #64748b;">ID: ${ev.camera_id}</div>
                    </td>
                    <td><span style="color: #10b981; font-weight: 600;">${Math.round((ev.confidence || 0.95) * 100)}%</span></td>
                    <td>${cropImg}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="quickSearch('${ev.plate_number}')">
                            <i class="fa-solid fa-route"></i> Track
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("Error fetching live events:", err);
    }
}

// Quick Search from chip or table action
function quickSearch(plateNum) {
    document.getElementById("plate-input").value = plateNum;
    searchTrajectory(plateNum);
}

// Seed Demo Trajectory Data
async function seedDemoData() {
    const btn = document.getElementById("btn-seed-data");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Seeding...`;

    try {
        const response = await fetch(`${API_BASE}/seed-demo`, { method: "POST" });
        const data = await response.json();
        
        await fetchLiveEvents();
        await fetchAnalytics();
        quickSearch("KA01AB1234");
    } catch (err) {
        alert("Failed to seed demo data.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-database"></i> Seed Demo Data`;
    }
}

// Handle Video Upload Form Submission
async function handleVideoUpload(event) {
    event.preventDefault();
    
    const fileInput = document.getElementById("video-file");
    const cameraSelect = document.getElementById("camera-select");
    const statusDiv = document.getElementById("upload-status");
    const btnUpload = document.getElementById("btn-upload");

    if (!fileInput.files || fileInput.files.length === 0) {
        alert("Please select a video file first.");
        return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    formData.append("camera_id", cameraSelect.value);

    statusDiv.className = "status-msg";
    statusDiv.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading & processing video with YOLOv8 & EasyOCR...`;
    statusDiv.classList.remove("hidden");
    btnUpload.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/detect`, {
            method: "POST",
            body: formData
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            statusDiv.className = "status-msg success";
            statusDiv.innerHTML = `<i class="fa-solid fa-check"></i> Processed video! Extracted ${result.detected_count} plate detections.`;
            
            // Refresh events table and analytics
            await fetchLiveEvents();
            await fetchAnalytics();
            
            // If plates were detected, automatically show trajectory for first detected plate
            if (result.detections && result.detections.length > 0) {
                quickSearch(result.detections[0].plate_number);
            }
        } else {
            statusDiv.className = "status-msg error";
            statusDiv.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error: ${result.detail || "Processing failed"}`;
        }
    } catch (err) {
        statusDiv.className = "status-msg error";
        statusDiv.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Server connection failed.`;
    } finally {
        btnUpload.disabled = false;
    }
}

// Fetch Traffic Analytics (Heatmap, Chart.js, Speed, Flows)
async function fetchAnalytics() {
    try {
        const response = await fetch(`${API_BASE}/analytics`);
        const data = await response.json();

        // Cache route flows for ETA calculations
        if (data.route_flows) {
            cachedRouteFlows = data.route_flows;
        }

        // 1. Update Stat Overview Badges
        if (data.overall_avg_speed_kmh) {
            document.getElementById("analytics-avg-speed").innerText = `${data.overall_avg_speed_kmh} km/h`;
        }
        if (data.total_vehicles !== undefined) {
            document.getElementById("analytics-total-vehicles").innerText = `${data.total_vehicles}`;
        }

        // 2. Leaflet Heatmap Layer Update
        if (data.heatmap_points && data.heatmap_points.length > 0 && typeof L.heatLayer === 'function') {
            console.log("[Heatmap Points Debug]:", data.heatmap_points);
            if (!heatLayer) {
                heatLayer = L.heatLayer(data.heatmap_points, {
                    pane: 'heatmapPane',
                    radius: 45,
                    blur: 22,
                    maxZoom: 15,
                    max: 1.0,
                    gradient: { 0.2: '#3b82f6', 0.5: '#10b981', 0.8: '#f59e0b', 1.0: '#ef4444' }
                });
                if (heatmapActive) {
                    heatLayer.addTo(map);
                }
            } else {
                heatLayer.setLatLngs(data.heatmap_points);
                if (heatmapActive && !map.hasLayer(heatLayer)) {
                    heatLayer.addTo(map);
                }
            }
        }

        // 3. Render Vehicle Density Chart (Chart.js)
        if (data.camera_densities && data.camera_densities.length > 0) {
            renderDensityChart(data.camera_densities);
        }

        // 4. Render Route Flow Analysis Table
        renderRouteFlowTable(data.route_flows);

    } catch (err) {
        console.error("Error fetching analytics:", err);
    }
}

// Render Density Bar Chart using Chart.js
function renderDensityChart(cameraDensities) {
    const canvas = document.getElementById("densityChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const labels = cameraDensities.map(c => c.name || c.camera_id);
    const counts = cameraDensities.map(c => c.detection_count);

    if (densityChart) {
        densityChart.data.labels = labels;
        densityChart.data.datasets[0].data = counts;
        densityChart.update();
        return;
    }

    densityChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Detections',
                data: counts,
                backgroundColor: 'rgba(59, 130, 246, 0.65)',
                borderColor: '#3b82f6',
                borderWidth: 1.5,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` Detections: ${context.raw}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#9ca3af', font: { size: 10 } },
                    grid: { display: false }
                },
                y: {
                    ticks: { color: '#9ca3af', font: { size: 10 }, precision: 0 },
                    grid: { color: 'rgba(255, 255, 255, 0.06)' },
                    beginAtZero: true
                }
            }
        }
    });
}

// Render Route Flow Analysis Table
function renderRouteFlowTable(routeFlows) {
    const flowTbody = document.getElementById("flow-tbody");
    if (!flowTbody) return;

    if (!routeFlows || routeFlows.length === 0) {
        flowTbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; color: #94a3b8; padding: 1.5rem;">
                    No multi-camera route transitions recorded yet.
                </td>
            </tr>
        `;
        return;
    }

    flowTbody.innerHTML = routeFlows.map(flow => `
        <tr>
            <td><strong style="color: #60a5fa;">${flow.from_camera_name || flow.from_camera_id}</strong></td>
            <td style="color: #f59e0b; text-align: center;"><i class="fa-solid fa-arrow-right"></i></td>
            <td><strong style="color: #c084fc;">${flow.to_camera_name || flow.to_camera_id}</strong></td>
            <td><span class="plate-badge">${flow.count} vehicle${flow.count > 1 ? 's' : ''}</span></td>
            <td><span style="color: #10b981; font-weight: 600;"><i class="fa-regular fa-clock"></i> ~${flow.avg_time_mins} min</span></td>
        </tr>
    `).join("");
}

// Toggle Leaflet Heatmap Layer Visibility
function toggleHeatmap() {
    heatmapActive = !heatmapActive;
    if (heatLayer) {
        if (heatmapActive) {
            heatLayer.addTo(map);
        } else {
            map.removeLayer(heatLayer);
        }
    }
}

// Check Backend Simulation Status
async function checkSimulationStatus() {
    try {
        const res = await fetch(`${API_BASE}/simulation/status`);
        const data = await res.json();
        simulationRunning = data.running;
        updateSimulationUI();
    } catch (e) {
        console.error("Error fetching simulation status:", e);
    }
}

// Toggle Live Traffic Simulation
async function toggleSimulation() {
    try {
        const endpoint = simulationRunning ? "/simulation/stop" : "/simulation/start";
        const res = await fetch(`${API_BASE}${endpoint}`, { method: "POST" });
        const data = await res.json();
        simulationRunning = data.running;
        updateSimulationUI();
    } catch (e) {
        console.error("Error toggling simulation:", e);
    }
}

// Fetch Security & Threat Alerts
async function fetchAlerts() {
    try {
        const response = await fetch(`${API_BASE}/alerts?limit=50`);
        const data = await response.json();
        const alerts = data.alerts || [];
        const unackCount = data.unacknowledged_count || 0;

        // Update Alert Count Header Badge
        const badge = document.getElementById("alert-count-badge");
        if (badge) {
            if (unackCount > 0) {
                badge.innerText = `${unackCount} UNREAD ALERT${unackCount > 1 ? 'S' : ''}`;
                badge.classList.remove("hidden");
            } else {
                badge.classList.add("hidden");
            }
        }

        const tbody = document.getElementById("alerts-tbody");
        if (!tbody) return;

        if (alerts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; color: #94a3b8; padding: 1.5rem;">
                        <i class="fa-solid fa-shield-check" style="color: #10b981;"></i> No security alerts detected. System operating normally.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = alerts.map(alt => {
            const timeStr = new Date(alt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = new Date(alt.timestamp).toLocaleDateString();
            
            const isBlacklist = alt.alert_type === 'blacklisted_vehicle';
            const typeBadge = isBlacklist ? 
                `<span class="badge-blacklisted"><i class="fa-solid fa-ban"></i> Blacklist Hit</span>` :
                `<span class="badge-suspicious"><i class="fa-solid fa-gauge-high"></i> Suspicious Route</span>`;
                
            const rowClass = alt.acknowledged ? "" : "alert-unack";

            return `
                <tr class="${rowClass}">
                    <td>
                        <div>${timeStr}</div>
                        <div style="font-size: 0.75rem; color: #64748b;">${dateStr}</div>
                    </td>
                    <td>${typeBadge}</td>
                    <td><span class="plate-badge" style="border-color: rgba(239,68,68,0.5);">${alt.plate_number}</span></td>
                    <td><strong style="color: #e2e8f0;">${alt.camera_name || alt.camera_id}</strong></td>
                    <td style="color: #fca5a5; font-size: 0.85rem;">${alt.message}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="quickSearch('${alt.plate_number}')">
                            <i class="fa-solid fa-route"></i> Track
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("Error fetching alerts:", err);
    }
}

// Handle Blacklist Form Submission
async function handleBlacklistSubmit(event) {
    event.preventDefault();
    const plateInput = document.getElementById("bl-plate-input");
    const reasonInput = document.getElementById("bl-reason-input");
    const statusDiv = document.getElementById("bl-status");

    const plateNumber = plateInput.value.trim().toUpperCase();
    const reason = reasonInput.value.trim() || "Flagged by Law Enforcement";

    if (!plateNumber) return;

    try {
        const response = await fetch(`${API_BASE}/blacklist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plate_number: plateNumber, reason: reason })
        });
        const resData = await response.json();

        if (response.ok) {
            statusDiv.className = "status-msg success";
            statusDiv.innerHTML = `<i class="fa-solid fa-check"></i> Flagged ${plateNumber} on Blacklist!`;
            statusDiv.classList.remove("hidden");
            plateInput.value = "";
            reasonInput.value = "";

            // Immediately refresh alerts & track vehicle
            await fetchAlerts();
            await fetchLiveEvents();
            quickSearch(plateNumber);
        } else {
            statusDiv.className = "status-msg error";
            statusDiv.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> ${resData.detail || 'Failed to blacklist'}`;
            statusDiv.classList.remove("hidden");
        }
    } catch (err) {
        statusDiv.className = "status-msg error";
        statusDiv.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Server error.`;
        statusDiv.classList.remove("hidden");
    }
}

// Acknowledge All Alerts
async function acknowledgeAlerts() {
    try {
        await fetch(`${API_BASE}/alerts/acknowledge`, { method: "POST" });
        await fetchAlerts();
    } catch (err) {
        console.error("Error acknowledging alerts:", err);
    }
}

// Toast Notification
function showToast(message, type = "success") {
    let container = document.querySelector(".toast-container");
    if (!container) {
        container = document.createElement("div");
        container.className = "toast-container";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 3000);
}

// Reset for Demo Environment Action
async function resetDemoEnvironment() {
    const btn = document.getElementById("btn-reset-demo");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Resetting...`;
    }

    try {
        // 1. Clear trajectory search input and map route line
        document.getElementById("plate-input").value = "";
        clearTrajectory();

        // 2. Call backend reset-demo endpoint
        await fetch(`${API_BASE}/reset-demo`, { method: "POST" });

        // 3. Refresh live events feed, analytics, and security alerts
        await fetchLiveEvents();
        await fetchAnalytics();
        await fetchAlerts();

        // 4. Toast notification confirmation
        showToast("Demo environment reset", "success");

    } catch (err) {
        console.error("Failed to reset demo environment:", err);
        showToast("Failed to reset demo environment", "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> Reset for Demo`;
        }
    }
}

// Handle Police Login Form Submission
function handleLogin(event) {
    event.preventDefault();
    const usernameInput = document.getElementById("login-username");
    const passwordInput = document.getElementById("login-password");
    const errorDiv = document.getElementById("login-error");

    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value.trim() : "";

    if (username === "admin" && password === "police123") {
        sessionStorage.setItem("isLoggedIn", "true");
        if (errorDiv) errorDiv.classList.add("hidden");
        if (passwordInput) passwordInput.value = "";
        checkAuthStatus();
        showToast("Access Granted — Police Command Center", "success");
    } else {
        if (errorDiv) {
            errorDiv.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Invalid credentials. Please check username & password.`;
            errorDiv.classList.remove("hidden");
        }
    }
}

// Handle Police Logout Action
function handleLogout() {
    sessionStorage.removeItem("isLoggedIn");
    checkAuthStatus();
    showToast("Logged out successfully", "success");
}





