/**
 * AP 108 Emergency Command Center - Dashboard Logic
 * Interactive Leaflet mapping, optimization recomputation, and live accident dispatch simulation.
 */

// Global State
let map;
let baseLayers = {};
let currentBaseLayer = null;

let layers = {
  districtBoundary: L.layerGroup(),
  manualAmbulances: L.layerGroup(),
  optAmbulances: L.layerGroup(),
  coverageCircles: L.layerGroup(),
  blackspots: L.layerGroup(),
  baseline: L.layerGroup(),
  mandals: L.layerGroup(),
  villages: L.layerGroup(),
  villageDanger: L.layerGroup(),
  traumaCenters: L.layerGroup(),
  incidents: L.layerGroup(),
  reportedAccidents: L.layerGroup(),
  publicRecommendations: L.layerGroup()
};

let currentUser = null;
let allReportedAccidents = [];
let allPublicRecommendations = [];
let currentBlackspots = [];
let currentOptimalStations = [];
let currentReadyStations = [];
let customAmbulances = [];
let allMandals = [];
let currentDistrictPlaces = [];
let currentDistrictBounds = null;
let lastIncident = { lat: 16.312, lng: 80.451, label: "Emergency Scene", district: "General", mandal: "Local" };

function matchDistrict(d1, d2) {
  if (!d1 || !d2) return false;
  const aliases = {
    "nellore": "sps nellore",
    "sps nellore": "sps nellore",
    "sri potti sriramulu nellore": "sps nellore",
    "kadapa": "ysr kadapa",
    "ysr kadapa": "ysr kadapa",
    "ysr": "ysr kadapa",
    "konaseema": "dr. b.r. ambedkar konaseema",
    "dr. b.r. ambedkar konaseema": "dr. b.r. ambedkar konaseema",
    "manyam": "parvathipuram manyam",
    "parvathipuram manyam": "parvathipuram manyam",
    "alluri": "alluri sitharama raju",
    "asr": "alluri sitharama raju",
    "alluri sitharama raju": "alluri sitharama raju"
  };
  const k1 = aliases[d1.trim().toLowerCase()] || d1.trim().toLowerCase();
  const k2 = aliases[d2.trim().toLowerCase()] || d2.trim().toLowerCase();
  return k1 == k2;
}

const AP_COASTLINE_REF = [
  [13.40, 80.10], [13.60, 80.11], [13.80, 80.12], [14.00, 80.08], [14.15, 80.07],
  [14.28, 80.09], [14.45, 80.13], [14.65, 80.09], [14.90, 80.00], [15.10, 80.01],
  [15.25, 80.03], [15.45, 80.07], [15.65, 80.25], [15.80, 80.45], [15.92, 80.60],
  [16.00, 80.85], [16.18, 81.18], [16.32, 81.65], [16.50, 81.88], [16.70, 82.08],
  [16.95, 82.20], [17.15, 82.30], [17.35, 82.54], [17.55, 82.94], [17.70, 83.27],
  [17.89, 83.39], [18.12, 83.76], [18.33, 84.05], [18.55, 84.28], [18.88, 84.52],
  [19.20, 84.68]
];

function getMaxCoastlineLng(lat) {
  const pts = AP_COASTLINE_REF;
  if (lat <= pts[0][0]) return pts[0][1];
  if (lat >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i][0] <= lat && lat <= pts[i + 1][0]) {
      const t = (lat - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return 84.0;
}

function clampCoastline(lat, lng, buffer = 0.018) {
  const maxLng = getMaxCoastlineLng(lat) - buffer;
  if (lng > maxLng) {
    const over = lng - maxLng;
    return Math.round((maxLng - Math.min(0.04, over * 0.4) - 0.005) * 100000) / 100000;
  }
  return lng;
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupEventListeners();
  loadInitialData();
});

function initMap() {
  // Center of Andhra Pradesh
  map = L.map("map", {
    center: [15.9129, 79.9400],
    zoom: 7,
    zoomControl: false
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Define Basemap Providers: Street-level, Esri Roadways, Satellite, and Dark
  baseLayers = {
    streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    esri_streets: L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      attribution: 'Tiles &copy; Esri &mdash; DeLorme, NAVTEQ, TomTom',
      maxZoom: 19
    }),
    satellite: L.layerGroup([
      L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
      }),
      L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19
      })
    ]),
    dark: L.layerGroup([
      L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: '&copy; Esri, DeLorme, NAVTEQ',
        maxZoom: 19,
        maxNativeZoom: 16
      }),
      L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        maxNativeZoom: 16
      })
    ])
  };

  // Default to Street Map showing each and every road, street, lane, and junction
  currentBaseLayer = baseLayers.streets;
  currentBaseLayer.addTo(map);

  // Add operational layer groups to map
  Object.values(layers).forEach(layer => layer.addTo(map));

  // Map Click Listener: User can click anywhere in AP to report an accident
  map.on("click", (e) => {
    handleAccidentReport(e.latlng.lat, e.latlng.lng);
  });
}

function setupEventListeners() {
  // Slider displays
  const ambSlider = document.getElementById("ambulance-slider");
  const ambVal = document.getElementById("ambulance-count-val");
  ambSlider.addEventListener("input", (e) => {
    ambVal.textContent = e.target.value;
  });

  const radSlider = document.getElementById("radius-slider");
  const radVal = document.getElementById("radius-count-val");
  radSlider.addEventListener("input", (e) => {
    radVal.textContent = `${e.target.value} km`;
  });

  // Layer toggles
  const layerReportedAccidentsEl = document.getElementById("layer-reported-accidents");
  if (layerReportedAccidentsEl) {
    layerReportedAccidentsEl.addEventListener("change", (e) => {
      toggleLayer(layers.reportedAccidents, e.target.checked);
    });
  }

  const layerPublicRecsEl = document.getElementById("layer-public-recommendations");
  if (layerPublicRecsEl) {
    layerPublicRecsEl.addEventListener("change", (e) => {
      toggleLayer(layers.publicRecommendations, e.target.checked);
    });
  }

  const layerManualAmbsEl = document.getElementById("layer-manual-ambulances");
  if (layerManualAmbsEl) {
    layerManualAmbsEl.addEventListener("change", (e) => {
      toggleLayer(layers.manualAmbulances, e.target.checked);
    });
  }

  document.getElementById("layer-opt-ambulances").addEventListener("change", (e) => {
    toggleLayer(layers.optAmbulances, e.target.checked);
  });
  document.getElementById("layer-coverage-circles").addEventListener("change", (e) => {
    toggleLayer(layers.coverageCircles, e.target.checked);
  });
  document.getElementById("layer-blackspots").addEventListener("change", (e) => {
    toggleLayer(layers.blackspots, e.target.checked);
  });
  document.getElementById("layer-baseline").addEventListener("change", (e) => {
    toggleLayer(layers.baseline, e.target.checked);
  });
  document.getElementById("layer-mandals").addEventListener("change", (e) => {
    toggleLayer(layers.mandals, e.target.checked);
  });
  const layerVillagesEl = document.getElementById("layer-villages");
  if (layerVillagesEl) {
    layerVillagesEl.addEventListener("change", (e) => {
      toggleLayer(layers.villages, e.target.checked);
    });
  }
  const layerVillageDangerEl = document.getElementById("layer-village-danger");
  if (layerVillageDangerEl) {
    layerVillageDangerEl.addEventListener("change", (e) => {
      toggleLayer(layers.villageDanger, e.target.checked);
    });
  }
  document.getElementById("layer-trauma-centers").addEventListener("change", (e) => {
    toggleLayer(layers.traumaCenters, e.target.checked);
  });

  // Manual Button: Place Ambulance Nearer (Save Time)
  const btnPlaceNearer = document.getElementById("btn-place-ambulance-nearer");
  if (btnPlaceNearer) {
    btnPlaceNearer.addEventListener("click", () => {
      placeAmbulanceNearer(lastIncident.lat, lastIncident.lng, lastIncident.label, lastIncident.district, lastIncident.mandal);
    });
  }

  // Basemap Switcher (Streets, Esri Roadways, Satellite, Dark)
  const basemapSelect = document.getElementById("basemap-select");
  if (basemapSelect) {
    basemapSelect.addEventListener("change", (e) => {
      const selected = e.target.value;
      if (baseLayers[selected]) {
        map.removeLayer(currentBaseLayer);
        currentBaseLayer = baseLayers[selected];
        map.addLayer(currentBaseLayer);
      }
    });
  }

  // Bold Labels on Map Toggle
  const boldLabelsToggle = document.getElementById("layer-bold-labels");
  if (boldLabelsToggle) {
    boldLabelsToggle.addEventListener("change", (e) => {
      const mapEl = document.getElementById("map");
      if (e.target.checked) {
        mapEl.classList.remove("hide-bold-labels");
      } else {
        mapEl.classList.add("hide-bold-labels");
      }
    });
  }

  // Village Autocomplete Search Setup
  setupVillageSearch();

  // Recompute Optimization Button
  document.getElementById("btn-run-optimization").addEventListener("click", runOptimization);

  // District select change
  document.getElementById("district-select").addEventListener("change", (e) => {
    const district = e.target.value;
    if (district === "ALL") {
      document.getElementById("ambulance-slider").value = 45;
      document.getElementById("ambulance-count-val").textContent = "45";
    } else {
      const distMandals = allMandals.filter(m => matchDistrict(m.district, district));
      const mCount = distMandals.length || 20;
      document.getElementById("ambulance-slider").max = Math.max(mCount + 10, 50);
      document.getElementById("ambulance-slider").value = mCount;
      document.getElementById("ambulance-count-val").textContent = `${mCount} (All Mandals Covered)`;
    }
    runOptimization();
  });

  // Places Explorer Filters
  const explorerMandalFilter = document.getElementById("explorer-mandal-filter");
  if (explorerMandalFilter) {
    explorerMandalFilter.addEventListener("change", () => {
      renderFilteredPlaces();
    });
  }

  const explorerPlaceSearch = document.getElementById("explorer-place-search");
  if (explorerPlaceSearch) {
    explorerPlaceSearch.addEventListener("input", () => {
      renderFilteredPlaces();
    });
  }

  const btnZoomDist = document.getElementById("btn-zoom-district");
  if (btnZoomDist) {
    btnZoomDist.addEventListener("click", () => {
      fitDistrictBounds();
    });
  }

  // Highway Crash Simulation Button
  document.getElementById("btn-simulate-highway-crash").addEventListener("click", () => {
    if (currentBlackspots.length > 0) {
      const randomSpot = currentBlackspots[Math.floor(Math.random() * currentBlackspots.length)];
      handleAccidentReport(randomSpot.lat, randomSpot.lng, randomSpot.location_name);
    } else {
      handleAccidentReport(16.3067, 80.4365, "Guntur Highway Stretch");
    }
  });
}

function toggleLayer(layer, isVisible) {
  if (isVisible) {
    map.addLayer(layer);
  } else {
    map.removeLayer(layer);
  }
}

async function loadInitialData() {
  try {
    // Check role authentication status
    await checkCurrentUser();

    // 0. Load Permanent Manually Placed Ambulances from Server & localStorage
    await loadManualAmbulances();

    // Load Public Citizen Recommendations & Live Reported Road Accidents
    await loadPublicRecommendations();
    await loadReportedAccidents();

    // 1. Load Trauma Centers
    const traumaRes = await fetch("/api/trauma_centers");
    const traumaData = await traumaRes.json();
    renderTraumaCenters(traumaData.trauma_centers || []);

    // 2. Load Baseline Ambulances
    const baseRes = await fetch("/api/baseline?district=ALL");
    const baseData = await baseRes.json();
    renderBaselineAmbulances(baseData.ambulances || []);

    // 3. Load Mandals
    const mandalRes = await fetch("/api/mandals?district=ALL");
    const mandalData = await mandalRes.json();
    allMandals = mandalData.mandals || [];
    renderMandals(allMandals);

    // 4. Run initial optimization
    await runOptimization();
  } catch (err) {
    console.error("Error loading initial data:", err);
  }
}

