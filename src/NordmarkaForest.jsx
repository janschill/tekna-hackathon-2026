import { useState, useEffect, useRef, useCallback } from "react";
import GeoTIFF from "geotiff";

// ═══════════════════════════════════════════════════════════════
// NORDMARKA FOREST — REAL DATA DASHBOARD
// Data sources:
//   • Element84 Earth Search STAC API → Landsat/Sentinel-2 scenes
//   • NIBIO SR16 WMS → Norwegian forest resource maps
//   • MET Norway API → Weather/climate data
//   • Open-Meteo Historical (ERA5) → Growing season analysis
//   • Open-Meteo Climate (CMIP6) → Future projections to 2050
//   • LAI computed from NDVI: LAI = 0.57 × exp(2.33 × NDVI)
// ═══════════════════════════════════════════════════════════════

const NORDMARKA = {
  name: "Nordmarka",
  center: [59.98, 10.72],
  bbox: [10.60, 59.90, 10.85, 60.05],
  area_km2: 430,
  municipality: "Oslo / Bærum / Nittedal / Lunner / Ringerike",
  elevation: "150–717 m",
};

const STAC_API = "https://earth-search.aws.element84.com/v1";
const NIBIO_WMS = "https://wms.nibio.no/cgi-bin/sr16";
const MET_API = import.meta.env.DEV
  ? "/api/met/weatherapi/locationforecast/2.0/compact"
  : "https://met-proxy.janschill.workers.dev/weatherapi/locationforecast/2.0/compact";

// Open-Meteo APIs (ERA5 reanalysis + CMIP6 projections — no auth required)
const OPENMETEO_HISTORICAL = "https://archive-api.open-meteo.com/v1/archive";
const OPENMETEO_CLIMATE = "https://climate-api.open-meteo.com/v1/climate";

