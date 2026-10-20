import { qs, setStatus } from "./dom.js";
import { yearBounds, validateRecord } from "./records.js";
export function init(ctx) {
  const form = qs("#collection-search");
  if (!form) return;
  const input = qs("#collection-query"),
    source = qs("#collection-source"),
    status = qs("#collection-status"),
    more = qs("#collection-more"),
    submit = qs("#collection-submit");
  let page = 1,
    lastQuery = "",
    lastSource = "",
    request = 0;
  let controller;
  const cancelSearch = () => {
    request++;
    controller?.abort();
    submit.disabled = false;
    more.disabled = false;
    more.hidden = true;
    setStatus(status, '');
  };
  const syncSource = () => {
    const area = source.value === "usgs";
    input.disabled = area;
    input.required = !area;
    input.placeholder = area ? "USGS searches the area currently shown on the map" : "e.g. Cairo or Boston";
    submit.textContent = area ? "Search this map area" : "Search collection";
  };
  source.addEventListener("change", () => { cancelSearch(); syncSource(); });
  input.addEventListener("input", cancelSearch);
  syncSource();
  async function search(nextPage = 1) {
    const provider = source.value;
    const q = provider === "usgs" ? "map area" : input.value.trim();
    if (q.length < 2) {
      setStatus(status, "Enter at least two characters.");
      return;
    }
    const ticket = ++request;
    controller?.abort();
    controller = new AbortController();
    submit.disabled = true;
    more.disabled = true;
    setStatus(status, "Searching the original collection…");
    try {
      const url = new URL("/api/catalogue", location.origin);
      url.searchParams.set("source", provider);
      url.searchParams.set("q", q);
      url.searchParams.set("page", String(nextPage));
      if (provider === "usgs") {
        const b = ctx.map?.currentBounds?.();
        if (b && b.west < b.east)
          url.searchParams.set(
            "bbox",
            [
              Math.max(-180, b.west),
              Math.max(-90, b.south),
              Math.min(180, b.east),
              Math.min(90, b.north),
            ].join(","),
          );
      }
      const response = await fetch(url, { signal: controller.signal });
      const data = await response.json();
      if (ticket !== request) return;
      if (!response.ok)
        throw new Error(
          data.note ?? "The collection is temporarily unavailable.",
        );
      const valid = (data.records ?? []).filter(
        (record) => validateRecord(record).length === 0,
      );
      let added = 0;
      for (const record of valid) {
        const existing = ctx.data.recordIndex.get(record.id);
        const matched = existing ?? record;
        if (provider !== 'usgs') matched.catalogueQueries = [...new Set([...(matched.catalogueQueries ?? []), q])];
        if (!existing) {
          ctx.data.records.push(record);
          ctx.data.recordIndex.set(record.id, record);
          added++;
        }
      }
      ctx.data.years = yearBounds(ctx.data.records);
      ctx.bus.emit("records:loaded", {
        records: ctx.data.records,
        sources: ctx.data.sources,
        overlays: ctx.data.overlays,
      });
      const filters = qs("#text-filter");
      const filterQuery = provider === "usgs" ? "" : q;
      if (filters) filters.value = filterQuery;
      ctx.store.update({
        q: filterQuery,
        provider,
        type: "",
        collection: "",
        at: "",
        viewport: "",
        from: ctx.data.years.min,
        to: ctx.data.years.max,
      });
      setStatus(
        status,
        `${added} ${added === 1 ? "map" : "maps"} added from this page. ${data.withheld ?? 0} results withheld because reuse permission or required source metadata was not established. ${data.note ?? ""}`,
      );
      page = nextPage;
      lastQuery = q;
      lastSource = provider;
      more.hidden = !data.nextPage;
    } catch (error) {
      if (ticket === request) setStatus(status, error.message, "warn");
    } finally {
      if (ticket === request) {
        submit.disabled = false;
        more.disabled = false;
      }
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    search();
  });
  more.addEventListener("click", () => {
    input.value = lastQuery;
    source.value = lastSource;
    syncSource();
    search(page + 1);
  });
  return { search };
}