async function runOptimization() {
  const district = document.getElementById("district-select").value;
  const algorithm = document.getElementById("algorithm-select").value;
  const numAmbulances = parseInt(document.getElementById("ambulance-slider").value);
  const radiusKm = parseFloat(document.getElementById("radius-slider").value);

  const btn = document.getElementById("btn-run-optimization");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Optimizing Positioning...';

  try {
    const res = await fetch("/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        district: district,
        algorithm: algorithm,
        num_ambulances: numAmbulances,
        radius_km: radiusKm
      })
    });

    const data = await res.json();
    if (data.status === "success") {
      currentOptimalStations = data.optimization.selected_stations || [];
      currentReadyStations = data.optimization.ready_mandal_stations || [];
      renderOptimalAmbulances(currentOptimalStations, currentReadyStations, radiusKm);
      renderManualAmbulances(customAmbulances);
      updateKPIs(data);

      // Load blackspots for this district or state
      const bsRes = await fetch(`/api/blackspots?district=${encodeURIComponent(district)}`);
      const bsData = await bsRes.json();
      currentBlackspots = bsData.blackspots || [];
      renderBlackspots(currentBlackspots);

      // Load mandals specifically for this district (or all if statewide)
      const mRes = await fetch(`/api/mandals?district=${encodeURIComponent(district)}`);
      const mData = await mRes.json();
      const districtMandals = mData.mandals || [];
      renderMandals(districtMandals);

      // Load baseline ambulances for this district (or all if statewide)
      const bRes = await fetch(`/api/baseline?district=${encodeURIComponent(district)}`);
      const bData = await bRes.json();
      renderBaselineAmbulances(bData.ambulances || []);

      // Load villages for this district (load 100% of all villages without cut-off)
      const vLimit = district === "ALL" ? 400 : 10000;
      const vRes = await fetch(`/api/villages?district=${encodeURIComponent(district)}&limit=${vLimit}`);
      const vData = await vRes.json();
      const districtVillages = vData.villages || [];
      renderVillages(districtVillages);

      // Load village danger spots for this district (100% of all danger zones)
      const vdRes = await fetch(`/api/village_danger_spots?district=${encodeURIComponent(district)}&limit=${vLimit}`);
      const vdData = await vdRes.json();
      const districtDangerSpots = vdData.danger_spots || [];
      renderVillageDangerSpots(districtDangerSpots);

      // Load district details & perimeter boundary hull
      const ddRes = await fetch(`/api/district_details?district=${encodeURIComponent(district)}`);
      const ddData = await ddRes.json();
      if (ddData.status === "success" && !ddData.is_statewide && ddData.boundary_hull) {
        renderDistrictBoundary(ddData.boundary_hull, ddData.district, ddData.total_mandals, ddData.total_villages);
      } else {
        layers.districtBoundary.clearLayers();
      }

      // Update Places Explorer in sidebar with each and every place
      updateDistrictPlacesExplorer(ddData, districtMandals, districtVillages, districtDangerSpots);

      // Adjust map bounds to encompass all places in the total selected district
      if (district !== "ALL") {
        const boundsCoords = [];
        currentOptimalStations.forEach(s => boundsCoords.push([s.lat, clampCoastline(s.lat, s.lng)]));
        currentReadyStations.forEach(s => boundsCoords.push([s.lat, clampCoastline(s.lat, s.lng)]));
        districtMandals.forEach(m => boundsCoords.push([m.lat, clampCoastline(m.lat, m.lng)]));
        districtVillages.forEach(v => boundsCoords.push([v.lat, clampCoastline(v.lat, v.lng)]));
        if (boundsCoords.length > 0) {
          currentDistrictBounds = L.latLngBounds(boundsCoords);
          map.fitBounds(currentDistrictBounds, { padding: [40, 40] });
        }
      } else {
        currentDistrictBounds = L.latLngBounds([[12.6, 76.8], [19.2, 84.7]]);
      }
    }
  } catch (err) {
    console.error("Optimization failed:", err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Recompute Optimal Positioning';
  }
}

function updateKPIs(data) {
  const evalData = data.evaluation || {};
  const optMetrics = evalData.optimized || {};
  const deltas = evalData.deltas || {};

  // Coverage KPI
  const covVal = optMetrics.golden_hour_mandal_coverage_pct || 0;
  document.getElementById("kpi-coverage").textContent = `${covVal}%`;
  const covDeltaEl = document.getElementById("kpi-coverage-delta");
  covDeltaEl.innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> <span>+${deltas.coverage_gain_pct || 0}% vs Baseline</span>`;

  // Response Time KPI
  const timeVal = optMetrics.average_response_time_minutes || 0;
  document.getElementById("kpi-response-time").textContent = `${timeVal} min`;
  const timeDeltaEl = document.getElementById("kpi-time-delta");
  timeDeltaEl.innerHTML = `<i class="fa-solid fa-arrow-trend-down"></i> <span>-${deltas.response_time_reduction_minutes || 0} min faster</span>`;

  // Blackspot Protection KPI
  const bsVal = optMetrics.blackspot_coverage_pct || 0;
  document.getElementById("kpi-blackspot-coverage").textContent = `${bsVal}%`;
  document.getElementById("kpi-blackspot-delta").textContent = `${optMetrics.covered_blackspots_count || 0}/${optMetrics.total_blackspots || 0} Corridor Hotspots`;

  // Blindspots
  const blindspotsVal = optMetrics.severely_delayed_mandals_count || 0;
  document.getElementById("kpi-blindspots").textContent = blindspotsVal;
  document.getElementById("kpi-blindspots-delta").textContent = `${deltas.blindspots_eliminated || 0} Blindspots Resolved`;
}

function renderOptimalAmbulances(stations, readyStations = [], radiusKm = 12.0) {
  layers.optAmbulances.clearLayers();
  layers.coverageCircles.clearLayers();

  const radiusMeters = radiusKm * 1000;

  // 1. Render Priority ALS Stations
  stations.forEach((stn, idx) => {
    const isALS = stn.allocated_vehicle_type && stn.allocated_vehicle_type.includes("ALS");
    const markerColor = isALS ? "#10b981" : "#06b6d4";
    const safeLng = clampCoastline(stn.lat, stn.lng);

    const customIcon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div style="background:${markerColor}; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 12px ${markerColor};">
          <i class="fa-solid fa-truck-medical" style="font-size:13px;"></i>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([stn.lat, safeLng], { icon: customIcon });
    marker.bindTooltip(`<b>${stn.name}</b> <span class="amb-type-badge">${stn.allocated_vehicle_type || 'ALS'}</span>`, {
      permanent: true,
      direction: "bottom",
      className: "bold-map-label ambulance-label",
      offset: [0, 8]
    });
    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:190px;">
        <strong style="color:${markerColor}; font-size:13px;"><i class="fa-solid fa-truck-medical"></i> ${stn.name}</strong><br>
        <strong>District:</strong> ${stn.district}<br>
        <strong>Mandal:</strong> ${stn.mandal}<br>
        <strong>Vehicle Class:</strong> <span style="font-weight:700; color:${markerColor};">${stn.allocated_vehicle_type || 'ALS'}</span><br>
        <strong>Paramedic Crew:</strong> ${stn.paramedic_crew || 3} Officers<br>
        <strong>Equipment:</strong> ${(stn.equipment || []).join(", ") || 'Ventilator, Defibrillator, Cardiac Monitor'}<br>
        <strong>Coverage Radius:</strong> ${radiusKm} km (~15 min response)<br>
        <span style="background:#dcfce7; color:#15803d; font-weight:700; padding:1px 6px; border-radius:4px; font-size:10px;">Primary ALS Corridor Interceptor</span>
      </div>
    `);
    layers.optAmbulances.addLayer(marker);

    // Coverage Circle Buffer
    const circle = L.circle([stn.lat, safeLng], {
      radius: radiusMeters,
      color: markerColor,
      weight: 1.5,
      opacity: 0.8,
      fillColor: markerColor,
      fillOpacity: 0.12
    });
    layers.coverageCircles.addLayer(circle);
  });

  // 2. Render Ready Mandal Stations (guarantees every mandal including Duttalur has a stationed ready ambulance)
  readyStations.forEach(stn => {
    const safeLng = clampCoastline(stn.lat, stn.lng);
    const customIcon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div style="background:#0284c7; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 10px rgba(2, 132, 199, 0.8);">
          <i class="fa-solid fa-truck-medical" style="font-size:12px;"></i>
        </div>
      `,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const marker = L.marker([stn.lat, safeLng], { icon: customIcon });
    marker.bindTooltip(`<b>${stn.name}</b> <span class="amb-type-badge ready-badge">Ready 108 Post</span>`, {
      permanent: true,
      direction: "bottom",
      className: "bold-map-label ambulance-label ready-ambulance-label",
      offset: [0, 8]
    });
    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:200px;">
        <strong style="color:#0284c7; font-size:13px;"><i class="fa-solid fa-truck-medical"></i> ${stn.name}</strong><br>
        <strong>Class:</strong> Basic Life Support (BLS) - Ready Post<br>
        <strong>District:</strong> ${stn.district} | <strong>Mandal:</strong> ${stn.mandal}<br>
        <strong>Status:</strong> <span style="background:#dcfce7; color:#15803d; font-weight:700; padding:1px 6px; border-radius:4px;">Active & Ready</span><br>
        <strong>Paramedic Crew:</strong> 2 EMT Officers<br>
        <strong>Equipment:</strong> Oxygen Cylinder, Stretcher, First Aid Kit, Suction Unit<br>
        <hr style="margin:5px 0; border:0; border-top:1px solid #e2e8f0;">
        <small style="color:#64748b;">Permanently stationed at ${stn.mandal} Mandal HQ for &lt; 15 min rapid village response.</small>
      </div>
    `);
    layers.optAmbulances.addLayer(marker);
  });
}

function renderBlackspots(blackspots) {
  layers.blackspots.clearLayers();

  blackspots.forEach((bs) => {
    const safeLng = clampCoastline(bs.lat, bs.lng);
    const customIcon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div class="marker-blackspot" style="width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px;">
          <i class="fa-solid fa-triangle-exclamation"></i>
        </div>
      `,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    const marker = L.marker([bs.lat, safeLng], { icon: customIcon });
    marker.bindTooltip(`<b>⚠️ ${bs.location_name}</b> <small style="color:#fca5a5;">(${bs.corridor})</small>`, {
      direction: "top",
      className: "bold-map-label blackspot-label",
      offset: [0, -8]
    });
    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:210px;">
        <strong style="color:#ef4444; font-size:13px;"><i class="fa-solid fa-triangle-exclamation"></i> Blackspot: ${bs.location_name}</strong><br>
        <strong>Corridor:</strong> ${bs.corridor}<br>
        <strong>District:</strong> ${bs.district}<br>
        <strong>Annual Fatalities:</strong> ${bs.fatalities_annual}<br>
        <strong>Annual Injuries:</strong> ${bs.injuries_annual}<br>
        <strong>Severity Index:</strong> ${bs.severity_index}<br>
        <strong>Primary Cause:</strong> ${bs.accident_causes}<br>
        <strong>High Risk Window:</strong> ${bs.peak_time_window}<br>
        <div style="margin-top:7px; display:flex; flex-direction:column; gap:5px;">
          <button onclick="handleAccidentReport(${bs.lat}, ${safeLng}, '${bs.location_name.replace(/'/g, "\\'")}', '${bs.district.replace(/'/g, "\\'")}', 'Corridor')" style="background:#ef4444; color:#fff; border:none; border-radius:4px; padding:5px 8px; font-size:11px; font-weight:700; cursor:pointer; width:100%;">
            <i class="fa-solid fa-truck-medical"></i> 🚨 Test Dispatch Here
          </button>
          <button onclick="placeAmbulanceNearer(${bs.lat}, ${safeLng}, '${bs.location_name.replace(/'/g, "\\'")} Blackspot', '${bs.district.replace(/'/g, "\\'")}', 'Corridor')" style="background:#10b981; color:#fff; border:none; border-radius:4px; padding:5px 8px; font-size:11px; font-weight:700; cursor:pointer; width:100%; display:flex; align-items:center; justify-content:center; gap:5px;">
            <i class="fa-solid fa-truck-fast"></i> ⚡ Click Manual Button to Place Ambulance Nearer
          </button>
        </div>
      </div>
    `);
    layers.blackspots.addLayer(marker);
  });
}

function renderTraumaCenters(traumaCenters) {
  layers.traumaCenters.clearLayers();

  traumaCenters.forEach(tc => {
    const safeLng = clampCoastline(tc.lat, tc.lng);
    const icon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div class="marker-trauma" style="width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px;">
          <i class="fa-solid fa-hospital"></i>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker([tc.lat, safeLng], { icon: icon });
    marker.bindTooltip(`<b>🏥 ${tc.name}</b>`, {
      permanent: true,
      direction: "bottom",
      className: "bold-map-label trauma-label",
      offset: [0, 8]
    });
    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a;">
        <strong style="color:#8b5cf6; font-size:13px;"><i class="fa-solid fa-hospital"></i> ${tc.name}</strong><br>
        <strong>Level:</strong> ${tc.level}<br>
        <strong>District:</strong> ${tc.district}
      </div>
    `);
    layers.traumaCenters.addLayer(marker);
  });
}

function renderBaselineAmbulances(ambulances) {
  layers.baseline.clearLayers();

  ambulances.forEach(amb => {
    const safeLng = clampCoastline(amb.lat, amb.lng);
    const icon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div class="marker-baseline" style="width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:9px;">
          <i class="fa-solid fa-truck-medical"></i>
        </div>
      `,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    const marker = L.marker([amb.lat, safeLng], { icon: icon });
    marker.bindTooltip(`<b>${amb.station_name}</b>`, {
      direction: "top",
      className: "bold-map-label",
      offset: [0, -6]
    });
    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a;">
        <strong>Baseline 108 Base: ${amb.station_name}</strong><br>
        <strong>District:</strong> ${amb.district}<br>
        <strong>Status:</strong> Pre-Optimization Static Base
      </div>
    `);
    layers.baseline.addLayer(marker);
  });
}

function renderMandals(mandals) {
  layers.mandals.clearLayers();

  mandals.forEach(m => {
    const safeLng = clampCoastline(m.lat, m.lng);
    const circle = L.circleMarker([m.lat, safeLng], {
      radius: 3.5,
      color: "#3b82f6",
      fillColor: "#3b82f6",
      fillOpacity: 0.6,
      weight: 1
    });

    circle.bindTooltip(`<b>${m.mandal_name} Mandal</b>`, {
      direction: "top",
      className: "bold-map-label mandal-label",
      offset: [0, -4]
    });

    circle.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a;">
        <strong>${m.mandal_name} Mandal</strong><br>
        <strong>District:</strong> ${m.district}<br>
        <strong>Population:</strong> ${m.population.toLocaleString()}<br>
        <strong>Risk Score:</strong> ${m.risk_score} / 10.0<br>
        <strong>Annual Accidents:</strong> ${m.annual_accidents}
      </div>
    `);
    layers.mandals.addLayer(circle);
  });
}