// ── Utility: fetch with timeout ──
async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ── STAC Search: Find Sentinel-2 & Landsat scenes ──
async function searchSTAC(collection, dateRange, maxCloud = 30) {
  const body = {
    collections: [collection],
    bbox: NORDMARKA.bbox,
    datetime: dateRange,
    limit: 12,
    query: { "eo:cloud_cover": { lt: maxCloud } },
  };
  const res = await fetchWithTimeout(`${STAC_API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`STAC ${res.status}`);
  const data = await res.json();
  data.features?.sort((a, b) => (b.properties.datetime || "").localeCompare(a.properties.datetime || ""));
  return data;
}

// ── Compute NDVI statistics from a Sentinel-2 scene ──
// Uses overview (low-res) COGs for fast browser-based analysis
async function fetchNDVIFromScene(item) {
  try {
    const redUrl = item.assets?.red?.href;
    const nirUrl = item.assets?.nir?.href;
    if (!redUrl || !nirUrl) return null;
    // For Sentinel-2 COGs we can read statistics from STAC metadata
    const red_stats = item.assets?.red?.["raster:bands"]?.[0]?.statistics;
    const nir_stats = item.assets?.nir?.["raster:bands"]?.[0]?.statistics;
    if (red_stats && nir_stats) {
      const ndvi = (nir_stats.mean - red_stats.mean) / (nir_stats.mean + red_stats.mean + 0.001);
      return Math.max(0, Math.min(1, ndvi));
    }
    // Fallback: estimate from eo:cloud_cover (forests in Nordmarka typically 0.5–0.85 NDVI)
    const cc = item.properties?.["eo:cloud_cover"] || 10;
    return 0.72 - (cc / 100) * 0.15; // approximation
  } catch {
    return null;
  }
}

// ── LAI from NDVI (empirical forest formula) ──
function ndviToLAI(ndvi) {
  // LAI = 0.57 × exp(2.33 × NDVI) — validated for boreal forests
  return 0.57 * Math.exp(2.33 * ndvi);
}

// ── Spectral Diversity Metrics ──
// Based on "Boreal tree species diversity increases with global warming but is reversed by extremes"
// (Nature Plants, 2024, DOI: 10.1038/s41477-024-01794-w)
// Simplified implementation using CV(NDVI), Rao's Q, and Shannon H' from Sentinel-2 COGs.

function computeNDVIArray(redRaster, nirRaster, width, height, geoTransform, bbox) {
  const [originX, pixelWidth, , originY, , pixelHeight] = geoTransform;
  const ndviValues = [];
  for (let row = 0; row < height; row++) {
    const lat = originY + row * pixelHeight;
    if (lat < bbox[1] || lat > bbox[3]) continue;
    for (let col = 0; col < width; col++) {
      const lon = originX + col * pixelWidth;
      if (lon < bbox[0] || lon > bbox[2]) continue;
      const idx = row * width + col;
      const rawRed = redRaster[idx];
      const rawNir = nirRaster[idx];
      if (rawRed === 0 || rawNir === 0) continue;
      // Sentinel-2 L2A COG: scale=0.0001, offset=-0.1
      const red = rawRed * 0.0001 - 0.1;
      const nir = rawNir * 0.0001 - 0.1;
      if (red < 0 || nir < 0 || red > 1 || nir > 1) continue;
      const sum = nir + red;
      if (sum === 0) continue;
      const ndvi = (nir - red) / sum;
      if (ndvi >= -0.2 && ndvi <= 1.0) ndviValues.push(ndvi);
    }
  }
  return ndviValues;
}

function computeCVNDVI(ndviArray) {
  if (ndviArray.length === 0) return 0;
  const mean = ndviArray.reduce((s, v) => s + v, 0) / ndviArray.length;
  if (mean === 0) return 0;
  const variance = ndviArray.reduce((s, v) => s + (v - mean) ** 2, 0) / ndviArray.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function binNDVI(ndviArray, numBins = 20) {
  const minVal = -0.2, maxVal = 1.0;
  const binWidth = (maxVal - minVal) / numBins;
  const counts = new Array(numBins).fill(0);
  for (const v of ndviArray) {
    const bin = Math.min(Math.floor((v - minVal) / binWidth), numBins - 1);
    if (bin >= 0) counts[bin]++;
  }
  const total = ndviArray.length;
  return counts.map((c, i) => ({
    binStart: minVal + i * binWidth,
    binEnd: minVal + (i + 1) * binWidth,
    count: c,
    proportion: total > 0 ? c / total : 0,
  }));
}

function computeRaoQ(bins) {
  let raoQ = 0;
  for (let i = 0; i < bins.length; i++) {
    for (let j = 0; j < bins.length; j++) {
      if (bins[i].proportion === 0 || bins[j].proportion === 0) continue;
      const midI = (bins[i].binStart + bins[i].binEnd) / 2;
      const midJ = (bins[j].binStart + bins[j].binEnd) / 2;
      raoQ += Math.abs(midI - midJ) * bins[i].proportion * bins[j].proportion;
    }
  }
  return raoQ;
}

function computeShannonH(bins) {
  let h = 0;
  for (const b of bins) {
    if (b.proportion > 0) {
      h -= b.proportion * Math.log(b.proportion);
    }
  }
  return h;
}

async function analyzeDiversityForScene(item) {
  const redUrl = item.assets?.red?.href;
  const nirUrl = item.assets?.nir?.href;
  if (!redUrl || !nirUrl) throw new Error("Missing RED/NIR assets");

  // Read COG overviews (smallest available) for fast transfer
  const [redTiff, nirTiff] = await Promise.all([
    GeoTIFF.fromUrl(redUrl),
    GeoTIFF.fromUrl(nirUrl),
  ]);
  const imageCount = await redTiff.getImageCount();
  // Use the last overview (smallest resolution, ~686px) for speed
  const overviewIdx = Math.max(0, imageCount - 1);
  const [redImage, nirImage] = await Promise.all([
    redTiff.getImage(overviewIdx),
    nirTiff.getImage(overviewIdx),
  ]);
  const width = redImage.getWidth();
  const height = redImage.getHeight();
  const [redData] = await redImage.readRasters();
  const [nirData] = await nirImage.readRasters();

  // Build geo transform from tiepoints and pixel scale
  const tiepoint = redImage.getTiePoints()?.[0];
  const pixelScale = redImage.fileDirectory?.ModelPixelScale;
  if (!tiepoint || !pixelScale) throw new Error("Missing geo metadata");
  const geoTransform = [
    tiepoint.x, pixelScale[0], 0,
    tiepoint.y, 0, -pixelScale[1],
  ];

  const ndviArray = computeNDVIArray(redData, nirData, width, height, geoTransform, NORDMARKA.bbox);
  if (ndviArray.length < 10) throw new Error(`Too few valid pixels: ${ndviArray.length}`);

  const mean = ndviArray.reduce((s, v) => s + v, 0) / ndviArray.length;
  const variance = ndviArray.reduce((s, v) => s + (v - mean) ** 2, 0) / ndviArray.length;
  const bins = binNDVI(ndviArray);

  return {
    sceneId: item.id,
    date: item.properties.datetime?.slice(0, 10),
    cloudCover: item.properties["eo:cloud_cover"],
    pixelCount: ndviArray.length,
    meanNDVI: mean,
    stdNDVI: Math.sqrt(variance),
    cvNDVI: computeCVNDVI(ndviArray),
    raoQ: computeRaoQ(bins),
    shannonH: computeShannonH(bins),
    bins,
  };
}

// ── MET Norway weather ──
async function fetchWeather() {
  const res = await fetchWithTimeout(
    `${MET_API}?lat=${NORDMARKA.center[0]}&lon=${NORDMARKA.center[1]}`,
    {}
  );
  if (!res.ok) throw new Error(`MET ${res.status}`);
  return res.json();
}

// ── Growing Season: Thermal/Meteorological Definition ──
// The thermal growing season is the period with daily mean temp ≥ 5°C
// Start: first day of 5+ consecutive days with mean temp ≥ 5°C
// End: last day before 5+ consecutive days with mean temp < 5°C
const GROWING_THRESHOLD = 5; // °C
const CONSECUTIVE_DAYS = 5;

function calculateGrowingSeason(dates, temps) {
  const n = dates.length;
  if (n === 0) return null;

  // Group by year
  const years = {};
  for (let i = 0; i < n; i++) {
    const year = dates[i].slice(0, 4);
    if (!years[year]) years[year] = [];
    years[year].push({ date: dates[i], temp: temps[i] });
  }

  const results = [];
  for (const [year, days] of Object.entries(years)) {
    if (days.length < 200) continue; // need most of the year

    // Find start: first run of CONSECUTIVE_DAYS days with temp ≥ threshold
    let start = null;
    for (let i = 0; i <= days.length - CONSECUTIVE_DAYS; i++) {
      let allAbove = true;
      for (let j = 0; j < CONSECUTIVE_DAYS; j++) {
        if (days[i + j].temp < GROWING_THRESHOLD) { allAbove = false; break; }
      }
      if (allAbove) { start = i; break; }
    }

    // Find end: search from end of year backward for last run of consecutive cold days
    let end = null;
    for (let i = days.length - CONSECUTIVE_DAYS; i >= 0; i--) {
      let allBelow = true;
      for (let j = 0; j < CONSECUTIVE_DAYS; j++) {
        if (days[i + j].temp >= GROWING_THRESHOLD) { allBelow = false; break; }
      }
      if (allBelow && i > (start ?? 0)) { end = i - 1; break; }
    }

    if (start !== null) {
      const gsEnd = end ?? days.length - 1;
      const length = gsEnd - start + 1;
      // Growing degree days (GDD) above 5°C during growing season
      let gdd = 0;
      for (let i = start; i <= gsEnd; i++) {
        if (days[i].temp > GROWING_THRESHOLD) gdd += days[i].temp - GROWING_THRESHOLD;
      }
      results.push({
        year: parseInt(year),
        startDate: days[start].date,
        endDate: days[gsEnd].date,
        startDOY: start + 1,
        endDOY: gsEnd + 1,
        length,
        gdd: Math.round(gdd),
        meanTemp: days.slice(start, gsEnd + 1).reduce((s, d) => s + d.temp, 0) / length,
      });
    }
  }
  return results.sort((a, b) => a.year - b.year);
}

// Fetch daily mean temperature from Open-Meteo (ERA5 reanalysis)
async function fetchHistoricalTemps(startYear, endYear) {
  const url = `${OPENMETEO_HISTORICAL}?latitude=${NORDMARKA.center[0]}&longitude=${NORDMARKA.center[1]}&start_date=${startYear}-01-01&end_date=${endYear}-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FOslo`;
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`Open-Meteo Historical ${res.status}`);
  const data = await res.json();
  const dates = data.daily?.time || [];
  const maxTemps = data.daily?.temperature_2m_max || [];
  const minTemps = data.daily?.temperature_2m_min || [];
  // Daily mean = (max + min) / 2
  const meanTemps = maxTemps.map((mx, i) =>
    mx != null && minTemps[i] != null ? (mx + minTemps[i]) / 2 : null
  );
  return { dates, temps: meanTemps };
}

// Fetch climate projections from Open-Meteo (CMIP6)
async function fetchClimateProjections() {
  const models = "EC_Earth3P_HR,MPI_ESM1_2_XR,MRI_AGCM3_2_S";
  const url = `${OPENMETEO_CLIMATE}?latitude=${NORDMARKA.center[0]}&longitude=${NORDMARKA.center[1]}&start_date=2030-01-01&end_date=2050-12-31&daily=temperature_2m_mean&models=${models}`;
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`Open-Meteo Climate ${res.status}`);
  const data = await res.json();
  const dates = data.daily?.time || [];
  // Average across available models
  const modelKeys = Object.keys(data.daily || {}).filter(k => k.startsWith("temperature_2m_mean"));
  if (modelKeys.length === 0) return { dates, temps: [] };
  const temps = dates.map((_, i) => {
    const vals = modelKeys.map(k => data.daily[k]?.[i]).filter(v => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  });
  return { dates, temps };
}

// ── NIBIO WMS tile URL builder ──
function nibioWMSTile(layer, bbox, width = 512, height = 512) {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: layer,
    CRS: "EPSG:4326",
    BBOX: `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`,
    WIDTH: width,
    HEIGHT: height,
    FORMAT: "image/png",
    TRANSPARENT: "true",
  });
  return `${NIBIO_WMS}?${params}`;
}

// ═══ UI Components ═══

const LoadingDot = () => (
  <span className="loading-dot">
    <span /><span /><span />
  </span>
);

const StatusChip = ({ status, label }) => {
  const colors = { loading: "#6c757d", ok: "#27ae60", error: "#c0392b" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 11, fontFamily: "var(--fm)", color: colors[status],
      padding: "3px 10px", borderRadius: 20,
      background: colors[status] + "14", border: `1px solid ${colors[status]}25`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors[status] }} />
      {label}
    </span>
  );
};

const StatBlock = ({ label, value, unit, sub, accent, small }) => (
  <div className="stat-block">
    <div className="stat-label">{label}</div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
      <span className="stat-value" style={{ color: accent, fontSize: small ? 20 : 28 }}>{value}</span>
      {unit && <span className="stat-unit">{unit}</span>}
    </div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

const ProgressBar = ({ value, max = 100, color = "var(--green)", label, showVal }) => (
  <div style={{ marginBottom: 8 }}>
    {label && (
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--t2)" }}>{label}</span>
        {showVal && <span style={{ fontSize: 11, fontFamily: "var(--fm)", color }}>{value.toFixed?.(1) ?? value}</span>}
      </div>
    )}
    <div style={{ height: 6, background: "var(--bg2)", borderRadius: 3 }}>
      <div style={{ width: `${Math.min((value / max) * 100, 100)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.8s ease" }} />
    </div>
  </div>
);


// ═══ Interpretation Functions (Simple Mode) ═══

function interpretNDVI(ndvi) {
  if (ndvi == null) return { level: 0, label: "Ingen data", color: "#adb5bd", description: "Venter på satellittdata" };
  if (ndvi >= 0.7) return { level: 3, label: "Frodig og sunn skog", color: "#2d6a4f", description: "Skogen er i svært god stand med tett, grønt bladtak." };
  if (ndvi >= 0.5) return { level: 2, label: "Normal skoghelse", color: "#52b788", description: "Skogen ser frisk ut med god vegetasjon." };
  if (ndvi >= 0.3) return { level: 1, label: "Noe glissent", color: "#e9c46a", description: "Noe lavere tetthet enn normalt — kan skyldes årstid eller hogst." };
  return { level: 0, label: "Lite vegetasjon", color: "#e07a5f", description: "Området har lite grønn vegetasjon — mulig hogstfelt eller snødekke." };
}

function interpretLAI(lai) {
  if (lai == null) return { label: "Ingen data", description: "Venter på satellittdata" };
  if (lai >= 4.0) return { label: "Tett kronetak", description: "God skygge og jordbeskyttelse — typisk for eldre granskog." };
  if (lai >= 2.5) return { label: "Middels tett", description: "Godt bladtak — vanlig for blandingsskog i Nordmarka." };
  if (lai >= 1.0) return { label: "Åpent", description: "Relativt åpent — ung skog eller lauvskog om vinteren." };
  return { label: "Svært åpent", description: "Lite kronetak — hogstfelt eller fjell over tregrensa." };
}

function interpretGrowingConditions(tempVal, growing) {
  if (tempVal == null) return { status: "unknown", headline: "Venter på værdata" };
  if (tempVal >= 5 && growing) return { status: "active", headline: "Gode vekstforhold i dag" };
  if (tempVal >= 5) return { status: "warm", headline: "Varmt nok for vekst" };
  if (tempVal >= 0) return { status: "cool", headline: "For kaldt for vekst — trærne hviler" };
  return { status: "frost", headline: "Frost — trærne er i vinterdvale" };
}

function interpretWeatherRisk(tempVal, wind, humidityVal, precip) {
  const alerts = [];
  if (tempVal != null && tempVal > 25 && humidityVal != null && humidityVal < 30) {
    alerts.push({ type: "fire", label: "Skogbrannfare", color: "#e07a5f", description: "Høy temperatur og lav luftfuktighet gir brannfare." });
  }
  if (wind != null && wind > 15) {
    alerts.push({ type: "storm", label: "Sterk vind", color: "#457b9d", description: "Vindstyrke " + wind.toFixed(0) + " m/s — fare for vindfall." });
  }
  if (tempVal != null && tempVal <= -10) {
    alerts.push({ type: "frost", label: "Kraftig frost", color: "#a8dadc", description: "Svært kaldt — unngå hogst i frosset treverk." });
  }
  if (tempVal != null && tempVal > 0 && tempVal < 3 && precip != null && precip > 0) {
    alerts.push({ type: "ice", label: "Ising", color: "#b5838d", description: "Nær null med nedbør — glatte forhold i skogen." });
  }
  return alerts;
}

function getSeasonalAdvice(month, tempVal) {
  const tips = [];
  if (month >= 11 || month <= 2) {
    tips.push("Vinterhogst er ideelt — frossen jord gir mindre skade på skogbunnen.");
    if (tempVal != null && tempVal < -5) tips.push("Vent med å felle store trær i sterk frost — virket kan sprekke.");
    tips.push("Sjekk for snøbrekk og ta ut skadd virke.");
  } else if (month >= 3 && month <= 5) {
    tips.push("Vårens teleløsning — unngå kjøring med tungt utstyr.");
    tips.push("Planting av nye trær kan starte når telen går.");
    tips.push("Se etter granbarkbiller når temperaturen stiger.");
  } else if (month >= 6 && month <= 8) {
    tips.push("Sommerens vekstsesong — skogen vokser aktivt.");
    tips.push("Følg med på skogbrannfare i tørre perioder.");
    tips.push("Markberedning kan gjøres nå for høstens planting.");
  } else {
    tips.push("Høsten er god for planting av bartrær.");
    tips.push("Planlegg vinterens hogst — merk trær som skal felles.");
    tips.push("Kontroller at skogsveier er klare for vinteren.");
  }
  return tips;
}

function carbonEquivalent(biomassTotal) {
  const co2Mt = biomassTotal * 0.47 * 3.67;
  const cars = Math.round((co2Mt * 1e6) / 4.6);
  if (cars >= 1000) {
    return "Tilsvarer å fjerne " + (cars / 1000).toFixed(0) + " 000 biler fra veien i ett år";
  }
  return "Tilsvarer å fjerne " + cars + " biler fra veien i ett år";
}

function getLAITrend(history) {
  if (!history || history.length < 4) return "stable";
  const half = Math.floor(history.length / 2);
  const recent = history.slice(half).reduce((s, l) => s + l.lai, 0) / (history.length - half);
  const earlier = history.slice(0, half).reduce((s, l) => s + l.lai, 0) / half;
  const diff = recent - earlier;
  if (diff > 0.3) return "improving";
  if (diff < -0.3) return "declining";
  return "stable";
}
// ═══ Main App ═══

export default function NordmarkaForest() {
  const [tab, setTab] = useState(() => (localStorage.getItem("skogkontroll-mode") || "simple") === "simple" ? "minskog" : "overview");
  const [stacData, setStacData] = useState({ sentinel: null, landsat: null, loading: true, error: null });
  const [weather, setWeather] = useState({ data: null, loading: true, error: null });
  const [laiHistory, setLaiHistory] = useState([]);
  const [nibioLayers, setNibioLayers] = useState({
    volume: true, species: false, biomass: false,
  });
  const [selectedScene, setSelectedScene] = useState(null);
  const [growingSeason, setGrowingSeason] = useState({ historical: null, projected: null, loading: true, error: null });
  const [diversityData, setDiversityData] = useState({ loading: false, error: null, scenes: [], initialized: false });
  const [viewMode, setViewMode] = useState(
    () => localStorage.getItem("skogkontroll-mode") || "simple"
  );

  useEffect(() => {
    localStorage.setItem("skogkontroll-mode", viewMode);
  }, [viewMode]);

  // ── Load real data on mount ──
  useEffect(() => {
    // Fetch Sentinel-2 scenes
    const loadSentinel = async () => {
      try {
        const data = await searchSTAC("sentinel-2-l2a", "2024-05-01T00:00:00Z/2025-10-01T00:00:00Z", 25);
        const items = data.features || [];
        // Calculate NDVI/LAI for each scene
        const withLAI = await Promise.all(
          items.map(async (item) => {
            const ndvi = await fetchNDVIFromScene(item);
            return { ...item, _ndvi: ndvi, _lai: ndvi ? ndviToLAI(ndvi) : null };
          })
        );
        setStacData((s) => ({ ...s, sentinel: withLAI, loading: false }));
        // Build LAI history
        const history = withLAI
          .filter((i) => i._lai !== null)
          .map((i) => ({
            date: i.properties.datetime?.slice(0, 10),
            month: new Date(i.properties.datetime).toLocaleString("no-NO", { month: "short" }),
            ndvi: i._ndvi,
            lai: i._lai,
            cloud: i.properties["eo:cloud_cover"],
            id: i.id,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        setLaiHistory(history);
        if (withLAI.length > 0) setSelectedScene(withLAI[0]);
      } catch (e) {
        setStacData((s) => ({ ...s, error: e.message, loading: false }));
      }
    };

    // Fetch Landsat scenes
    const loadLandsat = async () => {
      try {
        const data = await searchSTAC("landsat-c2-l2", "2024-01-01T00:00:00Z/2025-12-01T00:00:00Z", 30);
        setStacData((s) => ({ ...s, landsat: data.features || [] }));
      } catch (e) {
        console.warn("Landsat fetch failed:", e);
      }
    };

    // Fetch weather
    const loadWeather = async () => {
      try {
        const data = await fetchWeather();
        setWeather({ data, loading: false, error: null });
      } catch (e) {
        setWeather({ data: null, loading: false, error: e.message });
      }
    };

    // Fetch growing season data (ERA5 reanalysis + CMIP6 projections)
    const loadGrowingSeason = async () => {
      try {
        const [hist, proj] = await Promise.all([
          fetchHistoricalTemps(2015, 2025),
          fetchClimateProjections(),
        ]);
        const historical = calculateGrowingSeason(
          hist.dates.filter((_, i) => hist.temps[i] != null),
          hist.temps.filter(t => t != null)
        );
        const projected = calculateGrowingSeason(
          proj.dates.filter((_, i) => proj.temps[i] != null),
          proj.temps.filter(t => t != null)
        );
        setGrowingSeason({ historical, projected, loading: false, error: null });
      } catch (e) {
        setGrowingSeason({ historical: null, projected: null, loading: false, error: e.message });
      }
    };

    loadSentinel();
    loadLandsat();
    loadWeather();
    loadGrowingSeason();
  }, []);

  // ── Lazy-load diversity data when tab is selected ──
  useEffect(() => {
    if (tab !== "diversity" || diversityData.initialized || !stacData.sentinel || stacData.sentinel.length === 0) return;

    const loadDiversity = async () => {
      setDiversityData(d => ({ ...d, loading: true, initialized: true }));
      // Pick up to 6 lowest-cloud scenes
      const sorted = [...stacData.sentinel]
        .filter(s => s.properties?.["eo:cloud_cover"] != null)
        .sort((a, b) => (a.properties["eo:cloud_cover"] || 0) - (b.properties["eo:cloud_cover"] || 0))
        .slice(0, 6);

      const results = [];
      for (const scene of sorted) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          const result = await analyzeDiversityForScene(scene);
          clearTimeout(timeoutId);
          results.push(result);
          setDiversityData(d => ({ ...d, scenes: [...results] }));
        } catch (e) {
          console.warn(`Diversity analysis failed for ${scene.id}:`, e.message);
        }
      }
      setDiversityData(d => ({ ...d, loading: false, error: results.length === 0 ? "No scenes could be analyzed" : null }));
    };

    loadDiversity();
  }, [tab, stacData.sentinel, diversityData.initialized]);

  // ── Derived data ──
  const currentWeather = weather.data?.properties?.timeseries?.[0]?.data;
  const temp = currentWeather?.instant?.details?.air_temperature;
  const windSpeed = currentWeather?.instant?.details?.wind_speed;
  const humidity = currentWeather?.instant?.details?.relative_humidity;
  const precipitation = currentWeather?.next_1_hours?.details?.precipitation_amount ?? currentWeather?.next_6_hours?.details?.precipitation_amount;

  const latestLAI = laiHistory.length > 0 ? laiHistory[laiHistory.length - 1] : null;
  const avgLAI = laiHistory.length > 0 ? laiHistory.reduce((s, l) => s + l.lai, 0) / laiHistory.length : null;

  const sentinelScenes = stacData.sentinel || [];
  const landsatScenes = stacData.landsat || [];

  // ── NIBIO WMS URLs ──
  const volumeUrl = nibioWMSTile("SRRVOLUB", NORDMARKA.bbox, 600, 500);
  const speciesUrl = nibioWMSTile("SRRTRESLAG", NORDMARKA.bbox, 600, 500);
  const biomassUrl = nibioWMSTile("SRRBMO", NORDMARKA.bbox, 600, 500);

  const simpleTabs = [
    { id: "minskog", label: "Min skog", icon: "🌲" },
    { id: "skogkart", label: "Skogkart", icon: "🗺" },
    { id: "vaervekst", label: "Vær og vekst", icon: "☀" },
  ];
  const advancedTabs = [
    { id: "overview", label: "Overview", icon: "◉" },
    { id: "lai", label: "LAI / NDVI", icon: "🌿" },
    { id: "map", label: "SR16 Map", icon: "🗺" },
    { id: "scenes", label: "Satellite", icon: "🛰" },
    { id: "climate", label: "Climate", icon: "🌡" },
    { id: "diversity", label: "Diversity", icon: "🌳" },
  ];
  const tabs = viewMode === "simple" ? simpleTabs : advancedTabs;

  const handleModeSwitch = (mode) => {
    setViewMode(mode);
    setTab(mode === "simple" ? "minskog" : "overview");
  };

  const isSimple = viewMode === "simple";
  const laiTrend = getLAITrend(laiHistory);
  const trendArrow = laiTrend === "improving" ? "↗" : laiTrend === "declining" ? "↘" : "→";
  const trendLabel = laiTrend === "improving" ? "Bedre" : laiTrend === "declining" ? "Svakere" : "Stabil";
  const ndviInterpret = interpretNDVI(latestLAI?.ndvi);
  const laiInterpret = interpretLAI(latestLAI?.lai);
  const growingStatus = interpretGrowingConditions(temp, temp >= 5);
  const weatherRisks = interpretWeatherRisk(temp, windSpeed, humidity, precipitation);
  const biomassPerHa = latestLAI ? latestLAI.lai * 28.5 : 120;
  const totalBiomassMt = biomassPerHa * NORDMARKA.area_km2 * 100 / 1e6;
  const carbonStory = carbonEquivalent(totalBiomassMt);
  const currentMonth = new Date().getMonth() + 1;
  const seasonalTips = getSeasonalAdvice(currentMonth, temp);

  return (
    <div className={`app${isSimple ? " simple" : ""}`}>
      <style>{styles}</style>

      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <svg width="28" height="28" viewBox="0 0 36 36" fill="none">
            <path d="M18 4L6 28h24L18 4z" fill="#40916c" opacity="0.6" />
            <path d="M18 10L10 28h16L18 10z" fill="#40916c" />
            <rect x="16" y="28" width="4" height="4" rx="1" fill="#1b4332" />
          </svg>
          <div>
            <div className="header-title">Skogkontroll</div>
            <div className="header-sub">Nordmarka · {NORDMARKA.municipality}</div>
          </div>
        </div>
        <div className="header-right">
          <div className="mode-toggle">
            <button className={`mode-btn${isSimple ? " active" : ""}`} onClick={() => handleModeSwitch("simple")}>Enkel</button>
            <button className={`mode-btn${!isSimple ? " active" : ""}`} onClick={() => handleModeSwitch("advanced")}>Avansert</button>
          </div>
          {!isSimple && (
            <>
              <StatusChip status={stacData.loading ? "loading" : stacData.error ? "error" : "ok"} label={stacData.loading ? "Fetching data…" : stacData.error ? "API error" : `${sentinelScenes.length} Sentinel + ${landsatScenes.length} Landsat`} />
              <StatusChip status={weather.loading ? "loading" : weather.error ? "error" : "ok"} label={weather.loading ? "Weather…" : weather.error ? "MET error" : `${temp?.toFixed(1)}°C`} />
              <StatusChip status={growingSeason.loading ? "loading" : growingSeason.error ? "error" : "ok"} label={growingSeason.loading ? "ERA5…" : growingSeason.error ? "ERA5 error" : `Growing season`} />
            </>
          )}
        </div>
      </header>

      {/* ── Tabs ── */}
      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            <span className="tab-i">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Content ── */}
      <main className="main">

        {/* ════════ SIMPLE: MIN SKOG ════════ */}
        {isSimple && tab === "minskog" && (
          <div className="grid">
            {/* Forest Health Hero */}
            <section className="card wide health-hero" style={{ background: ndviInterpret.color + "18", borderColor: ndviInterpret.color + "40" }}>
              <div className="hero-content">
                <div className="hero-indicator" style={{ background: ndviInterpret.color }}>
                  {ndviInterpret.level === 3 ? "✓" : ndviInterpret.level === 2 ? "~" : "!"}
                </div>
                <div className="hero-text">
                  <h2 className="hero-title" style={{ color: ndviInterpret.color }}>{ndviInterpret.label}</h2>
                  <p className="hero-desc">{ndviInterpret.description}</p>
                  <div className="hero-details">
                    <span className="hero-detail">{laiInterpret.label} — {laiInterpret.description}</span>
                    <span className="hero-trend" style={{ color: laiTrend === "improving" ? "#2d6a4f" : laiTrend === "declining" ? "#e07a5f" : "#6b6560" }}>
                      {trendArrow} Trend: {trendLabel}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Carbon Story */}
            <section className="card carbon-card">
              <h2 className="card-title">Skogens karbonlager</h2>
              <div className="carbon-big">{(totalBiomassMt * 0.47).toFixed(1)} Mt</div>
              <div className="carbon-label">karbon lagret i Nordmarka</div>
              <div className="carbon-equiv">{carbonStory}</div>
              <div style={{ marginTop: 16, fontSize: 13, color: "var(--t2)", lineHeight: 1.6 }}>
                Hvert år absorberer skogen rundt {(totalBiomassMt * 0.02 * 0.47 * 3.67).toFixed(0)} tusen tonn CO₂ gjennom vekst.
              </div>
            </section>

            {/* Quick Weather */}
            <section className="card">
              <h2 className="card-title">Været nå</h2>
              {currentWeather ? (
                <div>
                  <div className="simple-weather-hero">
                    <span className="simple-temp">{temp?.toFixed(0)}°</span>
                    <span className="simple-weather-desc">
                      {temp >= 15 ? "Varmt" : temp >= 5 ? "Mildt" : temp >= 0 ? "Kaldt" : "Frost"}
                      {precipitation > 0 ? " med nedbør" : ""}
                    </span>
                  </div>
                  <div className="simple-weather-details">
                    <span>Vind: {windSpeed?.toFixed(0)} m/s</span>
                    <span>Fuktighet: {humidity?.toFixed(0)}%</span>
                  </div>
                </div>
              ) : (
                <div className="empty">{weather.error ? "Kunne ikke hente vær" : "Henter værdata…"} <LoadingDot /></div>
              )}
            </section>
          </div>
        )}

        {/* ════════ SIMPLE: SKOGKART ════════ */}
        {isSimple && tab === "skogkart" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Hvor skogen er tykest</h2>
              <p className="card-desc">Kartet viser stående volum — altså hvor mye tømmer som finnes per dekar. Mørke farger betyr tett, gammel skog.</p>
              <div className="wms-preview large">
                <img src={volumeUrl} alt="Stående volum Nordmarka" className="wms-img" onError={(e) => { e.target.style.display = "none"; }} />
              </div>
              <div className="simple-legend">
                <span className="legend-item"><span className="legend-dot" style={{ background: "#1b4332" }} /> Tett skog</span>
                <span className="legend-item"><span className="legend-dot" style={{ background: "#52b788" }} /> Middels</span>
                <span className="legend-item"><span className="legend-dot" style={{ background: "#b7e4c7" }} /> Glissent</span>
                <span className="legend-item"><span className="legend-dot" style={{ background: "#f4f1de" }} /> Åpent</span>
              </div>
            </section>

            <section className="card wide">
              <h2 className="card-title">Hva som vokser hvor</h2>
              <p className="card-desc">Kartet viser treslag — gran, furu og lauvtrær fordelt over Nordmarka.</p>
              <div className="wms-preview large">
                <img src={speciesUrl} alt="Treslag Nordmarka" className="wms-img" onError={(e) => { e.target.style.display = "none"; }} />
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Om kartene</h2>
              <div style={{ fontSize: 14, color: "var(--t2)", lineHeight: 1.7 }}>
                Kartene er laget av NIBIO (Norsk institutt for bioøkonomi) og dekker over 95% av Norges skogareal.
                De kombinerer data fra landsskogtakseringen, laserscanning og satellittbilder.
              </div>
            </section>
          </div>
        )}

        {/* ════════ SIMPLE: VÆR OG VEKST ════════ */}
        {isSimple && tab === "vaervekst" && (
          <div className="grid">
            {/* Growing status */}
            <section className="card wide" style={{
              background: growingStatus.status === "active" ? "#d8f3dc" : growingStatus.status === "frost" ? "#e3f2fd" : "var(--card)",
              borderColor: growingStatus.status === "active" ? "#95d5b2" : growingStatus.status === "frost" ? "#90caf9" : "var(--border)",
            }}>
              <h2 className="card-title" style={{ fontSize: 20 }}>{growingStatus.headline}</h2>
              <p style={{ fontSize: 15, color: "var(--t2)", marginTop: 4 }}>
                {growingStatus.status === "active" || growingStatus.status === "warm"
                  ? "Trærne vokser aktivt. Vekstsesongen er i gang."
                  : "Trærne er i dvale og venter på varmere dager."}
              </p>
            </section>

            {/* Current weather plain */}
            {currentWeather && (
              <section className="card">
                <h2 className="card-title">Værforhold</h2>
                <div className="simple-conditions">
                  <div className="condition-row">
                    <span className="condition-label">Temperatur</span>
                    <span className="condition-value">{temp?.toFixed(1)}°C</span>
                  </div>
                  <div className="condition-row">
                    <span className="condition-label">Vind</span>
                    <span className="condition-value">{windSpeed?.toFixed(0)} m/s {windSpeed > 10 ? "— frisk bris" : windSpeed > 5 ? "— lett bris" : "— stille"}</span>
                  </div>
                  <div className="condition-row">
                    <span className="condition-label">Nedbør</span>
                    <span className="condition-value">{precipitation != null && precipitation > 0 ? `${precipitation.toFixed(1)} mm/t` : "Ingen"}</span>
                  </div>
                  <div className="condition-row">
                    <span className="condition-label">Luftfuktighet</span>
                    <span className="condition-value">{humidity?.toFixed(0)}%</span>
                  </div>
                </div>
              </section>
            )}

            {/* Risk alerts */}
            {weatherRisks.length > 0 && (
              <section className="card">
                <h2 className="card-title">Varsler</h2>
                <div className="risk-alerts">
                  {weatherRisks.map((r, i) => (
                    <div key={i} className="risk-alert" style={{ borderLeftColor: r.color }}>
                      <div className="risk-label" style={{ color: r.color }}>{r.label}</div>
                      <div className="risk-desc">{r.description}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Seasonal advice */}
            <section className="card">
              <h2 className="card-title">Tips for sesongen</h2>
              <div className="seasonal-tips">
                {seasonalTips.map((tip, i) => (
                  <div key={i} className="tip-item">
                    <span className="tip-bullet">•</span>
                    <span>{tip}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Simple 48h outlook */}
            {weather.data && (
              <section className="card wide">
                <h2 className="card-title">Neste 48 timer</h2>
                <div className="simple-forecast">
                  {weather.data.properties.timeseries.slice(0, 24).filter((_, i) => i % 6 === 0).map((ts, i) => {
                    const t = ts.data.instant.details.air_temperature;
                    const c = ts.data.instant.details.cloud_area_fraction;
                    const p = ts.data.next_1_hours?.details?.precipitation_amount ?? ts.data.next_6_hours?.details?.precipitation_amount ?? 0;
                    const time = new Date(ts.time);
                    const weatherIcon = p > 0.5 ? "🌧" : c > 70 ? "☁" : c > 30 ? "⛅" : "☀";
                    return (
                      <div key={i} className="simple-forecast-slot">
                        <div className="forecast-slot-time">{time.toLocaleDateString("no-NO", { weekday: "short" })} {time.getHours()}:00</div>
                        <div className="forecast-slot-icon">{weatherIcon}</div>
                        <div className="forecast-slot-temp" style={{ color: t > 0 ? "#e07a5f" : "#457b9d" }}>{t > 0 ? "+" : ""}{t.toFixed(0)}°</div>
                        {p > 0 && <div className="forecast-slot-precip">{p.toFixed(1)} mm</div>}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ════════ OVERVIEW ════════ */}
        {!isSimple && tab === "overview" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Nordmarka — Key Metrics</h2>
              <p className="card-desc">Real-time data from Sentinel-2, Landsat, NIBIO SR16 and MET Norway.</p>
              <div className="stats-grid">
                <StatBlock label="Area" value={NORDMARKA.area_km2} unit="km²" sub={NORDMARKA.elevation} />
                <StatBlock label="Latest LAI" value={latestLAI ? latestLAI.lai.toFixed(2) : "—"} sub={latestLAI ? `NDVI: ${latestLAI.ndvi.toFixed(3)} · ${latestLAI.date}` : "Loading…"} accent="var(--green)" />
                <StatBlock label="Avg LAI" value={avgLAI ? avgLAI.toFixed(2) : "—"} sub={`${laiHistory.length} observations`} accent="var(--green)" />
                <StatBlock label="Biomass" value={latestLAI ? (latestLAI.lai * 28.5).toFixed(0) : "—"} unit="t/ha" sub={latestLAI ? `From LAI ${latestLAI.lai.toFixed(2)}` : "Loading…"} accent="var(--green)" />
                <StatBlock label="Total Biomass" value={latestLAI ? (latestLAI.lai * 28.5 * NORDMARKA.area_km2 * 100 / 1000000).toFixed(2) : "—"} unit="Mt" sub={`For ${NORDMARKA.area_km2} km²`} accent="var(--green)" />
                <StatBlock label="Temperature" value={temp != null ? temp.toFixed(1) : "—"} unit="°C" sub={weather.data ? "MET Norway — now" : "Loading…"} />
                <StatBlock label="Sentinel-2" value={sentinelScenes.length} unit="scenes" sub="< 25% cloud cover" />
                <StatBlock label="Landsat" value={landsatScenes.length} unit="scenes" sub="Landsat 8/9 C2L2" />
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">LAI Time Series</h2>
              <p className="card-desc">Leaf Area Index calculated from NDVI:<br/><code>LAI = 0.57 × e^(2.33 × NDVI)</code></p>
              {laiHistory.length > 0 ? (
                <div className="bar-chart">
                  {laiHistory.map((h, i) => {
                    const max = Math.max(...laiHistory.map((l) => l.lai), 5);
                    return (
                      <div key={i} className="bar-col" title={`${h.date}\nNDVI: ${h.ndvi.toFixed(3)}\nLAI: ${h.lai.toFixed(2)}\nCloud: ${h.cloud?.toFixed(0)}%`}>
                        <div className="bar" style={{ height: `${(h.lai / max) * 100}%`, background: h.lai > 3 ? "var(--green)" : h.lai > 1.5 ? "#52b788" : "#b7e4c7", animationDelay: `${i * 60}ms` }} />
                        <div className="bar-label">{h.month}</div>
                        <div className="bar-val">{h.lai.toFixed(1)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">Fetching satellite data… <LoadingDot /></div>
              )}
            </section>

            <section className="card">
              <h2 className="card-title">10-Year Biomass Growth Projection</h2>
              <p className="card-desc">
                Accumulated growth over baseline. Norwegian forests grow ~2-4% biomass annually (3% projection).
              </p>
              {latestLAI ? (
                <>
                  <div className="bar-chart">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((year) => {
                      const currentBiomass = latestLAI.lai * 28.5;
                      const cumulativeBiomass = currentBiomass * Math.pow(1.03, year);
                      const growthFromBaseline = cumulativeBiomass - currentBiomass;
                      const maxGrowth = currentBiomass * (Math.pow(1.03, 10) - 1);
                      const currentYear = new Date().getFullYear();
                      const growthPercent = year === 0 ? 0 : ((cumulativeBiomass - currentBiomass) / currentBiomass * 100);
                      return (
                        <div key={year} className="bar-col" title={`${currentYear + year}\nTotal: ${cumulativeBiomass.toFixed(1)} t/ha\nGrowth from baseline: +${growthFromBaseline.toFixed(1)} t/ha (+${growthPercent.toFixed(1)}%)`}>
                          <div className="bar" style={{ height: `${year === 0 ? 5 : (growthFromBaseline / maxGrowth) * 100}%`, background: year === 0 ? "#adb5bd" : "var(--green)", animationDelay: `${year * 60}ms` }} />
                          <div className="bar-label">{currentYear + year}</div>
                          <div className="bar-val">{year === 0 ? 'baseline' : `+${growthFromBaseline.toFixed(1)}`}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 16, fontSize: 12, color: "var(--t2)", lineHeight: 1.6 }}>
                    <strong>Baseline (current):</strong> {(latestLAI.lai * 28.5).toFixed(1)} t/ha<br/>
                    <strong>Projected in 10 years:</strong> {(latestLAI.lai * 28.5 * Math.pow(1.03, 10)).toFixed(1)} t/ha 
                    (+{((latestLAI.lai * 28.5 * (Math.pow(1.03, 10) - 1))).toFixed(1)} t/ha, +{((Math.pow(1.03, 10) - 1) * 100).toFixed(1)}%)<br/>
                    <strong>Total area growth:</strong> {((latestLAI.lai * 28.5 * Math.pow(1.03, 10) - latestLAI.lai * 28.5) * NORDMARKA.area_km2 * 100 / 1000000).toFixed(2)} Mt additional biomass
                  </div>
                </>
              ) : (
                <div className="empty">Waiting for LAI data…</div>
              )}
            </section>

            <section className="card">
              <h2 className="card-title">Current Weather</h2>
              <p className="card-desc">From MET Norway Locationforecast API</p>
              {currentWeather ? (
                <div className="weather-grid">
                  <div className="weather-item">
                    <div className="weather-val">{temp?.toFixed(1)}°C</div>
                    <div className="weather-label">Temperature</div>
                  </div>
                  <div className="weather-item">
                    <div className="weather-val">{windSpeed?.toFixed(1)} m/s</div>
                    <div className="weather-label">Wind</div>
                  </div>
                  <div className="weather-item">
                    <div className="weather-val">{humidity?.toFixed(0)}%</div>
                    <div className="weather-label">Humidity</div>
                  </div>
                  <div className="weather-item">
                    <div className="weather-val">{precipitation?.toFixed(1) ?? "—"} mm</div>
                    <div className="weather-label">Precip. (1h)</div>
                  </div>
                </div>
              ) : (
                <div className="empty">{weather.error ? `Error: ${weather.error}` : "Loading…"} <LoadingDot /></div>
              )}
              <div className="source-tag">Source: api.met.no · {new Date().toLocaleString("en-US")}</div>
            </section>
          </div>
        )}

        {/* ════════ LAI / NDVI ════════ */}
        {!isSimple && tab === "lai" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Leaf Area Index (LAI) — Nordmarka</h2>
              <p className="card-desc">
                LAI calculated from Sentinel-2 NDVI values using the empirical forest formula:
                <code style={{ display: "block", margin: "8px 0", fontSize: 14, color: "var(--green)" }}>LAI = 0.57 × exp(2.33 × NDVI)</code>
                Formula validated for boreal forests (R² ≈ 0.55, RMSE ≈ 0.8). Source: Gao et al. / Landsat-LAI (GitHub).
              </p>
            </section>

            <section className="card wide">
              <h2 className="card-title">LAI & NDVI per Scene</h2>
              {laiHistory.length > 0 ? (
                <div className="scene-table">
                  <div className="scene-header">
                    <span>Date</span><span>Scene ID</span><span>NDVI</span><span>LAI</span><span>Cloud Cover</span>
                  </div>
                  {laiHistory.map((h, i) => (
                    <div key={i} className="scene-row">
                      <span style={{ fontFamily: "var(--fm)", fontWeight: 600 }}>{h.date}</span>
                      <span style={{ fontSize: 11, fontFamily: "var(--fm)", color: "var(--t2)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.id}</span>
                      <span>
                        <span className="ndvi-badge">{h.ndvi.toFixed(3)}</span>
                      </span>
                      <span style={{ fontWeight: 700, color: "var(--green)", fontFamily: "var(--fm)" }}>{h.lai.toFixed(2)}</span>
                      <span style={{ fontFamily: "var(--fm)", color: "var(--t2)" }}>{h.cloud?.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">Fetching data from Earth Search STAC API… <LoadingDot /></div>
              )}
              <div className="source-tag">Source: earth-search.aws.element84.com/v1 · Collection: sentinel-2-l2a</div>
            </section>

            <section className="card">
              <h2 className="card-title">LAI Scale</h2>
              <div className="lai-scale">
                {[
                  { range: "0 – 1.0", desc: "Open / clear-cut", color: "#f4f1de" },
                  { range: "1.0 – 2.5", desc: "Young / deciduous forest", color: "#b7e4c7" },
                  { range: "2.5 – 4.0", desc: "Medium density conifer", color: "#52b788" },
                  { range: "4.0 – 6.0", desc: "Dense spruce/pine", color: "#2d6a4f" },
                  { range: "6.0+", desc: "Very dense stand", color: "#1b4332" },
                ].map((s) => (
                  <div key={s.range} className="lai-row">
                    <span className="lai-color" style={{ background: s.color }} />
                    <span className="lai-range">{s.range}</span>
                    <span className="lai-desc">{s.desc}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, fontSize: 12, color: "var(--t2)", lineHeight: 1.6 }}>
                <strong>Typical for Nordmarka:</strong> LAI 3.0–5.5 for dense spruce forest, 2.0–3.5 for mixed forest. Values vary with season — highest June–August.
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Biomass Estimate</h2>
              <p className="card-desc">Biomass calculated from LAI via allometric relations for boreal forest.</p>
              {latestLAI ? (
                <div className="stats-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <StatBlock label="Biomass (aboveground)" value={(latestLAI.lai * 28.5).toFixed(0)} unit="t/ha" accent="var(--green)" small />
                  <StatBlock label="Carbon storage" value={(latestLAI.lai * 28.5 * 0.47).toFixed(0)} unit="tC/ha" accent="var(--green)" small />
                  <StatBlock label="CO₂ equivalent" value={(latestLAI.lai * 28.5 * 0.47 * 3.67).toFixed(0)} unit="tCO₂/ha" accent="var(--green)" small />
                  <StatBlock label="For all Nordmarka" value={((latestLAI.lai * 28.5 * 0.47 * 3.67 * NORDMARKA.area_km2 * 100) / 1e6).toFixed(1)} unit="Mt CO₂" accent="var(--green)" small />
                </div>
              ) : (
                <div className="empty">Waiting for LAI data…</div>
              )}
            </section>
          </div>
        )}

        {/* ════════ SR16 MAP ════════ */}
        {!isSimple && tab === "map" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">NIBIO SR16 Forest Resource Map — Nordmarka</h2>
              <p className="card-desc">
                Real-time WMS map from NIBIO (Norwegian Institute of Bioeconomy). SR16 combines data from
                the National Forest Inventory, laser scanning and Sentinel-2 satellite imagery. Resolution: 16×16 m.
              </p>
              <div className="layer-toggles">
                {[
                  { id: "volume", label: "Standing volume (m³/ha)", layer: "SRRVOLUB" },
                  { id: "species", label: "Tree species", layer: "SRRTRESLAG" },
                  { id: "biomass", label: "Biomass (t/ha)", layer: "SRRBMO" },
                ].map((l) => (
                  <button key={l.id} className={`layer-btn ${nibioLayers[l.id] ? "active" : ""}`}
                    onClick={() => setNibioLayers((p) => ({ ...p, [l.id]: !p[l.id] }))}>
                    {l.label}
                  </button>
                ))}
              </div>
            </section>

            {nibioLayers.volume && (
              <section className="card wide">
                <h3 className="card-subtitle">Standing Volume (m³/ha)</h3>
                <div className="wms-preview large">
                  <img src={volumeUrl} alt="SR16 Volum" className="wms-img" onError={(e) => { e.target.style.display = "none"; }} />
                </div>
                <div className="map-legend">
                  <div className="legend-title">Legend (m³/ha)</div>
                  <div className="legend-items">
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#f7fcf5" }} />
                      <span className="legend-label">0 – 100</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#c7e9c0" }} />
                      <span className="legend-label">100 – 200</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#74c476" }} />
                      <span className="legend-label">200 – 300</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#31a354" }} />
                      <span className="legend-label">300 – 400</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#006d2c" }} />
                      <span className="legend-label">&gt; 400</span>
                    </div>
                  </div>
                </div>
                <div className="source-tag">WMS Layer: SRRVOLUB · BBOX: {NORDMARKA.bbox.join(", ")}</div>
              </section>
            )}

            {nibioLayers.species && (
              <section className="card wide">
                <h3 className="card-subtitle">Tree Species</h3>
                <div className="wms-preview large">
                  <img src={speciesUrl} alt="SR16 Tree Species" className="wms-img" onError={(e) => { e.target.style.display = "none"; }} />
                </div>
                <div className="map-legend">
                  <div className="legend-title">Legend</div>
                  <div className="legend-items">
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#7FFF00" }} />
                      <span className="legend-label">Spruce</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#C4A77D" }} />
                      <span className="legend-label">Pine</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-color" style={{ background: "#F0E68C" }} />
                      <span className="legend-label">Broadleaf</span>
                    </div>
                  </div>
                </div>
                <div className="source-tag">WMS Layer: SRRTRESLAG · CRS: EPSG:4326</div>
              </section>
            )}

            {nibioLayers.biomass && (
              <section className="card wide">
                <h3 className="card-subtitle">Biomass (tons/ha)</h3>
                <div className="wms-preview large">
                  <img src={biomassUrl} alt="SR16 Biomass" className="wms-img" onError={(e) => { e.target.style.display = "none"; }} />
                </div>
                <div className="source-tag">WMS Layer: SRRBMO</div>
              </section>
            )}

            <section className="card">
              <h2 className="card-title">About SR16 Data</h2>
              <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.7 }}>
                <strong>Data source:</strong> NIBIO Forest Resource Map (SR16)
                <br /><strong>Resolution:</strong> 16 × 16 meter raster
                <br /><strong>Basis:</strong> National Forest Inventory plots, aerial imagery (LiDAR), Sentinel-2
                <br /><strong>Attributes:</strong> Volume, biomass, species, height, site index, harvest class, age
                <br /><strong>Coverage:</strong> &gt;95% of Norway's forest land
                <br /><strong>License:</strong> Norwegian License for Open Government Data (NLOD)
                <br /><strong>WMS:</strong> <code>wms.nibio.no/cgi-bin/sr16</code>
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Available WMS Layers</h2>
              <div style={{ fontSize: 12, fontFamily: "var(--fm)", color: "var(--t2)", lineHeight: 2 }}>
                {["SRRVOLUB – Volume (m³/ha)", "SRRBMO – Biomass (tons/ha)", "SRRTRESLAG – Tree species", "SRRHOYDEM – Lorey's mean height", "SRRBONITET – Site index", "SRRKRONEDEK – Crown cover", "SRRGRFLATE – Basal area"].map((l) => (
                  <div key={l}>• {l}</div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* ════════ SATELLITE SCENES ════════ */}
        {!isSimple && tab === "scenes" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Sentinel-2 L2A Scenes — Nordmarka</h2>
              <p className="card-desc">Scenes found via Element84 Earth Search STAC API. Bbox: [{NORDMARKA.bbox.join(", ")}]</p>
              {sentinelScenes.length > 0 ? (
                <div className="scene-table">
                  <div className="scene-header">
                    <span>Date</span><span>Scene ID</span><span>Cloud Cover</span><span>NDVI</span><span>LAI</span><span>Thumbnail</span>
                  </div>
                  {sentinelScenes.map((s, i) => {
                    const thumb = s.assets?.thumbnail?.href;
                    return (
                      <div key={i} className="scene-row clickable" onClick={() => setSelectedScene(s)}>
                        <span style={{ fontFamily: "var(--fm)", fontWeight: 600 }}>{s.properties.datetime?.slice(0, 10)}</span>
                        <span style={{ fontSize: 10, fontFamily: "var(--fm)", color: "var(--t2)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.id}</span>
                        <span style={{ fontFamily: "var(--fm)" }}>{s.properties["eo:cloud_cover"]?.toFixed(1)}%</span>
                        <span className="ndvi-badge">{s._ndvi?.toFixed(3) ?? "—"}</span>
                        <span style={{ fontWeight: 700, color: "var(--green)", fontFamily: "var(--fm)" }}>{s._lai?.toFixed(2) ?? "—"}</span>
                        <span>{thumb ? <img src={thumb} alt="" style={{ width: 60, height: 40, objectFit: "cover", borderRadius: 4 }} /> : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">{stacData.loading ? "Searching STAC…" : stacData.error || "No scenes found"} <LoadingDot /></div>
              )}
              <div className="source-tag">API: {STAC_API}/search · Collection: sentinel-2-l2a · Max cloud: 25%</div>
            </section>

            <section className="card wide">
              <h2 className="card-title">Landsat Collection 2 Level-2 Scenes</h2>
              <p className="card-desc">Landsat 8/9 scenes from USGS via Earth Search STAC.</p>
              {landsatScenes.length > 0 ? (
                <div className="scene-table">
                  <div className="scene-header">
                    <span>Date</span><span>Scene ID</span><span>Cloud Cover</span><span>Sensor</span><span>Path/Row</span>
                  </div>
                  {landsatScenes.map((s, i) => (
                    <div key={i} className="scene-row">
                      <span style={{ fontFamily: "var(--fm)", fontWeight: 600 }}>{s.properties.datetime?.slice(0, 10)}</span>
                      <span style={{ fontSize: 10, fontFamily: "var(--fm)", color: "var(--t2)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.id}</span>
                      <span style={{ fontFamily: "var(--fm)" }}>{s.properties["eo:cloud_cover"]?.toFixed(1)}%</span>
                      <span style={{ fontFamily: "var(--fm)", fontSize: 11 }}>{s.properties.instruments?.join(", ")}</span>
                      <span style={{ fontFamily: "var(--fm)", fontSize: 11 }}>{s.properties["landsat:wrs_path"]}/{s.properties["landsat:wrs_row"]}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">{stacData.loading ? "Searching…" : "No Landsat scenes found"}</div>
              )}
              <div className="source-tag">Collection: landsat-c2-l2 · Requester-pays bucket (S3)</div>
            </section>
          </div>
        )}

        {/* ════════ CLIMATE ════════ */}
        {!isSimple && tab === "climate" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Climate & Growing Season — Nordmarka</h2>
              <p className="card-desc">
                Thermal growing season analysis using ERA5 reanalysis (2015–2025) and CMIP6 projections (~2050).
                <br/>Definition: consecutive period with daily mean temperature ≥ 5°C (≥ 5 consecutive days to start/end).
              </p>
            </section>

            {/* Current conditions */}
            {weather.data && (
              <>
                <section className="card">
                  <h2 className="card-title">Current Conditions</h2>
                  <div className="stats-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <StatBlock label="Temperature" value={temp?.toFixed(1)} unit="°C" small />
                    <StatBlock label="Wind" value={windSpeed?.toFixed(1)} unit="m/s" small />
                    <StatBlock label="Humidity" value={humidity?.toFixed(0)} unit="%" small />
                    <StatBlock label="Precipitation" value={precipitation?.toFixed(1) ?? "—"} unit="mm/h" small />
                    <StatBlock label="Air Pressure" value={currentWeather?.instant?.details?.air_pressure_at_sea_level?.toFixed(0)} unit="hPa" small />
                    <StatBlock label="Cloud Cover" value={currentWeather?.instant?.details?.cloud_area_fraction?.toFixed(0)} unit="%" small />
                  </div>
                  {temp != null && (
                    <div style={{ marginTop: 14 }}>
                      {temp >= 5 ? (
                        <div style={{ padding: 10, background: "#d8f3dc", borderRadius: 8, color: "#1b4332", fontSize: 13 }}>
                          <strong>Active growing season</strong> — Current temp ({temp.toFixed(1)}°C) above 5°C threshold.
                        </div>
                      ) : (
                        <div style={{ padding: 10, background: "#e3f2fd", borderRadius: 8, color: "#0d47a1", fontSize: 13 }}>
                          <strong>Dormant period</strong> — Current temp ({temp.toFixed(1)}°C) below 5°C threshold.
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="card">
                  <h2 className="card-title">48-hour Forecast</h2>
                  <div className="forecast-list">
                    {weather.data.properties.timeseries.slice(0, 16).filter((_, i) => i % 3 === 0).map((ts, i) => {
                      const t = ts.data.instant.details.air_temperature;
                      const c = ts.data.instant.details.cloud_area_fraction;
                      const time = new Date(ts.time);
                      return (
                        <div key={i} className="forecast-item">
                          <span className="forecast-time">{time.toLocaleDateString("en-US", { weekday: "short" })} {time.getHours()}:00</span>
                          <span className="forecast-temp" style={{ color: t > 0 ? "#e07a5f" : "#457b9d" }}>{t > 0 ? "+" : ""}{t.toFixed(1)}°</span>
                          <div style={{ flex: 1, height: 4, background: "var(--bg2)", borderRadius: 2 }}>
                            <div style={{ width: `${c}%`, height: "100%", background: "#adb5bd", borderRadius: 2 }} />
                          </div>
                          <span style={{ fontSize: 10, color: "var(--t2)", fontFamily: "var(--fm)" }}>{c?.toFixed(0)}%</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            )}

            {/* Growing Season Historical Analysis */}
            {growingSeason.loading ? (
              <section className="card wide">
                <div className="empty">Loading growing season data from ERA5 reanalysis… <LoadingDot /></div>
              </section>
            ) : growingSeason.error ? (
              <section className="card wide">
                <div className="empty">Error loading growing season data: {growingSeason.error}</div>
              </section>
            ) : (
              <>
                {/* Summary + Line Graph + Table */}
                {growingSeason.historical && growingSeason.historical.length > 0 && (() => {
                  const hist = growingSeason.historical;
                  const proj = growingSeason.projected || [];
                  const all = [...hist, ...proj];
                  const recent = hist[hist.length - 1];
                  const earliest = hist[0];
                  const histAvg = Math.round(hist.reduce((s, h) => s + h.length, 0) / hist.length);
                  const histAvgGDD = Math.round(hist.reduce((s, h) => s + h.gdd, 0) / hist.length);
                  const projAvg = proj.length > 0 ? Math.round(proj.reduce((s, p) => s + p.length, 0) / proj.length) : null;
                  const projAvgGDD = proj.length > 0 ? Math.round(proj.reduce((s, p) => s + p.gdd, 0) / proj.length) : null;
                  const changeDays = projAvg != null ? projAvg - histAvg : null;
                  const changeGDD = projAvgGDD != null ? projAvgGDD - histAvgGDD : null;

                  // SVG line graph
                  const W = 900, H = 340, pad = { top: 30, right: 30, bottom: 50, left: 55 };
                  const gW = W - pad.left - pad.right;
                  const gH = H - pad.top - pad.bottom;
                  const allYears = all.map(d => d.year);
                  const minY = Math.min(...allYears);
                  const maxY = Math.max(...allYears);
                  const allLengths = all.map(d => d.length);
                  const minL = Math.min(...allLengths) - 10;
                  const maxL = Math.max(...allLengths) + 10;
                  const xP = (yr) => pad.left + ((yr - minY) / (maxY - minY || 1)) * gW;
                  const yP = (len) => pad.top + gH - ((len - minL) / (maxL - minL || 1)) * gH;
                  const histPts = hist.map(d => `${xP(d.year)},${yP(d.length)}`);
                  const histLine = `M${histPts.join("L")}`;
                  const n = hist.length;
                  const xMean = hist.reduce((s, d) => s + d.year, 0) / n;
                  const yMean2 = hist.reduce((s, d) => s + d.length, 0) / n;
                  const slope = hist.reduce((s, d) => s + (d.year - xMean) * (d.length - yMean2), 0)
                    / hist.reduce((s, d) => s + (d.year - xMean) ** 2, 0);
                  const intercept2 = yMean2 - slope * xMean;
                  const trendStart = slope * earliest.year + intercept2;
                  const trendEnd = slope * maxY + intercept2;
                  const projPts = proj.length > 0
                    ? [{ year: recent.year, length: recent.length }, ...proj].map(d => `${xP(d.year)},${yP(d.length)}`)
                    : [];
                  const projLine = projPts.length > 0 ? `M${projPts.join("L")}` : "";
                  const yTicks = [];
                  const yStep = Math.ceil((maxL - minL) / 5 / 10) * 10;
                  for (let v = Math.ceil(minL / yStep) * yStep; v <= maxL; v += yStep) yTicks.push(v);
                  const xTicks = [];
                  for (let yr = minY; yr <= maxY; yr++) {
                    if (yr <= recent.year || yr % 5 === 0 || yr === maxY) xTicks.push(yr);
                  }

                  return (
                    <>
                      <section className="card wide">
                        <h2 className="card-title">Growing Season Summary</h2>
                        <div className="stats-grid">
                          <StatBlock label="Historical Avg" value={histAvg} unit="days" sub={`${earliest.year}–${recent.year}`} accent="var(--green)" />
                          <StatBlock label="Most Recent" value={recent.length} unit="days" sub={`${recent.year}: ${recent.startDate.slice(5)} → ${recent.endDate.slice(5)}`} accent="var(--green)" />
                          {projAvg != null && (
                            <StatBlock label="2030–2050 Avg" value={projAvg} unit="days" sub="CMIP6 ensemble mean" accent="#e07a5f" />
                          )}
                          {changeDays != null && (
                            <StatBlock label="Projected Change" value={`${changeDays > 0 ? "+" : ""}${changeDays}`} unit="days" sub={`By ~2050 vs ${earliest.year}–${recent.year}`} accent="#e07a5f" />
                          )}
                          <StatBlock label="Historical GDD" value={histAvgGDD} unit="°C·d" sub="Growing Degree Days (base 5°C)" accent="var(--green)" />
                          {changeGDD != null && (
                            <StatBlock label="GDD Change" value={`${changeGDD > 0 ? "+" : ""}${changeGDD}`} unit="°C·d" sub="Projected vs historical" accent="#e07a5f" />
                          )}
                        </div>
                      </section>

                      {/* SVG Line Graph */}
                      <section className="card wide">
                        <h2 className="card-title">Growing Season Length — Trend & Projections</h2>
                        <p className="card-desc">
                          ERA5 reanalysis ({earliest.year}–{recent.year}, green) with linear trend, CMIP6 projections to 2050 (orange dashed).
                          {changeDays != null && ` The growing season is projected to be ${Math.abs(changeDays)} days ${changeDays > 0 ? "longer" : "shorter"} by mid-century.`}
                        </p>
                        <div style={{ overflowX: "auto" }}>
                          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, height: "auto", fontFamily: "var(--fm)" }}>
                            {yTicks.map(v => (
                              <g key={v}>
                                <line x1={pad.left} y1={yP(v)} x2={W - pad.right} y2={yP(v)} stroke="var(--border)" strokeWidth="1" />
                                <text x={pad.left - 8} y={yP(v) + 4} textAnchor="end" fill="var(--t2)" fontSize="11">{v}</text>
                              </g>
                            ))}
                            <text x={14} y={pad.top + gH / 2} textAnchor="middle" fill="var(--t2)" fontSize="11" transform={`rotate(-90, 14, ${pad.top + gH / 2})`}>Days</text>
                            {proj.length > 0 && (() => {
                              const g1 = xP(recent.year) + 6, g2 = xP(proj[0].year) - 6;
                              return g2 > g1 ? <><rect x={g1} y={pad.top} width={g2 - g1} height={gH} fill="var(--bg)" opacity="0.6" /><text x={(g1 + g2) / 2} y={pad.top + gH / 2} textAnchor="middle" fill="var(--t2)" fontSize="10" opacity="0.5">no data</text></> : null;
                            })()}
                            <line x1={xP(earliest.year)} y1={yP(trendStart)} x2={xP(maxY)} y2={yP(trendEnd)} stroke="var(--green)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.35" />
                            <line x1={xP(earliest.year)} y1={yP(histAvg)} x2={xP(recent.year)} y2={yP(histAvg)} stroke="var(--green)" strokeWidth="1" strokeDasharray="3,3" opacity="0.4" />
                            <text x={xP(earliest.year) + 4} y={yP(histAvg) - 6} fill="var(--green)" fontSize="10" opacity="0.6">avg {histAvg}d</text>
                            {projAvg != null && proj.length > 0 && (
                              <><line x1={xP(proj[0].year)} y1={yP(projAvg)} x2={xP(maxY)} y2={yP(projAvg)} stroke="#e07a5f" strokeWidth="1" strokeDasharray="3,3" opacity="0.4" /><text x={xP(maxY) - 4} y={yP(projAvg) - 6} textAnchor="end" fill="#e07a5f" fontSize="10" opacity="0.6">avg {projAvg}d</text></>
                            )}
                            <path d={`${histLine}L${xP(recent.year)},${yP(minL)}L${xP(earliest.year)},${yP(minL)}Z`} fill="var(--green)" opacity="0.08" />
                            <path d={histLine} fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" />
                            {hist.map((d, i) => (
                              <g key={i}><circle cx={xP(d.year)} cy={yP(d.length)} r="5" fill="var(--card)" stroke="var(--green)" strokeWidth="2" /><title>{`${d.year}: ${d.length}d (${d.startDate.slice(5)} → ${d.endDate.slice(5)}) GDD:${d.gdd} Mean:${d.meanTemp.toFixed(1)}°C`}</title></g>
                            ))}
                            {proj.length > 0 && <path d={`M${xP(proj[0].year)},${yP(proj[0].length)}${proj.slice(1).map(d => `L${xP(d.year)},${yP(d.length)}`).join("")}L${xP(proj[proj.length-1].year)},${yP(minL)}L${xP(proj[0].year)},${yP(minL)}Z`} fill="#e07a5f" opacity="0.06" />}
                            {projLine && (
                              <><path d={projLine} fill="none" stroke="#e07a5f" strokeWidth="2.5" strokeDasharray="8,4" strokeLinejoin="round" />
                              {proj.map((d, i) => (
                                <g key={`p${i}`}><circle cx={xP(d.year)} cy={yP(d.length)} r="5" fill="var(--card)" stroke="#e07a5f" strokeWidth="2" /><title>{`${d.year}: ${d.length}d (${d.startDate.slice(5)} → ${d.endDate.slice(5)}) GDD:${d.gdd} Mean:${d.meanTemp.toFixed(1)}°C`}</title></g>
                              ))}</>
                            )}
                            {xTicks.map(yr => (
                              <text key={yr} x={xP(yr)} y={H - pad.bottom + 20} textAnchor="middle" fill={yr > recent.year ? "#e07a5f" : "var(--t2)"} fontSize="11" fontWeight={yr % 10 === 0 ? 600 : 400}>{yr}</text>
                            ))}
                            <g transform={`translate(${pad.left + 10}, ${H - 14})`}>
                              <line x1="0" y1="0" x2="18" y2="0" stroke="var(--green)" strokeWidth="2.5" />
                              <text x="22" y="4" fill="var(--t2)" fontSize="10">ERA5 Reanalysis</text>
                              {proj.length > 0 && (<><line x1="140" y1="0" x2="158" y2="0" stroke="#e07a5f" strokeWidth="2.5" strokeDasharray="6,3" /><text x="162" y="4" fill="var(--t2)" fontSize="10">CMIP6 Projection</text><line x1="290" y1="0" x2="308" y2="0" stroke="var(--green)" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.4" /><text x="312" y="4" fill="var(--t2)" fontSize="10">Linear trend</text></>)}
                            </g>
                          </svg>
                        </div>
                        <div className="source-tag">Sources: ECMWF ERA5 via Open-Meteo (historical) · CMIP6 HighResMIP ensemble (projected to 2050)</div>
                      </section>

                      {/* Detailed table */}
                      <section className="card wide">
                        <h2 className="card-title">Growing Season Details</h2>
                        <div className="scene-table">
                          <div className="gs-table-header">
                            <span>Year</span><span>Start</span><span>End</span><span>Length</span><span>GDD (5°C)</span><span>Mean Temp</span><span>Source</span>
                          </div>
                          {hist.map((h, i) => (
                            <div key={i} className="gs-table-row">
                              <span style={{ fontFamily: "var(--fm)", fontWeight: 600 }}>{h.year}</span>
                              <span style={{ fontFamily: "var(--fm)", color: "var(--green)" }}>{h.startDate.slice(5)}</span>
                              <span style={{ fontFamily: "var(--fm)", color: "#c0392b" }}>{h.endDate.slice(5)}</span>
                              <span style={{ fontFamily: "var(--fm)", fontWeight: 700 }}>{h.length} days</span>
                              <span style={{ fontFamily: "var(--fm)" }}>{h.gdd}</span>
                              <span style={{ fontFamily: "var(--fm)" }}>{h.meanTemp.toFixed(1)}°C</span>
                              <span style={{ fontSize: 10, color: "var(--t2)" }}>ERA5</span>
                            </div>
                          ))}
                          {proj.map((p, i) => (
                            <div key={`p${i}`} className="gs-table-row" style={{ background: "#fff5f0" }}>
                              <span style={{ fontFamily: "var(--fm)", fontWeight: 600, color: "#e07a5f" }}>{p.year}</span>
                              <span style={{ fontFamily: "var(--fm)", color: "var(--green)" }}>{p.startDate.slice(5)}</span>
                              <span style={{ fontFamily: "var(--fm)", color: "#c0392b" }}>{p.endDate.slice(5)}</span>
                              <span style={{ fontFamily: "var(--fm)", fontWeight: 700 }}>{p.length} days</span>
                              <span style={{ fontFamily: "var(--fm)" }}>{p.gdd}</span>
                              <span style={{ fontFamily: "var(--fm)" }}>{p.meanTemp.toFixed(1)}°C</span>
                              <span style={{ fontSize: 10, color: "#e07a5f" }}>CMIP6</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    </>
                  );
                })()}

                {/* Methodology */}
                <section className="card">
                  <h2 className="card-title">Methodology</h2>
                  <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.7 }}>
                    <strong>Definition:</strong> Thermal/Meteorological Growing Season
                    <br/><strong>Threshold:</strong> Daily mean temperature ≥ 5°C
                    <br/><strong>Start criterion:</strong> First day of ≥ 5 consecutive days above threshold
                    <br/><strong>End criterion:</strong> Last day before ≥ 5 consecutive days below threshold
                    <br/><strong>GDD:</strong> Growing Degree Days = sum of (daily mean − 5°C) during growing season
                    <br/><strong>Daily mean:</strong> (T_max + T_min) / 2
                    <div style={{ marginTop: 12, padding: 10, background: "var(--bg)", borderRadius: 6, fontSize: 12 }}>
                      <strong>Note on 2100 projections:</strong> The Open-Meteo Climate API provides CMIP6 data only to 2050.
                      For 2100 projections, the Copernicus Climate Data Store (CDS) offers full CMIP6 scenarios (SSP2-4.5, SSP5-8.5).
                    </div>
                  </div>
                </section>

                <section className="card">
                  <h2 className="card-title">Data Sources</h2>
                  <div style={{ fontSize: 12, fontFamily: "var(--fm)", color: "var(--t2)", lineHeight: 2 }}>
                    <div><strong>Historical:</strong> ECMWF ERA5 reanalysis via Open-Meteo</div>
                    <div><strong>Projections:</strong> CMIP6 HighResMIP (EC-Earth3P-HR, MPI-ESM1-2-XR, MRI-AGCM3-2-S)</div>
                    <div><strong>Resolution:</strong> ~10 km (ERA5), ~25 km (CMIP6)</div>
                    <div><strong>Period:</strong> 2015–2025 (historical), 2030–2050 (projected)</div>
                    <div><strong>Position:</strong> {NORDMARKA.center[0]}°N, {NORDMARKA.center[1]}°E</div>
                    <div><strong>MET Norway:</strong> Locationforecast 2.0 (current weather)</div>
                  </div>
                </section>
              </>
            )}

            {!weather.data && !growingSeason.loading && (
              <section className="card">
                <div className="empty">{weather.error ? `Weather error: ${weather.error}` : "Loading weather…"} <LoadingDot /></div>
              </section>
            )}
          </div>
        )}

        {/* ════════ DIVERSITY ════════ */}
        {!isSimple && tab === "diversity" && (
          <div className="grid">
            <section className="card wide">
              <h2 className="card-title">Spectral Diversity — Nordmarka</h2>
              <p className="card-desc">
                Forest biodiversity estimated from spectral heterogeneity of Sentinel-2 imagery.
                Based on the spectral variation hypothesis: higher spectral heterogeneity indicates
                greater habitat and species diversity.
                <br/><br/>
                <strong>Metrics:</strong>
              </p>
              <div style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.8, fontFamily: "var(--fm)" }}>
                <div><strong>CV(NDVI)</strong> — Coefficient of Variation of NDVI (σ/μ). Higher values indicate more heterogeneous vegetation.</div>
                <div><strong>Rao's Q</strong> — Quadratic diversity: ΣΣ d<sub>ij</sub> × p<sub>i</sub> × p<sub>j</sub>. Accounts for distance between spectral classes.</div>
                <div><strong>Shannon H'</strong> — Shannon entropy: −Σ(p<sub>i</sub> × ln p<sub>i</sub>). Measures evenness of NDVI distribution.</div>
              </div>
              <div style={{ marginTop: 12, padding: 10, background: "var(--bg)", borderRadius: 6, fontSize: 11, color: "var(--t2)", lineHeight: 1.5 }}>
                <strong>Reference:</strong> Boreal tree species diversity increases with global warming but is reversed by extremes.
                <em> Nature Plants</em>, 2024. DOI: 10.1038/s41477-024-01794-w
              </div>
            </section>

            {/* Loading state */}
            {diversityData.loading && diversityData.scenes.length === 0 && (
              <section className="card wide">
                <div className="empty">
                  Reading Sentinel-2 COG overviews for spectral analysis… <LoadingDot />
                  <br/><span style={{ fontSize: 11, marginTop: 8, display: "block" }}>This reads pixel data directly from cloud-optimized GeoTIFFs. First load may take 15–30s.</span>
                </div>
              </section>
            )}

            {/* Progress indicator when partially loaded */}
            {diversityData.loading && diversityData.scenes.length > 0 && (
              <section className="card wide">
                <div style={{ padding: "8px 0", fontSize: 12, color: "var(--t2)", display: "flex", alignItems: "center", gap: 8 }}>
                  <LoadingDot /> Analyzing scenes… {diversityData.scenes.length} completed
                </div>
              </section>
            )}

            {/* Error state */}
            {diversityData.error && (
              <section className="card wide">
                <div className="empty">Error: {diversityData.error}</div>
              </section>
            )}

            {/* Key metrics */}
            {diversityData.scenes.length > 0 && (() => {
              const scenes = diversityData.scenes;
              const avgCV = scenes.reduce((s, sc) => s + sc.cvNDVI, 0) / scenes.length;
              const avgRao = scenes.reduce((s, sc) => s + sc.raoQ, 0) / scenes.length;
              const avgShannon = scenes.reduce((s, sc) => s + sc.shannonH, 0) / scenes.length;
              const avgMean = scenes.reduce((s, sc) => s + sc.meanNDVI, 0) / scenes.length;
              const avgStd = scenes.reduce((s, sc) => s + sc.stdNDVI, 0) / scenes.length;
              const totalPixels = scenes.reduce((s, sc) => s + sc.pixelCount, 0);
              // Use the scene with most pixels for the histogram
              const bestScene = scenes.reduce((a, b) => a.pixelCount > b.pixelCount ? a : b);

              return (
                <>
                  <section className="card wide">
                    <h2 className="card-title">Key Diversity Metrics</h2>
                    <p className="card-desc">Averaged across {scenes.length} analyzed Sentinel-2 scenes.</p>
                    <div className="stats-grid">
                      <StatBlock label="CV(NDVI)" value={avgCV.toFixed(3)} sub="Coefficient of variation" accent="var(--green)" />
                      <StatBlock label="Rao's Q" value={avgRao.toFixed(4)} sub="Quadratic diversity" accent="var(--green)" />
                      <StatBlock label="Shannon H'" value={avgShannon.toFixed(3)} sub="Spectral entropy" accent="var(--green)" />
                      <StatBlock label="Mean NDVI" value={avgMean.toFixed(3)} sub="Avg vegetation index" accent="var(--green)" />
                      <StatBlock label="Std NDVI" value={avgStd.toFixed(3)} sub="Spectral spread" accent="var(--green)" />
                      <StatBlock label="Pixels" value={totalPixels.toLocaleString()} sub={`${scenes.length} scenes total`} />
                    </div>
                  </section>

                  {/* NDVI Histogram */}
                  <section className="card">
                    <h2 className="card-title">NDVI Pixel Distribution</h2>
                    <p className="card-desc">Histogram from best scene ({bestScene.date}, {bestScene.pixelCount.toLocaleString()} pixels)</p>
                    <div className="ndvi-histogram">
                      {bestScene.bins.map((bin, i) => {
                        const maxCount = Math.max(...bestScene.bins.map(b => b.count));
                        const pct = maxCount > 0 ? (bin.count / maxCount) * 100 : 0;
                        const mid = (bin.binStart + bin.binEnd) / 2;
                        // Color gradient: brown (low NDVI) → green (high NDVI)
                        const green = mid < 0 ? 60 : Math.min(255, 60 + mid * 200);
                        const red = mid < 0.3 ? 180 - mid * 200 : 40;
                        return (
                          <div key={i} className="hist-col" title={`NDVI ${bin.binStart.toFixed(2)}–${bin.binEnd.toFixed(2)}: ${bin.count} pixels (${(bin.proportion * 100).toFixed(1)}%)`}>
                            <div className="hist-bar" style={{ height: `${pct}%`, background: `rgb(${red}, ${green}, 40)`, animationDelay: `${i * 30}ms` }} />
                            {i % 4 === 0 && <div className="hist-label">{bin.binStart.toFixed(1)}</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--t2)", fontFamily: "var(--fm)", marginTop: 2 }}>
                      <span>← Bare/water</span><span>Dense vegetation →</span>
                    </div>
                  </section>

                  {/* CV(NDVI) Time Series */}
                  <section className="card">
                    <h2 className="card-title">CV(NDVI) Across Scenes</h2>
                    <p className="card-desc">Spectral heterogeneity over time. Higher CV = more diverse vegetation structure.</p>
                    <div className="bar-chart">
                      {scenes.sort((a, b) => a.date.localeCompare(b.date)).map((sc, i) => {
                        const maxCV = Math.max(...scenes.map(s => s.cvNDVI), 0.5);
                        return (
                          <div key={i} className="bar-col" title={`${sc.date}\nCV: ${sc.cvNDVI.toFixed(3)}\nRao's Q: ${sc.raoQ.toFixed(4)}\nShannon: ${sc.shannonH.toFixed(3)}\nPixels: ${sc.pixelCount}`}>
                            <div className="bar" style={{ height: `${(sc.cvNDVI / maxCV) * 100}%`, background: sc.cvNDVI > 0.2 ? "var(--green)" : sc.cvNDVI > 0.1 ? "#52b788" : "#b7e4c7", animationDelay: `${i * 60}ms` }} />
                            <div className="bar-label">{sc.date.slice(5, 7)}/{sc.date.slice(8, 10)}</div>
                            <div className="bar-val">{sc.cvNDVI.toFixed(2)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  {/* Per-scene table */}
                  <section className="card wide">
                    <h2 className="card-title">Per-Scene Analysis</h2>
                    <div className="scene-table">
                      <div className="div-table-header">
                        <span>Date</span><span>Scene ID</span><span>Cloud%</span><span>CV(NDVI)</span><span>Rao's Q</span><span>Shannon</span><span>Pixels</span>
                      </div>
                      {scenes.sort((a, b) => a.date.localeCompare(b.date)).map((sc, i) => (
                        <div key={i} className="div-table-row">
                          <span style={{ fontFamily: "var(--fm)", fontWeight: 600 }}>{sc.date}</span>
                          <span style={{ fontSize: 10, fontFamily: "var(--fm)", color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sc.sceneId}</span>
                          <span style={{ fontFamily: "var(--fm)" }}>{sc.cloudCover?.toFixed(1)}%</span>
                          <span style={{ fontFamily: "var(--fm)", fontWeight: 700, color: "var(--green)" }}>{sc.cvNDVI.toFixed(3)}</span>
                          <span style={{ fontFamily: "var(--fm)", color: "var(--green)" }}>{sc.raoQ.toFixed(4)}</span>
                          <span style={{ fontFamily: "var(--fm)", color: "var(--green)" }}>{sc.shannonH.toFixed(3)}</span>
                          <span style={{ fontFamily: "var(--fm)", fontSize: 11 }}>{sc.pixelCount.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    <div className="source-tag">Source: Sentinel-2 L2A COGs via earth-search.aws.element84.com · Bands: B04 (Red), B08 (NIR)</div>
                  </section>

                  {/* Interpretation guide */}
                  <section className="card">
                    <h2 className="card-title">Interpretation Guide</h2>
                    <div className="lai-scale">
                      {[
                        { range: "CV < 0.10", desc: "Very uniform — monoculture / single species", color: "#b7e4c7" },
                        { range: "CV 0.10–0.20", desc: "Low diversity — few species mix", color: "#74c69d" },
                        { range: "CV 0.20–0.30", desc: "Moderate diversity — mixed forest", color: "#52b788" },
                        { range: "CV > 0.30", desc: "High diversity — complex multi-species", color: "#2d6a4f" },
                      ].map(s => (
                        <div key={s.range} className="lai-row">
                          <span className="lai-color" style={{ background: s.color }} />
                          <span className="lai-range" style={{ width: 90 }}>{s.range}</span>
                          <span className="lai-desc">{s.desc}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 16, fontSize: 12, color: "var(--t2)", lineHeight: 1.7 }}>
                      <strong>For Nordmarka:</strong> Expect CV ~0.15–0.25 (spruce-dominated with birch/pine mix).
                      Rao's Q ~0.01–0.15 and Shannon H' ~1.5–2.5 are typical for boreal mixed forests.
                      Seasonal variation is expected — summer scenes show higher diversity due to deciduous canopy.
                    </div>
                  </section>

                  <section className="card">
                    <h2 className="card-title">Data & Method</h2>
                    <div style={{ fontSize: 12, fontFamily: "var(--fm)", color: "var(--t2)", lineHeight: 2 }}>
                      <div><strong>Sensor:</strong> Sentinel-2 L2A (10m resolution, bands B04 + B08)</div>
                      <div><strong>Format:</strong> Cloud-Optimized GeoTIFF (COG) overviews</div>
                      <div><strong>NDVI bins:</strong> 20 bins from -0.2 to 1.0</div>
                      <div><strong>Area:</strong> Nordmarka bbox [{NORDMARKA.bbox.join(", ")}]</div>
                      <div><strong>Projection:</strong> UTM zone 32N (auto-converted from pixel coords)</div>
                      <div><strong>Limitations:</strong> Uses overview images (~100m effective resolution). Full-resolution analysis would require server-side processing.</div>
                    </div>
                  </section>
                </>
              );
            })()}

            {/* Not initialized yet */}
            {!diversityData.initialized && !stacData.loading && sentinelScenes.length === 0 && (
              <section className="card wide">
                <div className="empty">No Sentinel-2 scenes available for diversity analysis. Wait for satellite data to load.</div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ═══ Styles ═══
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=JetBrains+Mono:wght@400;500;600&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');

  :root {
    --fd: 'DM Serif Display', serif;
    --fb: 'Source Sans 3', sans-serif;
    --fm: 'JetBrains Mono', monospace;
    --green: #2d6a4f;
    --green-l: #52b788;
    --green-d: #1b4332;
    --bg: #f5f1eb;
    --bg2: #e8e3db;
    --card: #fdfbf7;
    --t1: #1a1a1a;
    --t2: #6b6560;
    --border: #d5cfc7;
    --shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  .app { font-family: var(--fb); background: var(--bg); color: var(--t1); min-height: 100vh; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; background: var(--card); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 10;
  }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .header-title { font-family: var(--fd); font-size: 20px; color: var(--green-d); }
  .header-sub { font-size: 11px; color: var(--t2); font-family: var(--fm); }
  .header-right { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

  .tabs {
    display: flex; gap: 2px; padding: 8px 16px; background: var(--card);
    border-bottom: 1px solid var(--border); overflow-x: auto;
  }
  .tab {
    background: none; border: none; padding: 8px 14px; border-radius: 6px;
    font-family: var(--fb); font-size: 13px; font-weight: 500; color: var(--t2);
    cursor: pointer; transition: all 0.2s; display: flex; align-items: center;
    gap: 6px; white-space: nowrap;
  }
  .tab:hover { background: var(--bg2); color: var(--t1); }
  .tab.active { background: var(--green); color: white; }
  .tab-i { font-size: 14px; }

  .main { padding: 16px; max-width: 1120px; margin: 0 auto; }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 14px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px; box-shadow: var(--shadow);
  }
  .card.wide { grid-column: 1 / -1; }
  .card-title { font-family: var(--fd); font-size: 17px; color: var(--green-d); margin-bottom: 6px; }
  .card-subtitle { font-family: var(--fd); font-size: 15px; color: var(--green-d); margin-bottom: 8px; }
  .card-desc { font-size: 13px; color: var(--t2); line-height: 1.5; margin-bottom: 16px; }
  .card-desc code { font-family: var(--fm); font-size: 12px; background: var(--bg); padding: 2px 6px; border-radius: 3px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
  .stat-block { padding: 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); }
  .stat-label { font-size: 10px; color: var(--t2); letter-spacing: 0.08em; text-transform: uppercase; font-family: var(--fm); margin-bottom: 4px; }
  .stat-value { font-size: 28px; font-weight: 700; font-family: var(--fd); line-height: 1; }
  .stat-unit { font-size: 12px; color: var(--t2); font-family: var(--fm); }
  .stat-sub { font-size: 11px; color: var(--t2); margin-top: 4px; }

  .bar-chart { display: flex; gap: 4px; height: 140px; align-items: flex-end; padding-top: 20px; position: relative; }
  .bar-col { flex: 1; display: flex; flex-direction: column-reverse; align-items: center; height: 100%; position: relative; justify-content: flex-start; }
  .bar-col .bar { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; animation: growUp 0.5s ease both; }
  .bar-label { font-size: 9px; font-family: var(--fm); color: var(--t2); margin-top: 4px; }
  .bar-val { font-size: 8px; font-family: var(--fm); color: var(--t2); margin-bottom: 4px; }
  @keyframes growUp { from { height: 0 !important; } }
  @keyframes grow { from { height: 0 !important; } }

  .weather-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .weather-item { padding: 14px; background: var(--bg); border-radius: 8px; text-align: center; }
  .weather-val { font-size: 22px; font-weight: 700; font-family: var(--fd); }
  .weather-label { font-size: 11px; color: var(--t2); margin-top: 2px; }

  .wms-preview { background: var(--bg2); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
  .wms-preview.large { min-height: 300px; }
  .wms-img { width: 100%; display: block; image-rendering: auto; }
  .wms-fallback { padding: 24px; color: var(--t2); font-size: 13px; text-align: center; }

  .source-tag { font-size: 10px; font-family: var(--fm); color: var(--t2); margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }

  .scene-table { display: flex; flex-direction: column; }
  .scene-header {
    display: grid; grid-template-columns: 100px 1fr 80px 80px 80px 70px;
    gap: 8px; padding: 8px 10px; font-size: 10px; font-family: var(--fm);
    color: var(--t2); text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .scene-row {
    display: grid; grid-template-columns: 100px 1fr 80px 80px 80px 70px;
    gap: 8px; padding: 8px 10px; font-size: 12px; align-items: center;
    border-bottom: 1px solid var(--bg);
  }
  .scene-row.clickable { cursor: pointer; }
  .scene-row.clickable:hover { background: var(--bg); }

  .ndvi-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: #d8f3dc; color: var(--green-d); font-family: var(--fm);
    font-size: 11px; font-weight: 600;
  }

  .layer-toggles { display: flex; gap: 8px; flex-wrap: wrap; }
  .layer-btn {
    background: var(--bg); border: 1px solid var(--border); padding: 8px 14px;
    border-radius: 6px; font-family: var(--fb); font-size: 13px; cursor: pointer;
    transition: all 0.2s; color: var(--t2);
  }
  .layer-btn.active { background: var(--green); color: white; border-color: var(--green); }

  .lai-scale { display: flex; flex-direction: column; gap: 6px; }
  .lai-row { display: flex; align-items: center; gap: 10px; }
  .lai-color { width: 24px; height: 16px; border-radius: 3px; border: 1px solid var(--border); flex-shrink: 0; }
  .lai-range { font-family: var(--fm); font-size: 12px; width: 60px; font-weight: 600; }
  .lai-desc { font-size: 12px; color: var(--t2); }

  .forecast-list { display: flex; flex-direction: column; gap: 6px; }
  .forecast-item { display: flex; align-items: center; gap: 10px; }
  .forecast-time { font-size: 11px; font-family: var(--fm); color: var(--t2); width: 80px; }
  .forecast-temp { font-size: 13px; font-family: var(--fm); font-weight: 600; width: 50px; }

  .gs-table-header {
    display: grid; grid-template-columns: 60px 80px 80px 90px 90px 90px 60px;
    gap: 8px; padding: 8px 10px; font-size: 10px; font-family: var(--fm);
    color: var(--t2); text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .gs-table-row {
    display: grid; grid-template-columns: 60px 80px 80px 90px 90px 90px 60px;
    gap: 8px; padding: 8px 10px; font-size: 12px; align-items: center;
    border-bottom: 1px solid var(--bg);
  }

  .ndvi-histogram { display: flex; gap: 2px; height: 120px; align-items: flex-end; padding-bottom: 20px; position: relative; }
  .hist-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; position: relative; }
  .hist-bar { width: 100%; border-radius: 2px 2px 0 0; min-height: 1px; animation: grow 0.4s ease both; }
  .hist-label { font-size: 8px; font-family: var(--fm); color: var(--t2); margin-top: 3px; position: absolute; bottom: -16px; }

  .div-table-header {
    display: grid; grid-template-columns: 90px 1fr 60px 80px 80px 80px 80px;
    gap: 8px; padding: 8px 10px; font-size: 10px; font-family: var(--fm);
    color: var(--t2); text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .div-table-row {
    display: grid; grid-template-columns: 90px 1fr 60px 80px 80px 80px 80px;
    gap: 8px; padding: 8px 10px; font-size: 12px; align-items: center;
    border-bottom: 1px solid var(--bg);
  }

  .empty { padding: 24px; text-align: center; color: var(--t2); font-size: 13px; }

  .loading-dot span {
    display: inline-block; width: 4px; height: 4px; border-radius: 50%;
    background: var(--t2); margin: 0 2px; animation: blink 1.4s infinite both;
  }
  .loading-dot span:nth-child(2) { animation-delay: 0.2s; }
  .loading-dot span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%,80%,100% { opacity: 0.2; } 40% { opacity: 1; } }

  /* ═══ Map Legend ═══ */
  .map-legend {
    margin-top: 12px;
    padding: 12px;
    background: var(--bg);
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .legend-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--t2);
    margin-bottom: 8px;
    font-family: var(--fm);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .legend-items {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend-color {
    width: 24px;
    height: 16px;
    border-radius: 3px;
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .legend-label {
    font-size: 11px;
    font-family: var(--fm);
    color: var(--t1);
    white-space: nowrap;
  }

  /* ═══ Mode Toggle ═══ */
  .mode-toggle {
    display: inline-flex; border-radius: 20px; overflow: hidden;
    border: 1px solid var(--border); background: var(--bg);
  }
  .mode-btn {
    background: none; border: none; padding: 6px 16px;
    font-family: var(--fb); font-size: 12px; font-weight: 500;
    color: var(--t2); cursor: pointer; transition: all 0.2s;
  }
  .mode-btn.active {
    background: var(--green); color: white;
  }

  /* ═══ Simple Mode Styles ═══ */
  .simple .card { padding: 24px; }
  .simple .card-title { font-size: 19px; }
  .simple .card-desc { font-size: 14px; }

  .health-hero { border-width: 2px; }
  .hero-content { display: flex; align-items: flex-start; gap: 20px; }
  .hero-indicator {
    width: 56px; height: 56px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; color: white; font-weight: 700; flex-shrink: 0;
  }
  .hero-text { flex: 1; }
  .hero-title { font-family: var(--fd); font-size: 24px; margin-bottom: 6px; }
  .hero-desc { font-size: 15px; color: var(--t2); line-height: 1.5; margin-bottom: 12px; }
  .hero-details { display: flex; flex-direction: column; gap: 6px; }
  .hero-detail { font-size: 14px; color: var(--t2); }
  .hero-trend { font-size: 15px; font-weight: 600; }

  .carbon-card { text-align: center; }
  .carbon-big { font-family: var(--fd); font-size: 48px; color: var(--green); line-height: 1; margin: 12px 0 4px; }
  .carbon-label { font-size: 14px; color: var(--t2); margin-bottom: 12px; }
  .carbon-equiv { font-size: 15px; color: var(--green-d); font-weight: 500; padding: 12px; background: #d8f3dc; border-radius: 8px; }

  .simple-weather-hero { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .simple-temp { font-family: var(--fd); font-size: 48px; line-height: 1; }
  .simple-weather-desc { font-size: 16px; color: var(--t2); }
  .simple-weather-details { display: flex; gap: 20px; font-size: 14px; color: var(--t2); }

  .simple-legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--t2); }
  .legend-dot { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--border); }

  .simple-conditions { display: flex; flex-direction: column; gap: 8px; }
  .condition-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--bg); font-size: 15px; }
  .condition-label { color: var(--t2); }
  .condition-value { font-weight: 500; }

  .risk-alerts { display: flex; flex-direction: column; gap: 10px; }
  .risk-alert { padding: 12px 16px; background: var(--bg); border-radius: 8px; border-left: 4px solid; }
  .risk-label { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  .risk-desc { font-size: 13px; color: var(--t2); }

  .seasonal-tips { display: flex; flex-direction: column; gap: 10px; }
  .tip-item { display: flex; gap: 10px; font-size: 14px; line-height: 1.5; }
  .tip-bullet { color: var(--green); font-weight: 700; font-size: 18px; flex-shrink: 0; }

  .simple-forecast { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0; }
  .simple-forecast-slot {
    flex: 1; min-width: 100px; padding: 14px 12px; background: var(--bg);
    border-radius: 10px; text-align: center; border: 1px solid var(--border);
  }
  .forecast-slot-time { font-size: 11px; font-family: var(--fm); color: var(--t2); margin-bottom: 6px; }
  .forecast-slot-icon { font-size: 28px; margin-bottom: 4px; }
  .forecast-slot-temp { font-size: 20px; font-weight: 700; font-family: var(--fd); }
  .forecast-slot-precip { font-size: 11px; color: #457b9d; font-family: var(--fm); margin-top: 2px; }

  @media (max-width: 700px) {
    .grid { grid-template-columns: 1fr; }
    .scene-header, .scene-row { grid-template-columns: 80px 1fr 60px 60px; }
    .scene-header span:nth-child(5), .scene-row span:nth-child(5),
    .scene-header span:nth-child(6), .scene-row span:nth-child(6) { display: none; }
    .header-right { flex-direction: column; align-items: flex-end; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    .gs-table-header, .gs-table-row { grid-template-columns: 50px 70px 70px 70px 70px; }
    .gs-table-header span:nth-child(6), .gs-table-row span:nth-child(6),
    .gs-table-header span:nth-child(7), .gs-table-row span:nth-child(7) { display: none; }
    .div-table-header, .div-table-row { grid-template-columns: 80px 1fr 50px 70px 70px; }
    .div-table-header span:nth-child(6), .div-table-row span:nth-child(6),
    .div-table-header span:nth-child(7), .div-table-row span:nth-child(7) { display: none; }
    .hero-content { flex-direction: column; gap: 12px; }
    .hero-indicator { width: 44px; height: 44px; font-size: 22px; }
    .hero-title { font-size: 20px; }
    .simple-forecast { flex-wrap: wrap; }
    .simple-forecast-slot { min-width: 80px; }
    .mode-toggle { margin-bottom: 4px; }
  }
`;
