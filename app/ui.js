// Chrome around the 3D scene. Talks to scene.js only through
// window.__astrolabe and window.__astrolabeFocusOn/__astrolabeZoomToward.

function waitForAstrolabe() {
  return new Promise((resolve) => {
    (function check() {
      if (window.__astrolabe) resolve(window.__astrolabe);
      else setTimeout(check, 50);
    })();
  });
}

async function boot() {
  const app = await waitForAstrolabe();

  if (app.dataStatus !== "real:full") {
    const messages = {
      placeholder: "Placeholder data — the real star catalog pipeline hasn't been wired in yet.",
      "real:tier_c_only": "Real Gaia data (331k neighborhood stars) — bright-star and structure layers still loading in.",
    };
    const warn = document.createElement("div");
    warn.className = "panel";
    warn.style.cssText = "position:fixed;top:64px;left:14px;padding:8px 14px;font-size:11px;color:#ffb37a;border-color:#ffb37a;";
    warn.textContent = messages[app.dataStatus] || ("Data status: " + app.dataStatus);
    document.getElementById("hud").appendChild(warn);
  }

  // ---- navigator ----
  const navSelect = document.getElementById("nav-select");
  navSelect.innerHTML = '<option value="">Jump to…</option>';
  for (const b of app.landmarkBodies) {
    const opt = document.createElement("option");
    opt.value = b.def.id;
    opt.textContent = b.def.name;
    navSelect.appendChild(opt);
  }
  navSelect.addEventListener("change", () => {
    const id = navSelect.value;
    if (!id) return;
    const b = app.landmarkBodies.find((x) => x.def.id === id);
    if (b) window.__astrolabeFocusOn(b.def);
    navSelect.value = "";
  });

  // ---- layer toggles ----
  // "Measured" controls both real measured layers: raw stars (measuredLayer)
  // and structure tracers (structureLayer) -- both Measured data (see the
  // comment in scene.js's buildTierAStructure). "Model" controls only the
  // spiral-arm curves (modelArmLines) -- the inferred Reid+2019 fit, kept
  // independent so hiding Measured never silently hides the Model layer.
  document.getElementById("toggle-measured").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("active", on);
    if (app.measuredLayer) app.measuredLayer.visible = on;
    if (app.structureLayer) app.structureLayer.visible = on;
  });
  const modelBtn = document.getElementById("toggle-model");
  if (app.modelArmLines) {
    modelBtn.disabled = false;
    modelBtn.title = "";
    modelBtn.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      btn.classList.toggle("active", on);
      app.modelArmLines.visible = on;
    });
  }

  // ---- zoom presets ----
  const PRESETS = {
    neighbourhood: 50, bubble: 500, arm: 5000, galaxy: 60000, edgeon: 20000,
  };
  document.querySelectorAll(".zoom-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alt = PRESETS[btn.dataset.preset];
      if (alt) window.__astrolabeZoomToward(1, 0); // no-op placeholder hook point
      // Directly drive the slider, which scene.js listens to.
      const slider = document.getElementById("zoom-slider");
      const s = Math.log(alt / 1) / Math.log(60000 / 1);
      slider.value = String(Math.round(s * 1000));
      slider.dispatchEvent(new Event("input"));
      slider.dispatchEvent(new Event("change"));
    });
  });

  // ---- sources & method ----
  const sourcesBtn = document.getElementById("sources-btn");
  const sourcesPanel = document.getElementById("sources-panel");
  let sourcesLoaded = false;
  sourcesBtn.addEventListener("click", async () => {
    if (sourcesPanel.hidden && !sourcesLoaded) {
      try {
        const [srcA, srcStars] = await Promise.all([
          fetch("data/sources.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
          fetch("data/sources_stars.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        const sources = [...srcA, ...srcStars];
        const rows = sources.map((s) =>
          `<div class="source-row"><a href="${s.url}" target="_blank" rel="noopener">${s.url}</a><span class="source-meta">${s.layer || "measured"} · fetched ${(s.fetched_utc || "").slice(0, 10)} · ${(s.supplies || []).join(", ")}</span></div>`
        ).join("");
        sourcesPanel.innerHTML = `<h3>Sources &amp; Method</h3>
          <div class="layer-legend">
            <span class="layer-legend-item"><span class="layer-swatch measured"></span>Measured — real catalogued objects</span>
            <span class="layer-legend-item"><span class="layer-swatch model"></span>Model — inferred shape (spiral arms, disk)</span>
          </div>
          <p>Every object traces to a fetched, hashed source below. Scene distances are real and linear (parsecs); only the zoom control and star brightness use a disclosed non-linear (log) scale — space itself is never distorted.</p>
          <div class="source-list">${rows || "<p>No sources loaded yet — data pipeline in progress.</p>"}</div>`;
        sourcesLoaded = sources.length > 0;
      } catch (e) {
        sourcesPanel.innerHTML = `<h3>Sources &amp; Method</h3><p>Could not load sources.</p>`;
      }
    }
    sourcesPanel.hidden = !sourcesPanel.hidden;
  });

  // ---- help ----
  const helpBtn = document.getElementById("help-btn");
  const helpPanel = document.getElementById("help-panel");
  helpBtn.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });
  document.getElementById("help-close").addEventListener("click", () => { helpPanel.hidden = true; });
}

boot();