function renderVillages(villages) {
  layers.villages.clearLayers();

  villages.forEach(v => {
    const isPhc = v.has_phc;
    const color = isPhc ? "#10b981" : "#eab308";
    const safeLng = clampCoastline(v.lat, v.lng);
    const circle = L.circleMarker([v.lat, safeLng], {
      radius: isPhc ? 3.5 : 2.5,
      color: color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 1
    });

    circle.bindTooltip(`<b>${v.village_name}</b> <small style="color:#fef08a;">(${v.mandal})</small>`, {
      direction: "top",
      className: "bold-map-label village-label",
      offset: [0, -4]
    });

    const dsInfo = v.danger_spot || { name: `${v.village_name} Highway Crossroad`, hazard_type: 'Blind Intersection' };
    circle.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:190px;">
        <strong style="color:${color}; font-size:13px;"><i class="fa-solid fa-tree-city"></i> ${v.village_name}</strong><br>
        <strong>Gram Panchayat:</strong> ${v.gram_panchayat || v.village_name}<br>
        <strong>Mandal:</strong> ${v.mandal}<br>
        <strong>District:</strong> ${v.district}<br>
        <strong>Population:</strong> ${v.population.toLocaleString()}<br>
        <strong>Healthcare:</strong> ${isPhc ? '<span style="color:#10b981; font-weight:600;">PHC / Sub-Center</span>' : 'ASHA Network'}<br>
        <div style="margin-top:6px; padding-top:4px; border-top:1px dashed #cbd5e1;">
          <strong style="color:#dc2626;"><i class="fa-solid fa-triangle-exclamation"></i> Danger Spot:</strong> ${dsInfo.name}<br>
          <strong>Hazard:</strong> ${dsInfo.hazard_type}<br>
        </div>
        <div style="margin-top:6px; padding:4px 6px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:4px;">
          <strong style="color:#15803d;"><i class="fa-solid fa-truck-medical"></i> Ready 108 Station:</strong><br>
          <span style="color:#166534; font-weight:600;">${v.mandal} Mandal HQ Station</span> (< 5 min response)
        </div>
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">
          <button onclick="handleAccidentReport(${v.lat}, ${safeLng}, '${v.village_name.replace(/'/g, "\\'")} (${v.mandal} Mdl)', '${v.district.replace(/'/g, "\\'")}', '${v.mandal.replace(/'/g, "\\'")}')" style="background:#ef4444; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer; width:100%;">
            <i class="fa-solid fa-truck-medical"></i> 🚨 Test Emergency Dispatch Here
          </button>
          <button onclick="placeAmbulanceNearer(${v.lat}, ${safeLng}, '${v.village_name.replace(/'/g, "\\'")} 108 Base', '${v.district.replace(/'/g, "\\'")}', '${v.mandal.replace(/'/g, "\\'")}')" style="background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer; width:100%; display:flex; align-items:center; justify-content:center; gap:5px;">
            <i class="fa-solid fa-truck-fast"></i> ⚡ Click Manual Button to Place Ambulance Nearer
          </button>
        </div>
      </div>
    `);
    layers.villages.addLayer(circle);
  });
}

function renderVillageDangerSpots(dangerSpots) {
  layers.villageDanger.clearLayers();

  dangerSpots.forEach(ds => {
    const isCritical = ds.severity === "Critical Risk";
    const zoneColor = isCritical ? "#dc2626" : "#ea580c";
    const safeLat = ds.lat;
    const safeLng = clampCoastline(ds.lat, ds.lng);

    // 1. Visible Danger Zone Hazard Perimeter Circle (650m radius)
    const zoneCircle = L.circle([safeLat, safeLng], {
      radius: 650,
      color: zoneColor,
      weight: 1.8,
      dashArray: "4, 4",
      fillColor: isCritical ? "#ef4444" : "#f97316",
      fillOpacity: 0.22
    });
    layers.villageDanger.addLayer(zoneCircle);

    // 2. Center Danger Warning Icon Marker
    const icon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div class="marker-village-danger ${isCritical ? 'critical' : 'high'}" style="width:22px; height:22px;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:11px;"></i>
        </div>
      `,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    const marker = L.marker([safeLat, safeLng], { icon: icon });
    marker.bindTooltip(`<b>⚠️ ${ds.village_name} Danger Zone</b><br><small style="color:#fca5a5;">${ds.hazard_type} (${ds.severity})</small>`, {
      direction: "top",
      className: "bold-map-label danger-label",
      offset: [0, -8]
    });

    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:230px;">
        <strong style="color:#dc2626; font-size:13px;"><i class="fa-solid fa-triangle-exclamation"></i> Village Danger Zone</strong><br>
        <span style="font-weight:700; color:#b91c1c; font-size:13px;">${ds.village_name}</span> (${ds.mandal} Mandal, ${ds.district})<br>
        <hr style="margin:5px 0; border:0; border-top:1px solid #fee2e2;">
        <strong>Hazard Zone:</strong> <span style="font-weight:600; color:#ea580c;">${ds.hazard_type}</span><br>
        <strong>Risk Severity:</strong> <span style="background:#fee2e2; color:#991b1b; padding:1px 6px; border-radius:4px; font-weight:700;">${ds.severity}</span><br>
        <strong>Crash Metrics:</strong> ${ds.annual_accidents} accidents/yr | ${ds.fatalities} fatalities<br>
        <strong>Causes:</strong> ${ds.causes || 'Blind curve / high-speed intersection'}<br>
        <div style="margin-top:6px; padding:4px 6px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:4px;">
          <strong style="color:#15803d;"><i class="fa-solid fa-truck-medical"></i> Stationed Ready Ambulance:</strong><br>
          <span style="color:#166534; font-weight:600;">${ds.mandal} 108 Ready Emergency Station</span> (< 5 min response)
        </div>
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">
          <button onclick="handleAccidentReport(${safeLat}, ${safeLng}, '${ds.village_name.replace(/'/g, "\\'")} Danger Zone (${ds.mandal} Mdl)', '${ds.district.replace(/'/g, "\\'")}', '${ds.mandal.replace(/'/g, "\\'")}')" style="background:#dc2626; color:#fff; border:none; border-radius:4px; padding:6px 10px; font-size:11px; font-weight:700; cursor:pointer; width:100%;">
            <i class="fa-solid fa-truck-medical"></i> 🚨 Test Emergency Dispatch to Danger Zone
          </button>
          <button onclick="placeAmbulanceNearer(${safeLat}, ${safeLng}, '${ds.village_name.replace(/'/g, "\\'")} Danger Zone', '${ds.district.replace(/'/g, "\\'")}', '${ds.mandal.replace(/'/g, "\\'")}')" style="background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 10px; font-size:11px; font-weight:700; cursor:pointer; width:100%; display:flex; align-items:center; justify-content:center; gap:5px;">
            <i class="fa-solid fa-truck-fast"></i> ⚡ Click Manual Button to Place Ambulance Nearer
          </button>
        </div>
      </div>
    `);
    layers.villageDanger.addLayer(marker);
  });
}

async function placeAmbulanceNearer(lat, lng, locationLabel = "Danger Spot", district = "General", mandal = "Local") {
  // Role Protection: Only Officers & Higher Authorities can manually reposition fleet units
  if (!currentUser || currentUser.role !== "officer") {
    openRestrictedNotice("place");
    return;
  }

  try {
    const res = await fetch("/api/place_ambulance_nearer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: lat,
        lng: lng,
        location_name: locationLabel,
        district: district,
        mandal: mandal
      })
    });

    if (res.status === 403) {
      openRestrictedNotice("place");
      return;
    }

    const data = await res.json();
    if (data.status === "success" && data.station) {
      const stn = data.station;

      // Reload & render manual ambulances so this newly placed station is preserved across reloads
      await loadManualAmbulances();

      // Trigger instant accident dispatch at this spot to show immediate < 2 min response!
      handleAccidentReport(lat, lng, `${locationLabel} (Nearer Ambulance Deployed)`, district, mandal);
    } else if (data.status === "restricted") {
      openRestrictedNotice("place");
    } else {
      alert(data.message || "Could not position ambulance.");
    }
  } catch (err) {
    console.error("Error placing ambulance nearer:", err);
  }
}

// ==========================================================================
// Manual Ambulance Placement & Multi-Session Persistence Implementation
// ==========================================================================

// Manual placement helper: calls placeAmbulanceNearer to station unit and persist
async function saveManualAmbulance(lat, lng, name = "Danger Spot", district = "General", mandal = "Local") {
  return placeAmbulanceNearer(lat, lng, name, district, mandal);
}

// Loads manual ambulances from server with localStorage fallback
async function loadManualAmbulances() {
  try {
    const res = await fetch("/api/manual_ambulances");
    const data = await res.json();
    if (data.status === "success" && Array.isArray(data.ambulances) && data.ambulances.length > 0) {
      customAmbulances = data.ambulances;
      try {
        localStorage.setItem("ap_manual_ambulances", JSON.stringify(customAmbulances));
      } catch (e) {}
    } else {
      // Check localStorage backup
      const cached = localStorage.getItem("ap_manual_ambulances");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Re-sync back to server if officer
            if (currentUser && currentUser.role === "officer") {
              for (const amb of parsed) {
                await fetch("/api/manual_ambulances", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(amb)
                });
              }
            }
            customAmbulances = parsed;
          }
        } catch (e) {}
      }
    }
    renderManualAmbulances(customAmbulances);
  } catch (err) {
    console.error("Error loading manual ambulances:", err);
  }
}

// Deletes a manually placed ambulance from disk and memory (Officer only)
async function deleteManualAmbulance(stationId) {
  if (!currentUser || currentUser.role !== "officer") {
    openRestrictedNotice("delete");
    return;
  }

  const target = customAmbulances.find(a => a.station_id === stationId || a.ambulance_id === stationId);
  const name = target ? target.name : "this custom 108 ambulance station";
  if (!confirm(`Are you sure you want to permanently delete ${name}?`)) {
    return;
  }
  try {
    const res = await fetch(`/api/manual_ambulances/${encodeURIComponent(stationId)}`, {
      method: "DELETE"
    });
    if (res.status === 403) {
      openRestrictedNotice("delete");
      return;
    }
    const data = await res.json();
    if (data.status === "success") {
      customAmbulances = customAmbulances.filter(a => a.station_id !== stationId && a.ambulance_id !== stationId);
      try {
        localStorage.setItem("ap_manual_ambulances", JSON.stringify(customAmbulances));
      } catch (e) {}
      renderManualAmbulances(customAmbulances);
    } else {
      alert(data.message || "Failed to delete ambulance.");
    }
  } catch (err) {
    console.error("Error deleting manual ambulance:", err);
  }
}

// Deletes all manually placed ambulances (Officer only)
async function deleteAllManualAmbulances() {
  if (!currentUser || currentUser.role !== "officer") {
    openRestrictedNotice("deleteAll");
    return;
  }

  if (!customAmbulances || customAmbulances.length === 0) return;
  if (!confirm(`Are you sure you want to permanently delete all ${customAmbulances.length} manually placed ambulances?`)) {
    return;
  }
  for (const stn of [...customAmbulances]) {
    try {
      await fetch(`/api/manual_ambulances/${encodeURIComponent(stn.station_id)}`, { method: "DELETE" });
    } catch (e) {}
  }
  customAmbulances = [];
  try {
    localStorage.removeItem("ap_manual_ambulances");
  } catch (e) {}
  renderManualAmbulances([]);
}

// Renders all saved manual ambulances onto map and sidebar
function renderManualAmbulances(ambulances) {
  layers.manualAmbulances.clearLayers();

  const totalCount = ambulances ? ambulances.length : 0;

  // Update counters
  const statPillEl = document.getElementById("stat-manual-amb");
  if (statPillEl) statPillEl.textContent = totalCount;

  const badgeEl = document.getElementById("custom-amb-badge");
  if (badgeEl) badgeEl.textContent = `${totalCount} Placed`;

  const legendCountEl = document.getElementById("legend-custom-count");
  if (legendCountEl) legendCountEl.textContent = totalCount;

  const clearAllBtn = document.getElementById("btn-clear-all-manual");
  if (clearAllBtn) {
    clearAllBtn.style.display = totalCount > 0 ? "inline-flex" : "none";
  }

  // Render Sidebar List
  const listContainer = document.getElementById("custom-ambulances-list");
  if (listContainer) {
    if (totalCount === 0) {
      listContainer.innerHTML = `
        <div class="custom-empty-state" style="text-align:center; padding: 14px 10px; background: rgba(15, 23, 42, 0.4); border-radius:6px; border: 1px dashed var(--border-color);">
          <i class="fa-solid fa-truck-medical" style="font-size: 1.5rem; color: #64748b; margin-bottom: 6px;"></i>
          <p style="font-size: 0.76rem; color: var(--text-muted); margin: 0; line-height: 1.4;">
            No manual ambulances positioned yet.<br>
            Click the green manual button on any village or in the dispatch simulator to station one nearer.
          </p>
        </div>
      `;
    } else {
      listContainer.innerHTML = ambulances.map(stn => {
        const safeLng = clampCoastline(stn.lat, stn.lng);
        const vType = stn.allocated_vehicle_type || "ALS - Rapid Post";
        const crew = stn.paramedic_crew || 3;
        return `
          <div class="custom-amb-card" id="manual-card-${stn.station_id}">
            <div class="custom-amb-header">
              <span class="custom-amb-name"><i class="fa-solid fa-star" style="color:#fbbf24;"></i> ${stn.name}</span>
              <span style="font-size:0.68rem; background:rgba(16, 185, 129, 0.2); color:#34d399; border:1px solid #10b981; padding:1px 5px; border-radius:3px; font-weight:700;">ACTIVE BASE</span>
            </div>
            <div class="custom-amb-meta">
              <div><i class="fa-solid fa-location-dot" style="color:#38bdf8;"></i> <strong>${stn.mandal}</strong> Mandal, <strong>${stn.district}</strong> District</div>
              <div><i class="fa-solid fa-crosshairs" style="color:#94a3b8;"></i> Coordinates: <code>${stn.lat.toFixed(4)}, ${safeLng.toFixed(4)}</code></div>
              <div style="margin-top:2px;"><i class="fa-solid fa-truck-medical" style="color:#10b981;"></i> Class: <span style="color:#a7f3d0; font-weight:600;">${vType}</span> (${crew} EMT Crew)</div>
            </div>
            <div class="custom-amb-actions">
              <button class="btn-amb-fly" onclick="focusAmbulance(${stn.lat}, ${safeLng}, '${stn.name.replace(/'/g, "\\'")}')" title="Zoom to ambulance position on map">
                <i class="fa-solid fa-crosshairs"></i> View
              </button>
              <button class="btn-amb-fly" style="background:rgba(239, 68, 68, 0.15); border-color:#ef4444; color:#f87171;" onclick="handleAccidentReport(${stn.lat}, ${safeLng}, '${stn.name.replace(/'/g, "\\'")}', '${stn.district.replace(/'/g, "\\'")}', '${stn.mandal.replace(/'/g, "\\'")}')" title="Simulate emergency dispatch call to this station">
                <i class="fa-solid fa-truck-medical"></i> Dispatch
              </button>
              <button class="btn-amb-delete" title="Permanently delete this manual position ambulance" onclick="deleteManualAmbulance('${stn.station_id}')">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Render on Map
  if (!ambulances || ambulances.length === 0) return;

  ambulances.forEach(stn => {
    const safeLng = clampCoastline(stn.lat, stn.lng);

    // 1. Golden Hour 12 km Coverage Zone Circle (Gold/Emerald)
    const halo = L.circle([stn.lat, safeLng], {
      radius: (stn.coverage_radius_km || 12.0) * 1000,
      color: "#fbbf24",
      weight: 2,
      dashArray: "6, 6",
      fillColor: "#f59e0b",
      fillOpacity: 0.14
    });
    layers.manualAmbulances.addLayer(halo);

    // 2. Custom Station Marker with Star Badge
    const customIcon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div class="marker-manual-ambulance">
          <i class="fa-solid fa-truck-medical"></i>
          <div class="star-badge">★</div>
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    const marker = L.marker([stn.lat, safeLng], { icon: customIcon });

    marker.bindTooltip(`<b>⭐ CUSTOM 108: ${stn.name}</b>`, {
      permanent: true,
      direction: "bottom",
      className: "bold-map-label ambulance-label",
      offset: [0, 10]
    });

    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:240px;">
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
          <strong style="color:#059669; font-size:13px;"><i class="fa-solid fa-star" style="color:#fbbf24;"></i> Permanently Stationed 108 Unit</strong>
        </div>
        <strong style="font-size:13px; color:#0f172a;">${stn.name}</strong><br>
        <strong>Mandal:</strong> ${stn.mandal} | <strong>District:</strong> ${stn.district}<br>
        <strong>Coordinates:</strong> ${stn.lat.toFixed(4)}, ${safeLng.toFixed(4)}<br>
        <strong>Vehicle Class:</strong> <span style="background:#dcfce7; color:#166534; padding:1px 5px; border-radius:3px; font-weight:700;">${stn.allocated_vehicle_type || 'ALS - Custom Base'}</span><br>
        <strong>Paramedic Crew:</strong> ${stn.paramedic_crew || 3} Certified Personnel<br>
        <strong>Life Support Equipment:</strong> ${(stn.equipment || ['ICU Ventilator', 'Defibrillator', 'Oxygen']).join(', ')}<br>
        <strong>Coverage Radius:</strong> ${stn.coverage_radius_km || 12.0} km (Golden Hour Shield)<br>
        <div style="margin-top:6px; padding:4px 6px; background:#fef3c7; border:1px solid #fde68a; border-radius:4px; font-size:11px; color:#92400e;">
          <i class="fa-solid fa-shield-halved"></i> <strong>Permanent Unit:</strong> Persists across website reloads & server restarts.
        </div>
        <div style="margin-top:8px; display:flex; gap:6px;">
          <button onclick="handleAccidentReport(${stn.lat}, ${safeLng}, '${stn.name.replace(/'/g, "\\'")}', '${stn.district.replace(/'/g, "\\'")}', '${stn.mandal.replace(/'/g, "\\'")}')" style="flex:1; background:#ef4444; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer;">
            <i class="fa-solid fa-truck-medical"></i> Test Dispatch
          </button>
          <button onclick="deleteManualAmbulance('${stn.station_id}')" style="background:#fee2e2; color:#991b1b; border:1px solid #f87171; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer;">
            <i class="fa-solid fa-trash-can"></i> Delete
          </button>
        </div>
      </div>
    `);

    layers.manualAmbulances.addLayer(marker);
  });
}

function focusAmbulance(lat, lng, name) {
  const safeLng = clampCoastline(lat, lng);
  map.flyTo([lat, safeLng], 14, { duration: 1.2 });

  const halo = L.circleMarker([lat, safeLng], {
    radius: 20,
    color: '#fbbf24',
    fillColor: '#fbbf24',
    fillOpacity: 0.45,
    weight: 3
  }).addTo(map);

  halo.bindTooltip(`<b>⭐ ${name}</b>`, {
    permanent: true,
    direction: 'top',
    className: 'bold-map-label'
  }).openTooltip();

  setTimeout(() => {
    map.removeLayer(halo);
  }, 5000);
}


function setupVillageSearch() {
  const searchInput = document.getElementById("village-search-input");
  const resultsDropdown = document.getElementById("village-search-results");
  if (!searchInput || !resultsDropdown) return;

  let debounceTimer = null;

  searchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    clearTimeout(debounceTimer);

    if (val.length < 2) {
      resultsDropdown.innerHTML = "";
      resultsDropdown.classList.add("hidden");
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search_village?q=${encodeURIComponent(val)}`);
        const data = await res.json();
        const results = data.results || [];

        if (results.length === 0) {
          resultsDropdown.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:12px; text-align:center;">No matching villages found</div>';
          resultsDropdown.classList.remove("hidden");
          return;
        }

        resultsDropdown.innerHTML = results.map(v => `
          <div class="village-search-item" data-lat="${v.lat}" data-lng="${v.lng}" data-name="${v.village_name}" data-mandal="${v.mandal}" data-district="${v.district}">
            <div class="v-name">
              <span><i class="fa-solid fa-tree-city" style="color:#eab308; margin-right:6px;"></i>${v.village_name}</span>
              ${v.has_phc ? '<span class="badge-phc">PHC</span>' : ''}
            </div>
            <div class="v-meta">
              <span>Mandal: <strong>${v.mandal}</strong> | District: <strong>${v.district}</strong> | Pop: ${v.population.toLocaleString()}</span>
            </div>
          </div>
        `).join("");

        resultsDropdown.classList.remove("hidden");

        // Add click listeners to items
        resultsDropdown.querySelectorAll(".village-search-item").forEach(item => {
          item.addEventListener("click", () => {
            const lat = parseFloat(item.dataset.lat);
            const lng = parseFloat(item.dataset.lng);
            const vName = item.dataset.name;
            const mandal = item.dataset.mandal;
            const district = item.dataset.district;

            searchInput.value = `${vName} (${mandal}, ${district})`;
            resultsDropdown.classList.add("hidden");

            // Pan and zoom map to village
            map.flyTo([lat, lng], 13, { duration: 1.2 });

            // Trigger emergency accident / dispatch test for this village
            handleAccidentReport(lat, lng, `${vName} Village (${mandal} Mandal, ${district})`, district, mandal);
          });
        });
      } catch (err) {
        console.error("Village search failed:", err);
      }
    }, 250);
  });

  // Close dropdown on click outside
  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !resultsDropdown.contains(e.target)) {
      resultsDropdown.classList.add("hidden");
    }
  });
}

