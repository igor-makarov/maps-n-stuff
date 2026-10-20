/** Native GeoTIFF display and optional reusable IIIF alignment lookup. */
import { debounce, el, qs, setStatus } from "./dom.js";

export function init(ctx) {
  const map = qs("#map");
  if (!map || !ctx.map) return;
  const canvas = el("canvas", {
    class: "map-raster",
    "aria-hidden": "true",
    hidden: true,
  });
  const nativeLayer = map.querySelector(".map-layer--overlay");
  nativeLayer?.after(canvas);
  const status = el("p", {
    id: "alignment-status",
    class: "zh-hint",
    role: "status",
    "aria-live": "polite",
  });
  qs("#map-visible-count")?.before(status);
  let active = null;
  let generation = 0;
  let renderer;
  const message = (text, kind = "info") => setStatus(status, text, kind);
  const clear = () => {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
  };
  const draw = debounce(async () => {
    const ticket = ++generation,
      layer = active;
    clear();
    if (!layer) return;
    const view = ctx.map.getView();
    message(`Loading georeferenced raster: ${layer.title}.`);
    try {
      renderer ??= import("/vendor/cog.js");
      const { renderCog } = await renderer;
      if (ticket !== generation) return;
      const result = await renderCog(canvas, layer, view, {
        cancelled: () => ticket !== generation,
      });
      if (ticket !== generation) return;
      message(
        result?.outside
          ? "This view is outside the selected raster. Use “Fit selected overlay” to find it."
          : `${layer.title} · ${layer.attribution}. Provider-supplied georeferencing; check historical alignment against landmarks.`,
      );
    } catch (error) {
      if (ticket !== generation) return;
      clear();
      message(
        `Raster overlay unavailable: ${error.message} The original scan and download remain available.`,
        "warn",
      );
    }
  }, 180);
  ctx.bus.on("overlay:changed", ({ layer }) => {
    generation++;
    active = layer?.kind === "cog" ? layer : null;
    canvas.hidden = !active;
    clear();
    if (active) {
      canvas.style.opacity = String(
        Number(qs("#overlay-opacity")?.value ?? 85) / 100,
      );
      draw();
    } else message(layer?.quality ?? "");
  });
  ctx.bus.on("map:rendered", () => {
    if (active) {
      generation++;
      clear();
      draw();
    }
  });
  ctx.bus.on("overlay:opacity", ({ opacity }) => {
    canvas.style.opacity = String(opacity);
  });
  const fit = (layer) => {
    if (layer?.extent) ctx.bus.emit("view:fit", { bounds: layer.extent });
  };
  const fitButton = el(
    "button",
    {
      class: "zh-button zh-button--ghost zh-button--small",
      type: "button",
      id: "overlay-fit",
      onclick: () =>
        fit(
          active ??
            ctx.data.overlays.find(
              (value) => value.id === ctx.store.getState().overlay,
            ),
        ),
    },
    ["Fit selected overlay"],
  );
  qs("#overlay-note")?.after(fitButton);
  document.addEventListener("click", async (event) => {
    const show = event.target.closest("[data-show-raster]");
    if (show) {
      const record = ctx.data.recordIndex.get(show.dataset.showRaster);
      let layer = ctx.data.overlays.find(
        (value) => value.recordId === record?.id,
      );
      // A bundled native raster need not be pre-listed in overlays.json:
      // build the layer from the record's own provider-supplied georeference.
      if (
        !layer &&
        record?.georeference?.kind === "cog" &&
        record.georeference.url
      ) {
        layer = {
          id: `cog-${record.id.replace(/[^a-z0-9-]+/gi, "-")}`,
          kind: "cog",
          providerId: record.providerId,
          title: record.title,
          recordId: record.id,
          url: record.georeference.url,
          extent: record.extent ?? null,
          attribution: record.institution,
          license: record.rights,
          historical: true,
          timeValues: [],
          ...(record.depictedYearStart
            ? { mapYear: record.depictedYearStart }
            : {}),
        };
        ctx.data.overlays.push(layer);
      }
      if (layer) {
        ctx.store.update({ overlay: layer.id, otime: "" });
        // The map and this module listen to the bus, not to the URL store;
        // without this event the “Overlay this georeferenced map” button
        // changed the URL but left the canvas hidden until a page reload.
        ctx.bus.emit("overlay:changed", { layer, time: "current" });
        fit(layer);
      }
      return;
    }
    const lookup = event.target.closest("[data-find-alignment]");
    if (!lookup) return;
    const record = ctx.data.recordIndex.get(lookup.dataset.findAlignment);
    if (!record) return;
    const hint = lookup.parentElement.querySelector("[data-alignment-result]");
    lookup.disabled = true;
    if (hint) hint.textContent = "Checking reusable alignment data…";
    try {
      const response = await fetch(
        `/api/georeference?record=${encodeURIComponent(record.id)}`,
      );
      if (!response.ok)
        throw new Error("The alignment service is temporarily unavailable.");
      const result = await response.json();
      if (hint)
        hint.textContent =
          result.note ??
          "No alignment is available yet; the scan remains browseable.";
      for (const layer of result.layers ?? []) {
        if (!ctx.data.overlays.some((value) => value.id === layer.id))
          ctx.data.overlays.push(layer);
        ctx.bus.emit("overlay:added", { layer });
      }
      if (result.layers?.length) {
        const layer = result.layers[0];
        ctx.store.update({ overlay: layer.id, otime: "" });
        fit(layer);
      }
    } catch (error) {
      if (hint)
        hint.textContent = `${error.message} You can still view the scan or align it in Allmaps.`;
    } finally {
      lookup.disabled = false;
    }
  });
  const selected = ctx.data.overlays.find(
    (value) => value.id === ctx.store.getState().overlay,
  );
  if (selected?.kind === "cog")
    ctx.bus.emit("overlay:changed", { layer: selected });
  return {
    get active() {
      return active;
    },
    canvas,
    redraw: draw,
  };
}