async function handleAccidentReport(lat, lng, locationLabel = "", district = "General", mandal = "Local") {
  lastIncident = { lat: lat, lng: lng, label: locationLabel || "Emergency Crash Site", district: district, mandal: mandal };
  layers.incidents.clearLayers();

  // Pulse accident marker
  const crashIcon = L.divIcon({
    className: "custom-div-icon",
    html: `
      <div style="background:#ef4444; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:3px solid #fff; box-shadow:0 0 20px #ef4444; animation:blackspotPulse 1.2s infinite ease-out;">
        <i class="fa-solid fa-car-burst" style="font-size:16px;"></i>
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });

  const incidentMarker = L.marker([lat, lng], { icon: crashIcon }).addTo(layers.incidents);
  incidentMarker.bindTooltip(`<b>🚨 ACCIDENT: ${locationLabel || 'Emergency Crash Scene'}</b>`, {
    permanent: true,
    direction: "top",
    className: "bold-map-label blackspot-label",
    offset: [0, -14]
  });

  // Dispatch API Call
  try {
    const res = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: lat, lng: lng, severity: "Critical" })
    });

    const data = await res.json();
    if (data.status === "success" && data.dispatch) {
      const d = data.dispatch;
      const amb = d.dispatched_ambulance;
      const metrics = d.response_metrics;
      const nearestHosp = d.nearest_hospital || d.recommended_trauma_center;
      const apexCenter = d.apex_referral_center || {};

      // 1. Draw Ambulance -> Crash Site Routing Polyline (Emerald Green)
      const ambWaypoints = d.route_waypoints || [[amb.lat, amb.lng], [lat, lng]];
      const ambRouteLine = L.polyline(ambWaypoints, {
        color: metrics.status_color || "#10b981",
        weight: 5,
        opacity: 0.9,
        dashArray: "8, 6"
      }).addTo(layers.incidents);

      // Add animated ambulance icon at station
      const ambIcon = L.divIcon({
        className: "custom-div-icon",
        html: `
          <div style="background:#10b981; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 15px #10b981;">
            <i class="fa-solid fa-truck-fast" style="font-size:14px;"></i>
          </div>
        `,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker([amb.lat, amb.lng], { icon: ambIcon }).addTo(layers.incidents);

      // 2. Draw Crash Site -> Nearest Local Referral Hospital Transfer Route (Purple)
      const hospWaypoints = d.hospital_transfer_waypoints || [[lat, lng], [nearestHosp.lat, nearestHosp.lng]];
      const hospRouteLine = L.polyline(hospWaypoints, {
        color: "#a855f7",
        weight: 4,
        opacity: 0.85,
        dashArray: "6, 8"
      }).addTo(layers.incidents);

      // Highlight the Nearest Referral Hospital with an animated pulse marker
      const hospIcon = L.divIcon({
        className: "custom-div-icon",
        html: `
          <div style="background:#8b5cf6; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 16px #8b5cf6;">
            <i class="fa-solid fa-hospital" style="font-size:14px;"></i>
          </div>
        `,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      const hospMarker = L.marker([nearestHosp.lat, nearestHosp.lng], { icon: hospIcon }).addTo(layers.incidents);
      hospMarker.bindTooltip(`<b>🏥 ${nearestHosp.name}</b> <small style="color:#e9d5ff;">(${nearestHosp.distance_km} km / ${nearestHosp.eta_minutes || '--'} min)</small>`, {
        permanent: true,
        direction: "top",
        className: "bold-map-label trauma-label",
        offset: [0, -10]
      });
      hospMarker.bindPopup(`
        <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:190px;">
          <strong style="color:#8b5cf6; font-size:13px;"><i class="fa-solid fa-hospital"></i> ${nearestHosp.name}</strong><br>
          <strong>Type:</strong> ${nearestHosp.level}<br>
          <strong>Town/District:</strong> ${nearestHosp.town || nearestHosp.district}<br>
          <strong>Distance from Crash:</strong> ${nearestHosp.distance_km} km<br>
          <strong>Transit ETA:</strong> ${nearestHosp.eta_minutes || '--'} mins
        </div>
      `);

      // 3. Show Dispatch Telemetry Panel
      const box = document.getElementById("dispatch-result-box");
      box.classList.remove("hidden");
      box.style.borderColor = metrics.status_color;

      const indicator = document.getElementById("dispatch-status-indicator");
      indicator.style.backgroundColor = metrics.status_color;
      indicator.style.boxShadow = `0 0 10px ${metrics.status_color}`;

      document.getElementById("dispatch-status-label").textContent = `${metrics.status_label} (Ambulance ETA: ${metrics.estimated_eta_minutes} min)`;
      document.getElementById("disp-unit-name").textContent = `${amb.name} (${amb.mandal})`;
      document.getElementById("disp-unit-type").textContent = amb.vehicle_type;
      document.getElementById("disp-distance").textContent = `${metrics.road_distance_km} km`;
      document.getElementById("disp-eta").textContent = `${metrics.estimated_eta_minutes} min`;

      // Nearest local hospital
      document.getElementById("disp-local-hospital").textContent = `${nearestHosp.name} (${nearestHosp.level})`;
      document.getElementById("disp-hospital-eta").textContent = `${nearestHosp.distance_km} km (~${nearestHosp.eta_minutes || '--'} min)`;
      document.getElementById("disp-apex-hospital").textContent = apexCenter.name ? `${apexCenter.name} (${apexCenter.distance_km} km)` : '--';

      // 4. Update Automated CAD Dispatch Notice and Manual Placement Button
      const isNearerUnit = amb.is_custom_nearer || amb.is_manual || metrics.estimated_eta_minutes <= 2.5;
      const cadNotice = document.getElementById("disp-cad-notice");
      const btnPlaceNearer = document.getElementById("btn-place-ambulance-nearer");

      if (isNearerUnit) {
        if (cadNotice) {
          cadNotice.className = "disp-cad-notice placed";
          cadNotice.innerHTML = `
            <div class="disp-cad-title">
              <i class="fa-solid fa-circle-check"></i> Automated CAD Dispatch: Nearer Ambulance Active
            </div>
            <div class="disp-cad-sub">⚡ Stationed 108 unit dispatched (&lt; 2 min ETA). Saved permanently across website reloads.</div>
          `;
        }
        if (btnPlaceNearer) {
          btnPlaceNearer.style.display = "none";
        }
      } else {
        if (cadNotice) {
          cadNotice.className = "disp-cad-notice";
          cadNotice.innerHTML = `
            <div class="disp-cad-title">
              <i class="fa-solid fa-triangle-exclamation"></i> Automated CAD Dispatch ( Manual Placement Required)
            </div>
            <div class="disp-cad-sub">You have to click any manual button to place an ambulance nearer.</div>
          `;
        }
        if (btnPlaceNearer) {
          btnPlaceNearer.style.display = "flex";
          btnPlaceNearer.innerHTML = `<i class="fa-solid fa-truck-fast"></i> ⚡ Click Manual Button to Place Ambulance Nearer`;
        }
      }

      // Incident popup on crash marker with CAD notice & manual button
      let cadNoticePopupHtml = "";
      if (isNearerUnit) {
        cadNoticePopupHtml = `
          <div style="margin-top:6px; padding:5px 8px; background:#f0fdf4; border:1px solid #10b981; border-radius:4px; font-size:11px; color:#15803d; font-weight:600;">
            <i class="fa-solid fa-shield-check"></i> Nearer 108 Ambulance Stationed (&lt; 2 min ETA)
          </div>
        `;
      } else {
        cadNoticePopupHtml = `
          <div style="margin-top:7px; padding:6px 8px; background:#fffbeb; border:1px solid #f59e0b; border-radius:4px; font-size:11px;">
            <div style="font-weight:700; color:#d97706; display:flex; align-items:center; gap:4px;">
              <i class="fa-solid fa-triangle-exclamation"></i> Automated CAD Dispatch ( Manual Placement Required)
            </div>
            <div style="font-size:10px; color:#78350f; margin-top:2px;">You have to click any manual button to place an ambulance nearer.</div>
            <button onclick="placeAmbulanceNearer(${lat}, ${lng}, '${(locationLabel || 'Incident Spot').replace(/'/g, "\\'")}', '${district.replace(/'/g, "\\'")}', '${mandal.replace(/'/g, "\\'")}')" style="margin-top:6px; width:100%; background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-weight:700; font-size:11px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:5px;">
              <i class="fa-solid fa-truck-fast"></i> ⚡ Click Manual Button to Place Ambulance Nearer
            </button>
          </div>
        `;
      }

      incidentMarker.bindPopup(`
        <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:240px;">
          <strong style="color:#ef4444; font-size:13px;"><i class="fa-solid fa-car-burst"></i> Emergency Incident Scene</strong><br>
          ${locationLabel ? `<strong>Location:</strong> ${locationLabel}<br>` : ''}
          <strong>Dispatched Unit:</strong> ${amb.name} (${metrics.road_distance_km} km)<br>
          <strong>Ambulance Arrival:</strong> <span style="font-weight:700; color:${metrics.status_color};">${metrics.estimated_eta_minutes} min</span> (${metrics.status_label})<br>
          <div style="margin-top:5px; padding:4px 6px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:4px; font-size:11px; color:#15803d;">
            <i class="fa-solid fa-shield-check"></i> <strong>Stationed Ready 108 Unit:</strong> Assigned from ${amb.mandal || 'Local'} HQ
          </div>
          <hr style="margin:5px 0; border:0; border-top:1px solid #e2e8f0;">
          <strong style="color:#8b5cf6;"><i class="fa-solid fa-hospital"></i> Referral Facility:</strong> ${nearestHosp.name}<br>
          <strong>Transfer Route:</strong> ${nearestHosp.distance_km} km (~${nearestHosp.eta_minutes} min)<br>
          <strong>Golden Hour Status:</strong> ${metrics.golden_hour_status}<br>
          ${cadNoticePopupHtml}
        </div>
      `).openPopup();

      // Fit map bounds to encompass Ambulance, Crash Site, and Nearest Hospital
      const combinedBounds = L.latLngBounds([
        [amb.lat, amb.lng],
        [lat, lng],
        [nearestHosp.lat, nearestHosp.lng]
      ]);
      map.fitBounds(combinedBounds, { padding: [60, 60] });
    }
  } catch (err) {
    console.error("Dispatch simulation error:", err);
  }
}

// -------------------------------------------------------------
// Total District Places Directory & Boundary Renderer
// -------------------------------------------------------------

function renderDistrictBoundary(hullCoords, districtName, mandalsCount, villagesCount) {
  layers.districtBoundary.clearLayers();
  if (!hullCoords || hullCoords.length < 3) return;

  const clampedHull = hullCoords.map(pt => [pt[0], clampCoastline(pt[0], pt[1])]);

  const polygon = L.polygon(clampedHull, {
    color: "#0284c7",
    weight: 2.8,
    dashArray: "6, 6",
    fillColor: "#0284c7",
    fillOpacity: 0.06
  });

  polygon.bindTooltip(
    `<b>🏛️ ${districtName} District</b><br><small style="color:#93c5fd;">Total Coverage: ${mandalsCount} Mandals | ${villagesCount} Villages | 100% Covered</small>`,
    {
      permanent: true,
      direction: "center",
      className: "district-boundary-tooltip"
    }
  );

  layers.districtBoundary.addLayer(polygon);
}

function updateDistrictPlacesExplorer(distDetails, mandals, villages, dangerSpots) {
  const isAll = distDetails.is_statewide || !distDetails.district || distDetails.district === "ALL";

  if (isAll) {
    document.getElementById("explorer-total-badge").textContent = "Statewide View";
    document.getElementById("explorer-district-name").textContent = "All 26 AP Districts";
    document.getElementById("explorer-hq-info").textContent = "Select a specific district to view each and every place";
    document.getElementById("chip-mandals").textContent = "679";
    document.getElementById("chip-villages").textContent = villages.length.toLocaleString();
    document.getElementById("chip-danger").textContent = dangerSpots.length.toLocaleString();
    document.getElementById("chip-amb").textContent = "236";
    document.getElementById("places-display-count").textContent = "Showing 26 AP Districts";

    const mandalSelect = document.getElementById("explorer-mandal-filter");
    if (mandalSelect) {
      mandalSelect.innerHTML = '<option value="ALL">Statewide (Select a district above)</option>';
    }

    const container = document.getElementById("district-places-list");
    if (container) {
      container.innerHTML = `
        <div class="places-empty-state">
          <i class="fa-solid fa-map-location-dot"></i>
          <p>Select a specific district from the <strong>Select District</strong> dropdown above to view and explore each and every mandal, village, and danger zone in that district.</p>
        </div>
      `;
    }
    currentDistrictPlaces = [];
    return;
  }

  const dName = distDetails.district;
  const hq = distDetails.headquarters || dName;
  const highways = (distDetails.highways || []).join(", ");
  const mCount = distDetails.total_mandals || mandals.length;
  const vCount = distDetails.total_villages || villages.length;
  const dsCount = distDetails.total_danger_spots || dangerSpots.length;
  const ambCount = mCount;

  document.getElementById("explorer-total-badge").textContent = `${mCount + vCount} Places`;
  document.getElementById("explorer-district-name").textContent = `${dName} District`;
  document.getElementById("explorer-hq-info").textContent = `HQ: ${hq}${highways ? ' | Corridors: ' + highways : ''}`;
  document.getElementById("chip-mandals").textContent = mCount;
  document.getElementById("chip-villages").textContent = vCount;
  document.getElementById("chip-danger").textContent = dsCount;
  document.getElementById("chip-amb").textContent = ambCount;

  const places = [];

  // 1. Add all Mandals as primary administrative places
  mandals.forEach(m => {
    places.push({
      id: m.mandal_id,
      name: `${m.mandal_name} Mandal HQ`,
      type: "mandal",
      mandal: m.mandal_name,
      district: dName,
      lat: m.lat,
      lng: m.lng,
      population: m.population,
      tier: m.tier || "Mandal Center",
      village_count: m.village_count || 0,
      readyAmb: `${m.mandal_name} 108 Ready Emergency Station`,
      hazard: "Mandal Administrative & CHC Hub",
      severity: "HQ Stationed"
    });
  });

  // 2. Add all Villages
  villages.forEach(v => {
    const ds = v.danger_spot || {};
    places.push({
      id: v.village_id,
      name: v.village_name,
      type: "village",
      mandal: v.mandal,
      district: dName,
      lat: v.lat,
      lng: v.lng,
      population: v.population,
      has_phc: v.has_phc,
      gram_panchayat: v.gram_panchayat,
      readyAmb: `${v.mandal} 108 Ready Emergency Station`,
      hazard: ds.hazard_type || "Blind Highway Intersection",
      severity: ds.severity || "High Risk",
      annual_accidents: ds.annual_accidents || 0
    });
  });

  currentDistrictPlaces = places;

  // Populate Mandal Filter Dropdown
  const mandalSelect = document.getElementById("explorer-mandal-filter");
  if (mandalSelect) {
    const uniqueMandals = [...new Set(places.map(p => p.mandal))].sort();
    let mOptions = `<option value="ALL">All ${mCount} Mandals (${places.length} Places)</option>`;
    uniqueMandals.forEach(mName => {
      const pCount = places.filter(p => p.mandal.toLowerCase() === mName.toLowerCase()).length;
      mOptions += `<option value="${mName}">${mName} (${pCount} places)</option>`;
    });
    mandalSelect.innerHTML = mOptions;
  }

  renderFilteredPlaces();
}

function renderFilteredPlaces() {
  const container = document.getElementById("district-places-list");
  if (!container) return;

  const mandalFilterEl = document.getElementById("explorer-mandal-filter");
  const mandalFilter = mandalFilterEl ? mandalFilterEl.value : "ALL";

  const searchEl = document.getElementById("explorer-place-search");
  const searchQuery = searchEl ? searchEl.value.trim().toLowerCase() : "";

  let filtered = currentDistrictPlaces;
  if (mandalFilter && mandalFilter !== "ALL") {
    filtered = filtered.filter(p => p.mandal.toLowerCase() === mandalFilter.toLowerCase());
  }
  if (searchQuery) {
    filtered = filtered.filter(p =>
      p.name.toLowerCase().includes(searchQuery) ||
      p.mandal.toLowerCase().includes(searchQuery) ||
      (p.hazard && p.hazard.toLowerCase().includes(searchQuery))
    );
  }

  const countEl = document.getElementById("places-display-count");
  if (countEl) {
    countEl.textContent = `Showing ${filtered.length} of ${currentDistrictPlaces.length} places`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="places-empty-state">
        <i class="fa-solid fa-magnifying-glass"></i>
        <p>No places matched your filter query.</p>
      </div>
    `;
    return;
  }

  const displayLimit = 150;
  const itemsToRender = filtered.slice(0, displayLimit);

  let html = "";
  itemsToRender.forEach(p => {
    const isMandal = p.type === "mandal";
    const badgeClass = isMandal ? "mandal" : "village";
    const badgeText = isMandal ? "Mandal HQ" : (p.has_phc ? "PHC Village" : "Gramam");
    const safeLng = clampCoastline(p.lat, p.lng);

    html += `
      <div class="place-card-item" id="card-${p.id}">
        <div class="place-card-top">
          <span class="place-card-name">${p.name}</span>
          <span class="place-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="place-card-meta">
          <span><i class="fa-solid fa-building-columns"></i> ${p.mandal} Mdl</span>
          <span><i class="fa-solid fa-users"></i> ${p.population ? p.population.toLocaleString() : '--'}</span>
        </div>
        <div class="place-danger-preview">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>${p.hazard} (${p.severity})</span>
        </div>
        <div class="place-amb-preview">
          <i class="fa-solid fa-truck-medical"></i>
          <span>${p.readyAmb}</span>
        </div>
        <div class="place-card-actions">
          <button class="btn-place-zoom" onclick="focusOnPlace(${p.lat}, ${safeLng}, '${p.name.replace(/'/g, "\\'")}', '${p.type}')">
            <i class="fa-solid fa-crosshairs"></i> View
          </button>
          <button class="btn-place-dispatch" onclick="handleAccidentReport(${p.lat}, ${safeLng}, '${p.name.replace(/'/g, "\\'")}', '${p.district.replace(/'/g, "\\'")}', '${p.mandal.replace(/'/g, "\\'")}')">
            <i class="fa-solid fa-truck-medical"></i> Dispatch
          </button>
          <button class="btn-place-zoom" style="color:#10b981; border-color:rgba(16, 185, 129, 0.4); background:rgba(16, 185, 129, 0.1);" title="Click manual button to place ambulance nearer" onclick="placeAmbulanceNearer(${p.lat}, ${safeLng}, '${p.name.replace(/'/g, "\\'")}', '${p.district.replace(/'/g, "\\'")}', '${p.mandal.replace(/'/g, "\\'")}')">
            <i class="fa-solid fa-truck-fast"></i> Nearer
          </button>
        </div>
      </div>
    `;
  });

  if (filtered.length > displayLimit) {
    html += `
      <div style="text-align:center; padding:8px; font-size:0.75rem; color:var(--text-muted);">
        ... and ${filtered.length - displayLimit} more places. Type in search to narrow results.
      </div>
    `;
  }

  container.innerHTML = html;
}

function focusOnPlace(lat, lng, name, type) {
  const safeLng = clampCoastline(lat, lng);
  map.flyTo([lat, safeLng], 14, { duration: 1.2 });

  const highlightCircle = L.circleMarker([lat, safeLng], {
    radius: 18,
    color: '#38bdf8',
    fillColor: '#38bdf8',
    fillOpacity: 0.4,
    weight: 3
  }).addTo(map);

  highlightCircle.bindTooltip(`<b>📍 ${name}</b>`, {
    permanent: true,
    direction: 'top',
    className: 'bold-map-label'
  }).openTooltip();

  setTimeout(() => {
    map.removeLayer(highlightCircle);
  }, 5000);
}

function fitDistrictBounds() {
  if (currentDistrictBounds) {
    map.fitBounds(currentDistrictBounds, { padding: [40, 40] });
  }
}

function scrollToManualPanel() {
  const panel = document.getElementById("custom-ambulances-panel");
  if (panel) {
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    panel.style.transition = "box-shadow 0.3s ease, border-color 0.3s ease";
    panel.style.boxShadow = "0 0 25px rgba(16, 185, 129, 0.7)";
    panel.style.borderColor = "#10b981";
    setTimeout(() => {
      panel.style.boxShadow = "";
      panel.style.borderColor = "";
    }, 2500);
  }
}

// ==========================================================================
// Role-Based Access Control (RBAC) & Authentication Logic
// ==========================================================================

async function checkCurrentUser() {
  try {
    const res = await fetch("/api/auth/current_user");
    const data = await res.json();
    if (data.status === "success" && data.user) {
      currentUser = data.user;
    } else {
      currentUser = null;
    }
    updateUserUI();
  } catch (e) {
    console.error("Error checking current user:", e);
    currentUser = null;
    updateUserUI();
  }
}

function updateUserUI() {
  const statusContainer = document.getElementById("header-user-status");
  const officerConsoleBtn = document.getElementById("btn-header-officer-console");
  
  if (!statusContainer) return;

  if (currentUser && currentUser.role === "officer") {
    // Show Officer badge & controls
    statusContainer.innerHTML = `
      <div class="user-profile-badge badge-officer" title="Logged in as Command Center Authority">
        <span class="user-role-tag"><i class="fa-solid fa-shield-halved"></i> Officer</span>
        <span class="user-display-name">${currentUser.name || currentUser.username}</span>
        <button class="btn-logout" onclick="handleLogout()" title="Sign out of Command Console">
          <i class="fa-solid fa-right-from-bracket"></i>
        </button>
      </div>
    `;
    if (officerConsoleBtn) officerConsoleBtn.style.display = "inline-flex";
  } else if (currentUser && currentUser.role === "public") {
    // Show Citizen badge & controls
    statusContainer.innerHTML = `
      <div class="user-profile-badge badge-citizen" title="Logged in as Public Citizen">
        <span class="user-role-tag"><i class="fa-solid fa-user"></i> Citizen</span>
        <span class="user-display-name">${currentUser.name || currentUser.username}</span>
        <button class="btn-logout" onclick="handleLogout()" title="Sign out of Public Portal">
          <i class="fa-solid fa-right-from-bracket"></i>
        </button>
      </div>
    `;
    if (officerConsoleBtn) officerConsoleBtn.style.display = "none";
  } else {
    // Guest Mode
    statusContainer.innerHTML = `
      <button class="btn-header-action btn-accent-green" id="btn-header-login" onclick="openAuthModal()">
        <i class="fa-solid fa-right-to-bracket"></i> Sign In / Role
      </button>
    `;
    if (officerConsoleBtn) officerConsoleBtn.style.display = "none";
  }
}

let currentAuthMode = "signin";
let currentAuthRole = "officer";

function openAuthModal(preferredRole = "officer", preferredMode = "signin") {
  const modal = document.getElementById("modal-auth");
  if (modal) {
    modal.classList.add("active");
    switchAuthMode(preferredMode);
    switchAuthRole(preferredRole);
  }
}

function closeAuthModal() {
  const modal = document.getElementById("modal-auth");
  if (modal) modal.classList.remove("active");
}

function switchAuthMode(mode) {
  currentAuthMode = mode;
  const signinBtn = document.getElementById("btn-mode-signin");
  const signupBtn = document.getElementById("btn-mode-signup");
  const signinContainer = document.getElementById("auth-signin-container");
  const signupContainer = document.getElementById("auth-signup-container");
  const modalTitle = document.getElementById("auth-modal-title");

  if (mode === "signup") {
    if (signinBtn) signinBtn.classList.remove("active");
    if (signupBtn) signupBtn.classList.add("active");
    if (signinContainer) signinContainer.style.display = "none";
    if (signupContainer) signupContainer.style.display = "block";
    if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-user-plus" style="color:#38bdf8;"></i> Create New Account';
  } else {
    if (signinBtn) signinBtn.classList.add("active");
    if (signupBtn) signupBtn.classList.remove("active");
    if (signinContainer) signinContainer.style.display = "block";
    if (signupContainer) signupContainer.style.display = "none";
    if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-id-card-clip" style="color:#38bdf8;"></i> Portal Login & Access';
  }
  // Refresh sections for current role
  switchAuthRole(currentAuthRole);
}

function switchAuthRole(role) {
  currentAuthRole = role;
  const officerBtn = document.getElementById("tab-officer-btn");
  const publicBtn = document.getElementById("tab-public-btn");

  const signinOfficer = document.getElementById("signin-officer-section");
  const signinPublic = document.getElementById("signin-public-section");
  const signupOfficer = document.getElementById("signup-officer-section");
  const signupPublic = document.getElementById("signup-public-section");

  if (role === "public") {
    if (officerBtn) officerBtn.classList.remove("active-officer");
    if (publicBtn) publicBtn.classList.add("active-public");

    if (signinOfficer) signinOfficer.style.display = "none";
    if (signinPublic) signinPublic.style.display = "block";
    if (signupOfficer) signupOfficer.style.display = "none";
    if (signupPublic) signupPublic.style.display = "block";
  } else {
    if (officerBtn) officerBtn.classList.add("active-officer");
    if (publicBtn) publicBtn.classList.remove("active-public");

    if (signinOfficer) signinOfficer.style.display = "block";
    if (signinPublic) signinPublic.style.display = "none";
    if (signupOfficer) signupOfficer.style.display = "block";
    if (signupPublic) signupPublic.style.display = "none";
  }
}

function switchAuthTab(tab) {
  switchAuthRole(tab);
}

async function handleOfficerLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById("officer-username")?.value.trim();
  const password = document.getElementById("officer-password")?.value;

  if (!username || !password) {
    alert("Please enter both Officer ID / Mail ID and password.");
    return;
  }

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: "officer" })
    });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      updateUserUI();
      closeAuthModal();
      loadOfficerConsoleData();
      alert(`Welcome, Officer ${data.user.name || username}! Command authorization granted.`);
    } else {
      alert(`Login failed: ${data.message || 'Invalid officer credentials'}`);
    }
  } catch (err) {
    console.error("Officer login error:", err);
    alert("Connection error during login. Please try again.");
  }
}

async function handlePublicLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById("public-username")?.value.trim();
  const password = document.getElementById("public-password")?.value;

  if (!username || !password) {
    alert("Please enter both Mobile Number / Mail ID and password.");
    return;
  }

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: "public" })
    });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      updateUserUI();
      closeAuthModal();
      alert(`Welcome, ${data.user.name || username}! You can now recommend ambulance positioning and report accidents.`);
    } else {
      alert(`Login failed: ${data.message || 'Error logging in'}`);
    }
  } catch (err) {
    console.error("Public login error:", err);
    alert("Connection error during login. Please try again.");
  }
}

async function handleOfficerRegister(e) {
  if (e) e.preventDefault();
  const name = document.getElementById("reg-officer-name")?.value.trim();
  const email = document.getElementById("reg-officer-email")?.value.trim();
  const phone = document.getElementById("reg-officer-phone")?.value.trim();
  const officer_id = document.getElementById("reg-officer-id")?.value.trim();
  const password = document.getElementById("reg-officer-password")?.value;

  if (!name || !email || !phone || !officer_id || !password) {
    alert("Please fill in all required registration fields (Full Name, Mail ID, Mobile Number, Officer ID, Password).");
    return;
  }

  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "officer",
        name,
        email,
        phone,
        officer_id,
        password
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      updateUserUI();
      closeAuthModal();
      loadOfficerConsoleData();
      alert(`✅ Registration successful! Welcome, Officer ${name}. You now have full fleet command authority.`);
    } else {
      alert(`Registration failed: ${data.message || 'Could not register officer.'}`);
    }
  } catch (err) {
    console.error("Officer register error:", err);
    alert("Connection error during registration. Please try again.");
  }
}

async function handlePublicRegister(e) {
  if (e) e.preventDefault();
  const name = document.getElementById("reg-public-name")?.value.trim();
  const email = document.getElementById("reg-public-email")?.value.trim();
  const phone = document.getElementById("reg-public-phone")?.value.trim();
  const password = document.getElementById("reg-public-password")?.value;

  if (!name || !email || !phone || !password) {
    alert("Please fill in all required registration fields (Full Name, Mail ID, Mobile Number, Password).");
    return;
  }

  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "public",
        name,
        email,
        phone,
        password
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      updateUserUI();
      closeAuthModal();
      alert(`✅ Registration successful! Welcome, ${name}. You can now submit ambulance recommendations and report road accidents.`);
    } else {
      alert(`Registration failed: ${data.message || 'Could not register citizen account.'}`);
    }
  } catch (err) {
    console.error("Public register error:", err);
    alert("Connection error during registration. Please try again.");
  }
}

async function handleLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (e) {}
  currentUser = null;
  updateUserUI();
}

// ==========================================================================
// Public Citizen Ambulance Recommendations
// ==========================================================================

function openRecommendModal() {
  const modal = document.getElementById("modal-recommend-ambulance");
  if (!modal) return;
  modal.classList.add("active");

  // Pre-fill user details if logged in
  if (currentUser) {
    const nameInput = document.getElementById("rec-name");
    const phoneInput = document.getElementById("rec-phone");
    if (nameInput && currentUser.name) nameInput.value = currentUser.name;
    if (phoneInput && currentUser.phone) phoneInput.value = currentUser.phone;
  }

  // Pre-fill lat/lng with current map center
  const center = map.getCenter();
  const latInput = document.getElementById("rec-lat");
  const lngInput = document.getElementById("rec-lng");
  if (latInput) latInput.value = center.lat.toFixed(5);
  if (lngInput) lngInput.value = clampCoastline(center.lat, center.lng).toFixed(5);

  populateMandalsForRec();
}

function closeRecommendModal() {
  const modal = document.getElementById("modal-recommend-ambulance");
  if (modal) modal.classList.remove("active");
}

function populateMandalsForRec() {
  const distSelect = document.getElementById("rec-district");
  const mandalSelect = document.getElementById("rec-mandal");
  if (!distSelect || !mandalSelect) return;

  const selectedDist = distSelect.value;
  const filteredMandals = allMandals.filter(m => matchDistrict(m.district, selectedDist));

  mandalSelect.innerHTML = '<option value="General">All / General Mandal</option>';
  filteredMandals.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.mandal_name;
    opt.textContent = `${m.mandal_name} Mandal`;
    mandalSelect.appendChild(opt);
  });
}

function useMapCenterForRec() {
  const center = map.getCenter();
  const latInput = document.getElementById("rec-lat");
  const lngInput = document.getElementById("rec-lng");
  if (latInput) latInput.value = center.lat.toFixed(5);
  if (lngInput) lngInput.value = clampCoastline(center.lat, center.lng).toFixed(5);
}

async function handleRecommendationSubmit(e) {
  if (e) e.preventDefault();
  const district = document.getElementById("rec-district")?.value || "General";
  const mandal = document.getElementById("rec-mandal")?.value || "General";
  const village = document.getElementById("rec-village")?.value.trim();
  const lat = parseFloat(document.getElementById("rec-lat")?.value);
  const lng = parseFloat(document.getElementById("rec-lng")?.value);
  const vehicleTier = document.getElementById("rec-vehicle-type")?.value || "Basic Life Support (BLS)";
  const reason = document.getElementById("rec-reason")?.value.trim();
  const citizenName = document.getElementById("rec-name")?.value.trim();
  const citizenPhone = document.getElementById("rec-phone")?.value.trim();

  if (!village || isNaN(lat) || isNaN(lng) || !reason) {
    alert("Please fill in all required fields.");
    return;
  }

  try {
    const res = await fetch("/api/public/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        district,
        mandal,
        village_or_junction: village,
        lat,
        lng,
        vehicle_tier: vehicleTier,
        reason,
        citizen_name: citizenName,
        citizen_phone: citizenPhone
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeRecommendModal();
      alert("✅ Your 108 ambulance recommendation has been submitted to the Command Center Officers for verification!");
      await loadPublicRecommendations();
    } else {
      alert("Submission error: " + (data.message || "Could not submit recommendation."));
    }
  } catch (err) {
    console.error("Recommendation submission error:", err);
    alert("Connection error while submitting recommendation.");
  }
}

async function loadPublicRecommendations() {
  try {
    const res = await fetch("/api/public/recommendations");
    const data = await res.json();
    if (data.status === "success" && Array.isArray(data.recommendations)) {
      allPublicRecommendations = data.recommendations;
    } else {
      allPublicRecommendations = [];
    }
    
    // Update badge & legend counters
    const legendRecCount = document.getElementById("legend-rec-count");
    if (legendRecCount) legendRecCount.textContent = allPublicRecommendations.length;

    const pendingCount = allPublicRecommendations.filter(r => (r.status || "").toLowerCase().includes("pending")).length;
    const consoleBadge = document.getElementById("console-rec-count");
    if (consoleBadge) consoleBadge.textContent = pendingCount;
    updateOfficerNotificationBadge();

    renderPublicRecommendationsMap(allPublicRecommendations);
  } catch (e) {
    console.error("Error loading public recommendations:", e);
  }
}

function renderPublicRecommendationsMap(recs) {
  layers.publicRecommendations.clearLayers();
  if (!recs || recs.length === 0) return;

  recs.forEach(rec => {
    const safeLng = clampCoastline(rec.lat, rec.lng);
    const recId = rec.rec_id || rec.id;
    const isPending = (rec.status || "").toLowerCase().includes("pending");
    const isApproved = (rec.status || "").toLowerCase().includes("approved");
    const markerColor = isApproved ? "#10b981" : (isPending ? "#ca8a04" : "#94a3b8");

    const icon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div style="background:${markerColor}; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 10px ${markerColor};">
          <i class="fa-solid fa-lightbulb" style="font-size:13px;"></i>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([rec.lat, safeLng], { icon: icon });
    marker.bindTooltip(`<b>💡 Suggestion: ${rec.village_or_junction}</b> <small>(${rec.status.toUpperCase()})</small>`, {
      direction: "top",
      className: "bold-map-label"
    });

    let actionButtons = "";
    if (currentUser && currentUser.role === "officer" && isPending) {
      actionButtons = `
        <div style="margin-top:8px; display:flex; gap:6px;">
          <button onclick="approveCitizenRecommendation('${recId}')" style="flex:1; background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer;">
            <i class="fa-solid fa-check"></i> Approve & Deploy
          </button>
          <button onclick="rejectCitizenRecommendation('${recId}')" style="background:#fee2e2; color:#991b1b; border:1px solid #f87171; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer;">
            <i class="fa-solid fa-xmark"></i> Reject
          </button>
        </div>
      `;
    }

    const recVillage = rec.village_or_junction || rec.village || 'Recommended Base';
    const recTier = rec.vehicle_tier || rec.vehicle_type || 'ALS';
    const recCitizen = rec.citizen_name || rec.reporter_name || 'Public Citizen';
    const recPhone = rec.citizen_phone || rec.reporter_phone || '--';

    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:220px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <strong style="color:${markerColor}; font-size:13px;"><i class="fa-solid fa-lightbulb"></i> Citizen Recommendation</strong>
          <span style="font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; background:${isApproved ? '#dcfce7' : (isPending ? '#fef3c7' : '#f1f5f9')}; color:${isApproved ? '#15803d' : (isPending ? '#b45309' : '#64748b')};">${(rec.status || 'PENDING').toUpperCase()}</span>
        </div>
        <strong>Location:</strong> ${recVillage}<br>
        <strong>Mandal:</strong> ${rec.mandal} | <strong>District:</strong> ${rec.district}<br>
        <strong>Tier:</strong> ${recTier}<br>
        <strong>Citizen:</strong> ${recCitizen} (${recPhone})<br>
        <div style="margin-top:6px; padding:4px 6px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px; font-size:11px;">
          <strong>Justification:</strong> ${rec.reason}
        </div>
        ${actionButtons}
      </div>
    `);

    layers.publicRecommendations.addLayer(marker);
  });
}

// ==========================================================================
// Public Citizen Road Accident Reporting
// ==========================================================================

function openReportAccidentModal() {
  const modal = document.getElementById("modal-report-accident");
  if (!modal) return;
  modal.classList.add("active");

  if (currentUser) {
    const callerName = document.getElementById("acc-caller-name");
    const callerPhone = document.getElementById("acc-caller-phone");
    if (callerName && currentUser.name) callerName.value = currentUser.name;
    if (callerPhone && currentUser.phone) callerPhone.value = currentUser.phone;
  }

  // Pre-fill coordinates with clicked location or map center
  const target = lastIncident && lastIncident.lat ? lastIncident : map.getCenter();
  const latInput = document.getElementById("acc-lat");
  const lngInput = document.getElementById("acc-lng");
  if (latInput) latInput.value = target.lat.toFixed(5);
  if (lngInput) lngInput.value = clampCoastline(target.lat, target.lng).toFixed(5);
}

function closeReportAccidentModal() {
  const modal = document.getElementById("modal-report-accident");
  if (!modal) return;
  modal.classList.remove("active");
}

function selectSeverity(level) {
  const input = document.getElementById("acc-severity");
  if (input) input.value = level;

  document.querySelectorAll(".severity-option").forEach(el => el.classList.remove("selected"));
  const targetId = level === "Critical" ? "sev-critical" : (level === "Serious" ? "sev-serious" : "sev-moderate");
  const targetEl = document.getElementById(targetId);
  if (targetEl) targetEl.classList.add("selected");
}

function useMapCenterForAccident() {
  const center = map.getCenter();
  const latInput = document.getElementById("acc-lat");
  const lngInput = document.getElementById("acc-lng");
  if (latInput) latInput.value = center.lat.toFixed(5);
  if (lngInput) lngInput.value = clampCoastline(center.lat, center.lng).toFixed(5);
}

async function handleAccidentReportSubmit(e) {
  if (e) e.preventDefault();
  const location = document.getElementById("acc-location")?.value.trim();
  const lat = parseFloat(document.getElementById("acc-lat")?.value);
  const lng = parseFloat(document.getElementById("acc-lng")?.value);
  const severity = document.getElementById("acc-severity")?.value || "Critical";
  const injuredCount = parseInt(document.getElementById("acc-injured")?.value) || 1;
  const landmark = document.getElementById("acc-landmark")?.value.trim();
  const description = document.getElementById("acc-description")?.value.trim();
  const callerName = document.getElementById("acc-caller-name")?.value.trim();
  const callerPhone = document.getElementById("acc-caller-phone")?.value.trim();

  if (!location || isNaN(lat) || isNaN(lng) || !callerName || !callerPhone) {
    alert("Please fill in all required accident report fields.");
    return;
  }

  try {
    const res = await fetch("/api/public/report_accident", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location_description: location,
        lat,
        lng,
        severity,
        injured_count: injuredCount,
        landmark,
        incident_description: description,
        caller_name: callerName,
        caller_phone: callerPhone
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeReportAccidentModal();
      await loadReportedAccidents();
      
      // Pan to accident location and launch live dispatch animation
      map.flyTo([lat, lng], 13, { duration: 1.2 });
      handleAccidentReport(lat, lng, `🚨 Citizen Call: ${location}`, "Accident Scene", "Active Dispatch");
      
      const eta = data.dispatch?.response_metrics?.eta_minutes || "calculated";
      alert(`🚨 Road accident logged successfully! Nearest 108 ambulance dispatched. Estimated ETA: ${eta} minutes.`);
    } else {
      alert("Error reporting accident: " + (data.message || "Failed"));
    }
  } catch (err) {
    console.error("Error submitting accident report:", err);
    alert("Network error reporting accident.");
  }
}

async function loadReportedAccidents() {
  try {
    const res = await fetch("/api/reported_accidents");
    const data = await res.json();
    if (data.status === "success" && Array.isArray(data.accidents)) {
      allReportedAccidents = data.accidents;
    } else {
      allReportedAccidents = [];
    }

    const legendAccCount = document.getElementById("legend-accident-count");
    if (legendAccCount) legendAccCount.textContent = allReportedAccidents.length;

    const activeAccidents = allReportedAccidents.filter(a => a.status === "dispatched" || a.status === "in_progress").length;
    const consoleBadge = document.getElementById("console-acc-count");
    if (consoleBadge) consoleBadge.textContent = activeAccidents;
    updateOfficerNotificationBadge();

    renderReportedAccidentsMap(allReportedAccidents);
  } catch (e) {
    console.error("Error loading reported accidents:", e);
  }
}

function renderReportedAccidentsMap(accidents) {
  layers.reportedAccidents.clearLayers();
  if (!accidents || accidents.length === 0) return;

  accidents.forEach(acc => {
    const safeLng = clampCoastline(acc.lat, acc.lng);
    const accId = acc.accident_id || acc.id;
    const isResolved = (acc.status || "").toLowerCase().includes("resolve");
    const isCritical = (acc.severity || "").toLowerCase().includes("critical");
    const color = isResolved ? "#10b981" : (isCritical ? "#dc2626" : "#f97316");

    const accLoc = acc.location_description || acc.location_name || "Reported Crash Scene";
    const accCaller = acc.caller_name || acc.reporter_name || "Citizen Caller";
    const accPhone = acc.caller_phone || acc.reporter_phone || "--";
    const accAmbulance = acc.nearest_ambulance || acc.dispatched_ambulance;

    const icon = L.divIcon({
      className: "custom-div-icon",
      html: `
        <div style="background:${color}; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 0 12px ${color};">
          <i class="fa-solid fa-car-burst" style="font-size:13px;"></i>
        </div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });

    const marker = L.marker([acc.lat, safeLng], { icon: icon });
    marker.bindTooltip(`<b>🚨 ${accLoc}</b> <small>(${acc.severity || 'Emergency'})</small>`, {
      direction: "top",
      className: "bold-map-label"
    });

    let resolveButton = "";
    if (currentUser && currentUser.role === "officer" && !isResolved) {
      resolveButton = `
        <button onclick="resolveReportedAccident('${accId}')" style="margin-top:8px; width:100%; background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:700; cursor:pointer;">
          <i class="fa-solid fa-check-circle"></i> Mark Accident as Resolved
        </button>
      `;
    }

    marker.bindPopup(`
      <div style="font-family:'Inter', sans-serif; font-size:12px; color:#0f172a; min-width:230px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <strong style="color:${color}; font-size:13px;"><i class="fa-solid fa-triangle-exclamation"></i> Reported Crash</strong>
          <span style="font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; background:${isResolved ? '#dcfce7' : '#fee2e2'}; color:${isResolved ? '#15803d' : '#991b1b'};">${(acc.status || 'ACTIVE').toUpperCase()}</span>
        </div>
        <strong>Location:</strong> ${accLoc}<br>
        <strong>Severity:</strong> <span style="font-weight:700; color:${color};">${acc.severity || 'Critical'}</span> (${acc.injured_count || 1} Injured)<br>
        <strong>Caller:</strong> ${accCaller} (${accPhone})<br>
        ${accAmbulance ? `<strong>Assigned Unit:</strong> ${accAmbulance} (ETA: ${acc.eta_minutes || '--'} min)<br>` : ''}
        ${acc.landmark ? `<strong>Landmark:</strong> ${acc.landmark}<br>` : ''}
        <div style="margin-top:6px; display:flex; gap:6px;">
          <button onclick="handleAccidentReport(${acc.lat}, ${safeLng}, '${accLoc.replace(/'/g, "\\'")}')" style="flex:1; background:#ef4444; color:#fff; border:none; border-radius:4px; padding:5px 8px; font-size:11px; font-weight:700; cursor:pointer;">
            <i class="fa-solid fa-truck-medical"></i> View Dispatch
          </button>
        </div>
        ${resolveButton}
      </div>
    `);

    layers.reportedAccidents.addLayer(marker);
  });
}

function updateOfficerNotificationBadge() {
  const badge = document.getElementById("officer-badge-count");
  if (!badge) return;
  const pendingRecs = allPublicRecommendations.filter(r => (r.status || "").toLowerCase().includes("pending")).length;
  const activeAccidents = allReportedAccidents.filter(a => !(a.status || "").toLowerCase().includes("resolve")).length;
  const total = pendingRecs + activeAccidents;
  badge.textContent = total;
  badge.style.display = total > 0 ? "inline-block" : "none";
}

// ==========================================================================
// Officer Command Console Actions
// ==========================================================================

function openOfficerConsoleModal() {
  if (!currentUser || currentUser.role !== "officer") {
    openRestrictedNotice("console");
    return;
  }
  const modal = document.getElementById("modal-officer-console");
  if (modal) {
    modal.classList.add("active");
    loadOfficerConsoleData();
  }
}

function closeOfficerConsoleModal() {
  const modal = document.getElementById("modal-officer-console");
  if (modal) modal.classList.remove("active");
}

function switchConsoleTab(tab) {
  const recBtn = document.getElementById("tab-console-recs-btn");
  const accBtn = document.getElementById("tab-console-accs-btn");
  const recsView = document.getElementById("console-recs-view");
  const accsView = document.getElementById("console-accs-view");

  if (tab === "accs") {
    if (recBtn) recBtn.classList.remove("active-officer");
    if (accBtn) accBtn.classList.add("active-officer");
    if (recsView) recsView.style.display = "none";
    if (accsView) accsView.style.display = "block";
  } else {
    if (recBtn) recBtn.classList.add("active-officer");
    if (accBtn) accBtn.classList.remove("active-officer");
    if (recsView) recsView.style.display = "block";
    if (accsView) accsView.style.display = "none";
  }
}

async function loadOfficerConsoleData() {
  await loadPublicRecommendations();
  await loadReportedAccidents();

  // Render Recommendations Cards
  const recsList = document.getElementById("console-recs-list");
  if (recsList) {
    if (allPublicRecommendations.length === 0) {
      recsList.innerHTML = `<div class="places-empty-state"><p>No citizen recommendations submitted yet.</p></div>`;
    } else {
      recsList.innerHTML = allPublicRecommendations.map(r => {
        const isPending = (r.status || "").toLowerCase().includes("pending");
        const isApproved = (r.status || "").toLowerCase().includes("approved");
        const recId = r.rec_id || r.id;
        const rVillage = r.village_or_junction || r.village || "Recommended Base";
        const rTier = r.vehicle_tier || r.vehicle_type || "ALS";
        const rCitizen = r.citizen_name || r.reporter_name || "Public Citizen";
        const rPhone = r.citizen_phone || r.reporter_phone || "N/A";

        const statusBadge = isApproved ? 
          '<span style="background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;">APPROVED</span>' :
          (isPending ? '<span style="background:#fef3c7; color:#b45309; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;">PENDING REVIEW</span>' :
          '<span style="background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;">REJECTED</span>');

        return `
          <div class="console-card">
            <div class="console-card-header">
              <span class="console-card-title"><i class="fa-solid fa-location-dot" style="color:#eab308;"></i> ${rVillage}</span>
              ${statusBadge}
            </div>
            <div class="console-card-meta">
              <div><strong>District:</strong> ${r.district} | <strong>Mandal:</strong> ${r.mandal}</div>
              <div><strong>Vehicle Tier:</strong> ${rTier}</div>
              <div><strong>Recommended By:</strong> ${rCitizen} (${rPhone})</div>
              <div style="margin-top:4px; font-style:italic; color:#cbd5e1;">"${r.reason}"</div>
            </div>
            <div class="console-card-actions">
              <button class="btn-sm btn-primary" style="background:#38bdf8; border-color:#0284c7; color:#0f172a; font-weight:700;" onclick="focusOnPlace(${r.lat}, ${r.lng}, '${rVillage.replace(/'/g, "\\'")}', 'recommendation'); closeOfficerConsoleModal();">
                <i class="fa-solid fa-crosshairs"></i> View on Map
              </button>
              ${isPending ? `
                <button class="btn-sm btn-success" style="font-weight:700;" onclick="approveCitizenRecommendation('${recId}')">
                  <i class="fa-solid fa-check"></i> Approve & Station 108
                </button>
                <button class="btn-sm btn-danger" style="font-weight:700;" onclick="rejectCitizenRecommendation('${recId}')">
                  <i class="fa-solid fa-xmark"></i> Reject
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Render Accidents Cards
  const accsList = document.getElementById("console-accs-list");
  if (accsList) {
    if (allReportedAccidents.length === 0) {
      accsList.innerHTML = `<div class="places-empty-state"><p>No road accidents currently reported.</p></div>`;
    } else {
      accsList.innerHTML = allReportedAccidents.map(a => {
        const isResolved = (a.status || "").toLowerCase().includes("resolve");
        const accId = a.accident_id || a.id;
        const aLoc = a.location_description || a.location_name || "Reported Crash Scene";
        const aCaller = a.caller_name || a.reporter_name || "Citizen Caller";
        const aPhone = a.caller_phone || a.reporter_phone || "N/A";
        const aAmbulance = a.nearest_ambulance || a.dispatched_ambulance;

        const statusBadge = isResolved ?
          '<span style="background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;">RESOLVED</span>' :
          '<span style="background:#fee2e2; color:#ef4444; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;">DISPATCH ACTIVE</span>';

        return `
          <div class="console-card">
            <div class="console-card-header">
              <span class="console-card-title"><i class="fa-solid fa-car-burst" style="color:#ef4444;"></i> ${aLoc}</span>
              ${statusBadge}
            </div>
            <div class="console-card-meta">
              <div><strong>Severity:</strong> <span style="color:#f87171; font-weight:700;">${a.severity || 'Critical'}</span> | <strong>Injured:</strong> ${a.injured_count || 1} persons</div>
              <div><strong>Caller:</strong> ${aCaller} (${aPhone})</div>
              ${a.landmark ? `<div><strong>Landmark:</strong> ${a.landmark}</div>` : ''}
              ${aAmbulance ? `<div><strong>Assigned 108:</strong> ${aAmbulance} (ETA: ${a.eta_minutes || '--'} min)</div>` : ''}
            </div>
            <div class="console-card-actions">
              <button class="btn-sm btn-primary" style="background:#ef4444; border-color:#dc2626; color:#fff; font-weight:700;" onclick="handleAccidentReport(${a.lat}, ${a.lng}, '${aLoc.replace(/'/g, "\\'")}'); closeOfficerConsoleModal();">
                <i class="fa-solid fa-truck-medical"></i> Dispatch Simulation
              </button>
              ${!isResolved ? `
                <button class="btn-sm btn-success" style="font-weight:700;" onclick="resolveReportedAccident('${accId}')">
                  <i class="fa-solid fa-check-circle"></i> Resolve Incident
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join("");
    }
  }
}

async function approveCitizenRecommendation(recId) {
  try {
    const res = await fetch(`/api/officer/approve_recommendation/${encodeURIComponent(recId)}`, {
      method: "POST"
    });
    const data = await res.json();
    if (data.status === "success") {
      alert("✅ Recommendation APPROVED by Command Officer! A permanent 108 ambulance base has been stationed.");
      await loadManualAmbulances();
      await loadOfficerConsoleData();
    } else {
      alert("Approval error: " + (data.message || "Failed"));
    }
  } catch (e) {
    console.error("Error approving recommendation:", e);
  }
}

async function rejectCitizenRecommendation(recId) {
  const reason = prompt("Enter reason for rejection (optional):", "Sufficient existing coverage in sector");
  if (reason === null) return;

  try {
    const res = await fetch(`/api/officer/reject_recommendation/${encodeURIComponent(recId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_notes: reason })
    });
    const data = await res.json();
    if (data.status === "success") {
      await loadOfficerConsoleData();
    } else {
      alert("Error rejecting recommendation: " + (data.message || "Failed"));
    }
  } catch (e) {
    console.error("Error rejecting recommendation:", e);
  }
}

async function resolveReportedAccident(accidentId) {
  try {
    const res = await fetch(`/api/officer/resolve_accident/${encodeURIComponent(accidentId)}`, {
      method: "POST"
    });
    const data = await res.json();
    if (data.status === "success") {
      alert("Accident marked as resolved.");
      await loadOfficerConsoleData();
    } else {
      alert("Error resolving accident: " + (data.message || "Failed"));
    }
  } catch (e) {
    console.error("Error resolving accident:", e);
  }
}

// ==========================================================================
// Role Restriction Dialog
// ==========================================================================

function openRestrictedNotice(action = "general") {
  const modal = document.getElementById("modal-restricted-notice");
  if (modal) modal.classList.add("active");
}

function closeRestrictedNotice() {
  const modal = document.getElementById("modal-restricted-notice");
  if (modal) modal.classList.remove("active");
}

// Global window exposure for inline Leaflet handlers
window.placeAmbulanceNearer = placeAmbulanceNearer;
window.saveManualAmbulance = saveManualAmbulance;
window.deleteManualAmbulance = deleteManualAmbulance;
window.deleteAllManualAmbulances = deleteAllManualAmbulances;
window.scrollToManualPanel = scrollToManualPanel;
window.handleAccidentReport = handleAccidentReport;
window.focusOnPlace = focusOnPlace;
window.fitDistrictBounds = fitDistrictBounds;

// RBAC & Modal exposures
window.checkCurrentUser = checkCurrentUser;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthMode = switchAuthMode;
window.switchAuthRole = switchAuthRole;
window.switchAuthTab = switchAuthTab;
window.handleOfficerLogin = handleOfficerLogin;
window.handlePublicLogin = handlePublicLogin;
window.handleOfficerRegister = handleOfficerRegister;
window.handlePublicRegister = handlePublicRegister;
window.handleLogout = handleLogout;
window.openRecommendModal = openRecommendModal;
window.closeRecommendModal = closeRecommendModal;
window.populateMandalsForRec = populateMandalsForRec;
window.useMapCenterForRec = useMapCenterForRec;
window.handleRecommendationSubmit = handleRecommendationSubmit;
window.openReportAccidentModal = openReportAccidentModal;
window.closeReportAccidentModal = closeReportAccidentModal;
window.selectSeverity = selectSeverity;
window.useMapCenterForAccident = useMapCenterForAccident;
window.handleAccidentReportSubmit = handleAccidentReportSubmit;
window.openOfficerConsoleModal = openOfficerConsoleModal;
window.closeOfficerConsoleModal = closeOfficerConsoleModal;
window.switchConsoleTab = switchConsoleTab;
window.loadOfficerConsoleData = loadOfficerConsoleData;
window.approveCitizenRecommendation = approveCitizenRecommendation;
window.rejectCitizenRecommendation = rejectCitizenRecommendation;
window.resolveReportedAccident = resolveReportedAccident;
window.openRestrictedNotice = openRestrictedNotice;
window.closeRestrictedNotice = closeRestrictedNotice;


